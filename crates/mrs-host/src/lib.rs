//! MR Studio local host: serves the surfaces and the active site, runs the session
//! hub and fronts the compute engine. The desktop shell embeds it; `mrstudio dev`
//! runs it on its own. Contract in `docs/contracts/session.md`.

mod basemap;
pub mod bridge;
mod calibration;
pub mod data;
pub mod diagnostics;
mod engine_bridge;
pub mod health;
mod hub;
pub mod layers;
mod model;
pub mod relay;
pub mod services;
pub mod sources;
mod transit;
mod wms;
mod ws;

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use anyhow::Context as _;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use mrs_engine::Backend;
use mrs_site::history::{By, Change};
use mrs_site::import::{self, Options, Report, Target};
use mrs_site::osm::{self, OsmLayer};
use mrs_site::Site;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeader;

pub use calibration::Calibration;
pub use engine_bridge::EngineHandle;
pub use hub::{Hub, Role, SessionOptions};
pub use layers::{Control, ControlKind, LayerDef, Tool, ToolKind};
pub use sources::Sources;

#[derive(Debug, Clone)]
pub struct HostConfig {
    /// The site package to run.
    pub site_dir: PathBuf,
    /// Folder holding the core layer packages (`<id>/layer.json`).
    pub layers_dir: PathBuf,
    /// Built surfaces to serve. Without it only the API, site files and WebSocket are served.
    pub web_dir: Option<PathBuf>,
    pub bind: SocketAddr,
    pub backend: Backend,
    /// Phone limits and the address phones join at.
    pub session: SessionOptions,
    /// The app's outside services and their keys (#41). The app shares one with its Sources page.
    pub sources: Arc<Sources>,
}

pub struct AppState {
    pub hub: Hub,
    pub engine: EngineHandle,
    pub site: Site,
    /// The site's digital twin in its wire form, built from the baked scene and rebuilt
    /// when imported data changes the scene.
    pub twin: RwLock<Bytes>,
    pub calibration: Calibration,
    /// Outside services and their keys. Surfaces reach them through the host only.
    pub sources: Arc<Sources>,
    /// Windows' signs of life and recovered incidents, for running unattended (#79).
    pub health: health::Health,
    transit: transit::Cache,
    /// One import at a time.
    imports: tokio::sync::Mutex<()>,
    /// Recent OpenStreetMap answers, one per layer and place, so Import brings in what the
    /// preview (or a fetch of everything, #310) got without asking again.
    osm_cache: std::sync::Mutex<std::collections::HashMap<String, OsmFetch>>,
    /// What an OpenStreetMap fetch is doing now, in words ("Asking overpass-api.de, part 2 of 4"), for
    /// `GET /api/data/osm/status` (#424). Empty when nothing is being asked.
    osm_status: std::sync::Mutex<String>,
    /// The join page's WebRTC bridge (#275): at most one surface carries phones at a time.
    bridge: bridge::BridgeSlot,
    /// The host's own router, for answering phones that come through a relay or the bridge.
    links: std::sync::OnceLock<Router>,
    /// The site's outside compute (#278), started with the host and stopped with it.
    pub services: services::Services,
    /// The latest picture each layer's table sent for its controller (`ctx.view`, #351), by layer instance.
    views: std::sync::Mutex<std::collections::HashMap<String, LayerView>>,
}

/// A picture a layer's table sent for the controller: the Magnifier's view under its glass.
struct LayerView {
    revision: u64,
    kind: &'static str,
    bytes: Bytes,
}

/// One OpenStreetMap fetch: when, and the GeoJSON it became. Kept by layer and ground.
struct OsmFetch {
    at: std::time::Instant,
    bytes: Vec<u8>,
}

/// What a fetch is kept under: the layer and the ground it covers.
fn osm_key(layer: OsmLayer, bounds: [f64; 4]) -> String {
    format!("{layer:?} {bounds:?}")
}

/// How long a fetch is reused: long enough to look at the preview, short enough to stay fresh.
const OSM_REUSE: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// The largest file `/api/data/*` accepts.
pub const MAX_IMPORT_BYTES: usize = 256 * 1024 * 1024;

impl AppState {
    /// Packs the running table into one `.mrstable` file at `out` (#85). The package lists the
    /// outside sources its layers use, named as this computer knows them, and never their keys.
    pub fn export_table(&self, out: &std::path::Path, app: &str) -> Result<mrs_site::package::Exported, String> {
        let known = self.sources.list();
        let used = self.hub.sources_in_use();
        let needs = used["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|u| {
                let id = u["source"].as_str().unwrap_or_default().to_string();
                let connection = known.iter().find(|v| v.connection.id == id).map(|v| &v.connection);
                mrs_site::package::SourceNeed {
                    kind: connection
                        .and_then(|c| serde_json::to_value(c.kind).ok())
                        .and_then(|k| k.as_str().map(str::to_string))
                        .unwrap_or_default(),
                    name: connection.map(|c| c.name.clone()).unwrap_or_default(),
                    layers: u["layers"].as_array().into_iter().flatten().filter_map(|l| l["name"].as_str().map(str::to_string)).collect(),
                    id,
                }
            })
            .collect();
        mrs_site::package::export(&self.site.dir, out, needs, app).map_err(|e| e.to_string())
    }
}

/// The sources a table needs that are not set up on this computer, or have no key yet.
pub fn missing_sources(sources: &Sources, needs: &[mrs_site::package::SourceNeed]) -> Vec<mrs_site::package::SourceNeed> {
    let known = sources.list();
    needs.iter().filter(|n| !known.iter().any(|v| v.connection.id == n.id && v.ready)).cloned().collect()
}

impl AppState {
    /// Handles a `calibration.*` request and tells every surface what changed. The desktop
    /// shell's calibration tab uses this directly; surfaces reach it over the WebSocket.
    pub fn calibration_request(&self, method: &str, p: &Value) -> Result<Value, String> {
        let (result, event) = self.calibration.request(method, p)?;
        if let Some((name, payload)) = event {
            self.hub.emit(name, payload);
        }
        Ok(result)
    }

    /// Reads and checks a file for `target` and, with `write`, saves it into the site,
    /// re-bakes the scene, swaps it into the engine and tells every surface (`site.changed`).
    /// The report is the same either way; a blocker leaves the site untouched.
    /// Asks OpenStreetMap for one layer around the table, as a GeoJSON file `import_data` takes.
    /// The refusal is a report: no network, a busy server, or nothing mapped there.
    pub async fn fetch_osm(&self, target: &Target) -> Result<Vec<u8>, Report> {
        let layer = OsmLayer::for_target(target).map_err(|why| Report::refused(target, "osm.unavailable", why.clone(), why))?;
        let bounds = self.osm_bounds(target).await?;
        // The preview and the import ask for the same thing a minute apart: the second one reuses the first.
        let key = osm_key(layer, bounds);
        if let Some(bytes) = self.osm_cached(&key) {
            return Ok(bytes);
        }
        let answer = self.ask_overpass(&|b| osm::query(layer, b), bounds).await.map_err(|detail| data::osm_offline(target, detail))?;
        self.osm_keep(target, layer, key, &answer)
    }

    /// Asks OpenStreetMap once for several layers (#310), and keeps each layer's share for the
    /// import that follows, so bringing them in asks nothing more. Each target gets its own
    /// answer: how many features it has, or the refusal `fetch_osm` would give.
    pub async fn fetch_osm_all(&self, targets: &[Target]) -> Vec<(Target, Result<usize, Report>)> {
        let mut results: Vec<(Target, Result<usize, Report>)> = Vec::new();
        let mut wanted: Vec<(Target, OsmLayer, String)> = Vec::new();
        let mut bounds = None;
        for target in targets {
            let layer = match OsmLayer::for_target(target) {
                Ok(layer) => layer,
                Err(why) => {
                    results.push((target.clone(), Err(Report::refused(target, "osm.unavailable", why.clone(), why))));
                    continue;
                }
            };
            let b = match bounds {
                Some(b) => b,
                None => match self.osm_bounds(target).await {
                    Ok(b) => *bounds.insert(b),
                    Err(report) => {
                        results.push((target.clone(), Err(report)));
                        continue;
                    }
                },
            };
            let key = osm_key(layer, b);
            match self.osm_cached(&key) {
                Some(bytes) => {
                    let count = serde_json::from_slice::<Value>(&bytes).map_or(0, |v| osm::count(&v));
                    results.push((target.clone(), Ok(count)));
                }
                None => wanted.push((target.clone(), layer, key)),
            }
        }
        if let (false, Some(bounds)) = (wanted.is_empty(), bounds) {
            let layers: Vec<OsmLayer> = wanted.iter().map(|(_, layer, _)| *layer).collect();
            match self.ask_overpass(&|b| osm::query_all(&layers, b), bounds).await {
                Ok(answer) => {
                    for (target, layer, key) in wanted {
                        let kept = self.osm_keep(&target, layer, key, &answer);
                        let count = kept.map(|bytes| serde_json::from_slice::<Value>(&bytes).map_or(0, |v| osm::count(&v)));
                        results.push((target, count));
                    }
                }
                Err(detail) => {
                    for (target, _, _) in wanted {
                        results.push((target.clone(), Err(data::osm_offline(&target, detail.clone()))));
                    }
                }
            }
        }
        // In the order asked.
        results.sort_by_key(|(target, _)| targets.iter().position(|t| t == target));
        results
    }

    /// The table's extent plus a margin, as OpenStreetMap is asked for it.
    async fn osm_bounds(&self, target: &Target) -> Result<[f64; 4], Report> {
        let dir = self.site.dir.clone();
        tokio::task::spawn_blocking(move || Site::load(&dir).map(|site| osm::bounds(&site)))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r.map_err(|e| e.to_string()))
            .map_err(|e| Report::refused(target, "site.unreadable", e.clone(), e))
    }

    fn osm_cached(&self, key: &str) -> Option<Vec<u8>> {
        let mut cache = self.osm_cache.lock().unwrap();
        cache.retain(|_, f| f.at.elapsed() < OSM_REUSE);
        cache.get(key).map(|f| f.bytes.clone())
    }

    /// One layer's share of an Overpass answer as GeoJSON, kept for the import; empty is a refusal.
    fn osm_keep(&self, target: &Target, layer: OsmLayer, key: String, answer: &Value) -> Result<Vec<u8>, Report> {
        let bytes = data::osm_collection(target, layer, answer)?;
        self.osm_cache.lock().unwrap().insert(key, OsmFetch { at: std::time::Instant::now(), bytes: bytes.clone() });
        Ok(bytes)
    }

    /// Asks Overpass in tiles (`data::ask_overpass`), keeping what it is doing for the status endpoint.
    async fn ask_overpass(&self, query_for: &(dyn Fn([f64; 4]) -> String + Sync), bounds: [f64; 4]) -> Result<Value, String> {
        let say = |words: String| *self.osm_status.lock().unwrap() = words;
        let answer = data::ask_overpass(query_for, bounds, &say).await;
        self.osm_status.lock().unwrap().clear();
        answer
    }

    /// What an OpenStreetMap fetch is doing now, or "" (#424).
    pub fn osm_status(&self) -> String {
        self.osm_status.lock().unwrap().clone()
    }

    /// Fetches free elevation around the table as a GeoTIFF (`data::elevation_for`).
    pub async fn fetch_elevation(&self, target: &Target) -> Result<Vec<u8>, Report> {
        data::elevation_for(&self.site.dir, target).await
    }

    pub async fn import_data(&self, target: &str, filename: &str, bytes: Vec<u8>, options: Options, write: bool) -> Result<Report, String> {
        let target = Target::parse(target)?;
        let _one = self.imports.lock().await;
        let dir = self.site.dir.clone();
        let filename = filename.to_string();
        let history = self.hub.history();
        // The site as it is on disk now: earlier imports and scene edits included.
        let (updated, report) = tokio::task::spawn_blocking(move || -> Result<(Option<(Site, Option<Change>)>, Report), String> {
            let site = Site::load(&dir).map_err(|e| e.to_string())?;
            let prepared = import::inspect(&site, &target, &filename, &bytes, options);
            if !write || !prepared.report.ok {
                return Ok((None, prepared.report));
            }
            let what = import_words(&target);
            let history = history.clone();
            let mut history = history.lock().unwrap();
            let ((site, report), change) = history
                .write(By::Import, format!("Brought in {what}"), None, || import::apply(&site, prepared))
                .map_err(|e| e.to_string())?;
            drop(history);
            Ok((Some((site, change)), report))
        })
        .await
        .map_err(|e| e.to_string())??;
        let Some((site, change)) = updated else { return Ok(report) };
        if let Some(change) = &change {
            self.hub.history_changed(&change.revision, false);
        }

        let rebuilt = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let (scene, stats) = site.bake()?;
            tracing::info!("re-baked after import: {} buildings, {} trees", stats.buildings, stats.trees);
            let twin = Bytes::from(site.twin(&scene)?.encode());
            Ok((scene, twin, site.info()))
        })
        .await
        .map_err(|e| e.to_string())?;
        let (scene, twin, info) = rebuilt.map_err(|e| format!("the data was saved, but the scene could not be rebuilt: {e}"))?;
        self.engine.load_scene(scene).await?;
        *self.twin.write().unwrap() = twin;
        self.hub.site_changed(info);
        Ok(report)
    }
}

impl AppState {
    /// Renames, moves, resizes or turns the table (`Site::place`), re-bakes the scene for the
    /// ground it now covers and tells every surface (`site.changed`).
    pub async fn place_site(&self, place: mrs_site::Place) -> Result<mrs_site::SiteInfo, String> {
        let _one = self.imports.lock().await;
        let dir = self.site.dir.clone();
        let history = self.hub.history();
        let rebuilt = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let before = Site::load(&dir).map_err(|e| e.to_string())?;
            let summary = place_words(&before, &place);
            let (site, change) =
                history.lock().unwrap().write(By::Editor, summary, None, || before.place(&place)).map_err(|e| e.to_string())?;
            if let Some(change) = &change {
                tracing::info!("history: {}", change.revision.summary);
            }
            let (scene, stats) = site.bake().map_err(|e| format!("the table was moved, but its scene could not be rebuilt: {e}"))?;
            tracing::info!("re-baked after a move: {} buildings, {} trees", stats.buildings, stats.trees);
            let twin = Bytes::from(site.twin(&scene).map_err(|e| e.to_string())?.encode());
            Ok((scene, twin, site.info(), site.manifest.origin, change))
        })
        .await
        .map_err(|e| e.to_string())?;
        let (scene, twin, info, origin, change) = rebuilt?;
        if let Some(change) = &change {
            self.hub.history_changed(&change.revision, false);
        }
        self.engine.relocate(scene, origin).await?;
        *self.twin.write().unwrap() = twin;
        self.hub.site_changed(info.clone());
        Ok(info)
    }
}

/// The keys of site.json a running table takes without re-baking its ground or reloading its surfaces.
const LIVE_KEYS: [&str; 8] = ["layers", "custom", "palette", "tv", "display", "name", "timezone", "branding"];

impl AppState {
    /// `history.list`, `history.undo`, `history.redo` and `history.restore { revision }` (#72).
    /// Undo and redo walk the history; restore brings back any kept revision as a new one.
    pub async fn history_request(&self, role: Role, surface: u64, method: &str, p: &Value) -> Result<Value, String> {
        if role.from_a_phone() {
            return Err("phones cannot see the table's history".into());
        }
        if method == "history.list" {
            return Ok(self.hub.history_list());
        }
        if !role.may_compose() {
            return Err("this surface cannot change the table".into());
        }
        let rev = p["revision"].as_u64();
        if method == "history.restore" && rev.is_none() {
            return Err("missing revision".into());
        }
        let _one = self.imports.lock().await;
        let history = self.hub.history();
        let method_owned = method.to_string();
        let (change, from) = tokio::task::spawn_blocking(move || -> Result<(Change, u64), String> {
            let mut history = history.lock().unwrap();
            let from = history.head().rev;
            let change = match method_owned.as_str() {
                "history.undo" => history.undo(),
                "history.redo" => history.redo(),
                "history.restore" => history.restore(rev.unwrap_or_default(), Some(surface)),
                other => Err(format!("unknown method '{other}'")),
            }?;
            Ok((change, from))
        })
        .await
        .map_err(|e| e.to_string())??;
        if let Err(e) = self.apply_change(&change).await {
            // That version does not load as the table now is: leave site.json as it was.
            let history = self.hub.history();
            let _ = tokio::task::spawn_blocking(move || history.lock().unwrap().step_back(from)).await;
            return Err(format!("that version of the table could not be opened: {e}"));
        }
        self.hub.history_changed(&change.revision, method != "history.restore");
        Ok(self.hub.history_list())
    }

    /// Looks for a change to site.json made outside the host (the MCP server, a text editor,
    /// `git pull`), records it in the history and shows it on every surface. A file that does
    /// not load is recorded too, so it can be undone, and the table keeps what it shows.
    pub async fn check_outside(&self) {
        let Ok(_one) = self.imports.try_lock() else { return };
        let history = self.hub.history();
        let Ok(Some(change)) = tokio::task::spawn_blocking(move || history.lock().unwrap().check_outside()).await else { return };
        tracing::info!("history: {}", change.revision.summary);
        self.hub.history_changed(&change.revision, false);
        if let Err(e) = self.apply_change(&change).await {
            tracing::warn!("site.json changed outside MR Studio and does not load: {e}");
            self.hub.emit("site.problem", json!({ "message": e, "revision": change.revision.rev }));
        }
    }

    /// Makes the running table match site.json after a change the hub did not make itself.
    async fn apply_change(&self, change: &Change) -> Result<(), String> {
        let dir = self.site.dir.clone();
        let deep = change.keys.iter().any(|k| !LIVE_KEYS.contains(&k.as_str()));
        let loaded = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let site = Site::load(&dir).map_err(|e| e.to_string())?;
            let rebuilt = if deep {
                let (scene, _) = site.bake().map_err(|e| format!("the ground could not be rebuilt: {e}"))?;
                let twin = Bytes::from(site.twin(&scene).map_err(|e| e.to_string())?.encode());
                Some((scene, twin))
            } else {
                None
            };
            Ok((site, rebuilt))
        })
        .await
        .map_err(|e| e.to_string())??;
        let (site, rebuilt) = loaded;
        self.hub.reload(&site, change).map_err(|e| format!("{e:#}"))?;
        if let Some((scene, twin)) = rebuilt {
            self.engine.relocate(scene, site.manifest.origin).await?;
            *self.twin.write().unwrap() = twin;
            self.hub.site_changed(site.info());
        }
        Ok(())
    }
}

/// "the buildings", for the history's "Brought in the buildings".
fn import_words(target: &Target) -> String {
    match target {
        Target::Buildings => "the buildings".into(),
        Target::Trees => "the trees".into(),
        Target::Water => "the water".into(),
        Target::Walkways => "the walking paths".into(),
        Target::Trips => "the trips".into(),
        Target::Terrain => "the ground".into(),
        Target::Data(name) => format!("the {name} data"),
    }
}

/// What moving the table changed, in a few words.
fn place_words(site: &Site, place: &mrs_site::Place) -> String {
    let m = &site.manifest;
    let renamed = place.name.as_deref().is_some_and(|n| n.trim() != m.name);
    let moved = m.origin != place.origin;
    let resized = m.extent.width_m != place.extent.width_m || m.extent.height_m != place.extent.height_m || place.table_width_cm.is_some();
    let turned = m.extent.rotation_deg != place.extent.rotation_deg.rem_euclid(360.0);
    let mut parts = Vec::new();
    if renamed {
        parts.push("renamed");
    }
    if moved {
        parts.push("moved");
    }
    if resized {
        parts.push("resized");
    }
    if turned {
        parts.push("turned");
    }
    match parts.as_slice() {
        [] => "Changed the table's place".into(),
        [one] => format!("{} the table", capitalise(one)),
        [rest @ .., last] => format!("{} and {last} the table", capitalise(&rest.join(", "))),
    }
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or_else(String::new, |f| f.to_uppercase().collect::<String>() + c.as_str())
}

/// A running host. Dropping it does not stop the server; call `shutdown`.
pub struct RunningHost {
    pub addr: SocketAddr,
    pub state: Arc<AppState>,
    app: Router,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl RunningHost {
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(());
        let _ = self.task.await;
    }

    /// Stops serving. Open connections get `grace` to close; after that the listener is
    /// released anyway, so the port is free for the next session.
    pub async fn stop(self, grace: std::time::Duration) {
        let _ = self.shutdown.send(());
        let abort = self.task.abort_handle();
        if tokio::time::timeout(grace, self.task).await.is_err() {
            abort.abort();
        }
    }

    /// Whether the server is still serving. False after it stopped by itself, which only a
    /// failure does: the desktop app's watchdog then starts the table again (#79).
    pub fn is_serving(&self) -> bool {
        !self.task.is_finished()
    }

    /// Lets phones join through a relay (#89), besides the one from Sources and keys that
    /// `start` connects by itself. `mrstudio dev --relay` uses this.
    pub fn connect_relay(&self, link: relay::RelayLink) {
        relay::spawn(Arc::downgrade(&self.state), self.app.clone(), self.addr.port(), link);
    }

    /// Runs until the server stops.
    pub async fn wait(self) {
        let _ = self.task.await;
    }
}

/// Loads the site, bakes its scene, starts the engine and begins serving.
pub async fn start(config: HostConfig) -> anyhow::Result<RunningHost> {
    let site = Site::load(&config.site_dir).with_context(|| format!("loading site {}", config.site_dir.display()))?;
    let (scene, stats) = site.bake()?;
    tracing::info!(
        "site '{}': {}x{} cells at {} m, {} buildings, {} trees",
        site.manifest.id,
        scene.grid.width,
        scene.grid.height,
        scene.grid.cell_m,
        stats.buildings,
        stats.trees
    );
    let twin = site.twin(&scene)?;
    tracing::info!("twin: {} triangles", twin.triangle_count());
    let twin = Bytes::from(twin.encode());
    let calibration = Calibration::load(&site.dir);
    let catalog = layers::load_catalog(&site, &config.layers_dir)?;
    let (incidents, mut incident_rx) = tokio::sync::mpsc::unbounded_channel();
    let engine = EngineHandle::spawn(config.backend, scene, site.manifest.origin, incidents)?;
    let info = engine.info().await?;
    tracing::info!("engine: {:?} backend{}", info.backend, info.adapter.as_ref().map(|a| format!(", {a}")).unwrap_or_default());

    let listener = tokio::net::TcpListener::bind(config.bind).await.with_context(|| format!("binding {}", config.bind))?;
    let addr = listener.local_addr()?;
    let join_base = config
        .session
        .public_url
        .clone()
        .or_else(|| reachable_ip(addr.ip()).map(|ip| format!("http://{}", SocketAddr::new(ip, addr.port()))));
    match &join_base {
        Some(base) => tracing::info!("phones join at {base}/phone"),
        None => tracing::info!("listening on this computer only; phones cannot join"),
    }
    let hub = Hub::new(&site, catalog, addr.port(), join_base, config.session.clone())?;
    // The site's services start now and come up in the background; their incidents go to the operator log.
    let (service_incidents, mut service_incident_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let services = services::Services::start(&site, move |message| {
        tracing::warn!("{message}");
        let _ = service_incidents.send(message);
    });
    let state = Arc::new(AppState {
        services,
        hub,
        engine,
        site,
        twin: RwLock::new(twin),
        calibration,
        sources: config.sources.clone(),
        transit: Default::default(),
        imports: Default::default(),
        osm_cache: Default::default(),
        osm_status: Default::default(),
        health: Default::default(),
        bridge: Default::default(),
        views: Default::default(),
        links: Default::default(),
    });
    // An engine that recovered from a failure (#79): noted for the operator log, and the
    // surfaces open their streams again on the new engine.
    {
        let state = Arc::downgrade(&state);
        tokio::spawn(async move {
            while let Some(incident) = incident_rx.recv().await {
                let Some(state) = state.upgrade() else { break };
                state.health.note(&incident.message);
                state.hub.emit("engine.restarted", json!({ "message": incident.message, "backend": incident.backend }));
            }
        });
    }
    {
        let state = Arc::downgrade(&state);
        tokio::spawn(async move {
            while let Some(message) = service_incident_rx.recv().await {
                let Some(state) = state.upgrade() else { break };
                state.health.note(&message);
            }
        });
    }
    let app = router(state.clone(), config.web_dir.clone());
    let _ = state.links.set(app.clone());
    // Phones join through the relay when this computer has one (#89).
    if let Some(link) = config.sources.relay().await {
        relay::spawn(Arc::downgrade(&state), app.clone(), addr.port(), link);
    }
    // Watches site.json for changes made outside the host (#72). It stops when the host is gone.
    {
        let state = Arc::downgrade(&state);
        tokio::spawn(async move {
            let mut every = tokio::time::interval(std::time::Duration::from_millis(700));
            loop {
                every.tick().await;
                match state.upgrade() {
                    Some(state) => state.check_outside().await,
                    None => break,
                }
            }
        });
    }
    // Moves playing slideshows and sub-steps on. It stops when the host is gone.
    {
        let state = Arc::downgrade(&state);
        tokio::spawn(async move {
            let mut every = tokio::time::interval(std::time::Duration::from_millis(200));
            loop {
                every.tick().await;
                match state.upgrade() {
                    Some(state) => state.hub.tick(),
                    None => break,
                }
            }
        });
    }

    let app_for_relay = app.clone();
    let (shutdown, stop) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let serve = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(async {
            let _ = stop.await;
        });
        if let Err(e) = serve.await {
            tracing::error!("server stopped: {e}");
        }
    });
    Ok(RunningHost { addr, state, app: app_for_relay, shutdown, task })
}

/// The address a phone on the local network should use for a host bound to `bound`.
fn reachable_ip(bound: IpAddr) -> Option<IpAddr> {
    if bound.is_loopback() {
        return None;
    }
    if !bound.is_unspecified() {
        return Some(bound);
    }
    // Bound to every interface: use the one the system routes outward through. Connecting a
    // UDP socket sends nothing; it only makes the system pick the local address. The private
    // ranges are tried too, for a studio network with no route to the internet.
    for target in ["8.8.8.8:9", "192.168.255.254:9", "10.255.255.254:9", "172.31.255.254:9"] {
        let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else { continue };
        if socket.connect(target).is_err() {
            continue;
        }
        if let Ok(local) = socket.local_addr() {
            if !local.ip().is_loopback() && !local.ip().is_unspecified() {
                return Some(local.ip());
            }
        }
    }
    None
}

fn router(state: Arc<AppState>, web_dir: Option<PathBuf>) -> Router {
    let mut app = Router::new()
        .route("/ws", get(ws::upgrade))
        .route("/api/phones/bridge", get(bridge::upgrade))
        .route("/api/info", get(info))
        .route("/api/diagnostics", get(diagnostics_page))
        .route("/api/performance", get(performance_page))
        .route("/api/model", get(model))
        .route("/api/data/inspect", post(inspect_data))
        .route("/api/data/import", post(import_data))
        .route("/api/data/osm", post(fetch_osm_all))
        .route(
            "/api/data/osm/status",
            get(|State(state): State<Arc<AppState>>| async move { Json(json!({ "words": state.osm_status() })) }),
        )
        .route("/api/data/model", post(model::post))
        .route("/api/data/model/locate", get(model::locate))
        .route("/api/data/sounds", get(list_sounds).post(save_sound))
        .route("/api/data/media", get(list_media).post(save_media))
        .route("/api/data/field", get(data_field))
        .route("/api/media", get(list_library))
        .route("/api/site/place", post(place_site))
        .route("/api/site/thumbnail", post(save_thumbnail))
        .route("/api/layers/{id}/view", get(layer_view).put(save_layer_view))
        .route("/api/wms", get(wms_map))
        .route("/api/wms/layers", get(wms_layers))
        .route("/api/basemap/{service}/{z}/{x}/{y}", get(basemap_tile))
        .route("/api/sources", get(sources_page).post(save_source))
        .route("/api/sources/{id}", axum::routing::delete(remove_source))
        .route("/api/sources/{id}/test", post(test_source))
        .route("/api/sources/{id}/tile/{z}/{x}/{y}", get(source_tile))
        .route("/api/sources/{id}/proxy", get(source_proxy))
        .route("/api/transit/{id}/vehicles", get(transit_vehicles))
        .route("/api/services", get(services_page))
        .route("/api/services/{id}/log", get(service_log))
        .route("/api/services/{id}/kept", get(service_kept).put(keep_for_service))
        .route("/api/services/{id}/call/{*path}", axum::routing::any(call_service))
        .route("/api/services/{id}/call", axum::routing::any(call_service_root))
        .layer(DefaultBodyLimit::max(MAX_IMPORT_BYTES))
        // Site files are never kept by the browser (#125, #222). Every table is served at the
        // same address (127.0.0.1:4170/site/data/buildings.geojson), and the desktop app's
        // webview keeps its cache across tables and launches. With "no-cache" it revalidated by
        // date: a table whose file is older than the copy it had (one copied from a repository,
        // say) got "304 Not Modified" and drew another table's buildings and trees.
        .nest_service(
            "/site",
            SetResponseHeader::overriding(
                ServeDir::new(&state.site.dir),
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-store"),
            ),
        );
    app = match web_dir {
        // Every surface path (/table, /tv, /phone, /dev) is the same single-page app. Its pages
        // are checked on every load, so an updated app never runs an earlier version's page.
        Some(dir) => app.fallback_service(SetResponseHeader::if_not_present(
            ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html"))),
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-cache"),
        )),
        None => app.fallback(|| async { "MR Studio host is running. Surfaces are not built; run the web dev server or pass --web." }),
    };
    app.with_state(state)
}

/// Only this computer may use a source, and a page from another site in the same browser
/// may not change one: a request that says where it comes from must come from the host's own pages.
fn local(from: &SocketAddr, headers: &HeaderMap) -> Result<(), Box<axum::response::Response>> {
    if !from.ip().is_loopback() {
        return Err(Box::new(
            (StatusCode::FORBIDDEN, Json(json!({ "error": "sources are used from this computer only" }))).into_response(),
        ));
    }
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    match origin {
        None => Ok(()),
        Some(origin) if origin == format!("http://{host}") => Ok(()),
        Some(_) => Err(Box::new(
            (StatusCode::FORBIDDEN, Json(json!({ "error": "sources are used from MR Studio's own pages only" }))).into_response(),
        )),
    }
}

/// `GET /api/basemap/<service>/<z>/<x>/<y>`: a base map tile, kept in the site folder so the
/// table shows its map again without a connection (#37). From this computer only, since it writes to disk.
async fn basemap_tile(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    axum::extract::Path((service, z, x, y)): axum::extract::Path<(String, u32, u32, String)>,
) -> axum::response::Response {
    if !from.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "the base map is drawn on this computer only" }))).into_response();
    }
    let Ok(y) = y.split('.').next().unwrap_or("").parse::<u32>() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "no such tile" }))).into_response();
    };
    match basemap::tile(&state.site.dir, &service, z, x, y).await {
        Ok(bytes) => {
            let kind = basemap::content_type(&bytes);
            ([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, "max-age=86400")], bytes).into_response()
        }
        Err(why) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": why }))).into_response(),
    }
}

fn refused(refusal: sources::Refusal) -> axum::response::Response {
    (StatusCode::from_u16(refusal.status).unwrap_or(StatusCode::BAD_GATEWAY), Json(json!({ "error": refusal.message }))).into_response()
}

async fn wms_map(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<wms::WmsQuery>,
) -> axum::response::Response {
    if query.source.as_deref().is_some_and(|s| !s.is_empty()) {
        if let Err(no) = local(&from, &headers) {
            return *no;
        }
    }
    wms::get_map(&state.site.dir, &state.sources, query).await
}

/// `GET /api/wms/layers?url=…[&service=arcgis][&source=<id>]`: the layers a service offers, as
/// `{ layers: [{ name, title }] }` (#306). From this computer only, since it reaches out to any address.
async fn wms_layers(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<wms::LayersQuery>,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    match wms::layers(&state.sources, query).await {
        Ok(layers) => Json(json!({ "layers": layers })).into_response(),
        Err((status, error)) => (status, Json(json!({ "error": error }))).into_response(),
    }
}

/// `GET /api/sources`: the connections (never their keys) and the kinds that can be added.
async fn sources_page(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    Json(state.sources.page()).into_response()
}

/// `POST /api/sources`, a change (`sources::Change`): adds or edits one, and stores its key in the keychain.
async fn save_source(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    let change: sources::Change = match serde_json::from_slice(&body) {
        Ok(change) => change,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response(),
    };
    let sources = state.sources.clone();
    match tokio::task::spawn_blocking(move || sources.save(change)).await {
        Ok(Ok(view)) => Json(json!(view)).into_response(),
        Ok(Err(error)) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": error }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn remove_source(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    let sources = state.sources.clone();
    match tokio::task::spawn_blocking(move || sources.remove(&id)).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => (StatusCode::NOT_FOUND, Json(json!({ "error": error }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn test_source(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    match state.sources.test(&id).await {
        Ok(status) => Json(json!(status)).into_response(),
        Err(error) => (StatusCode::NOT_FOUND, Json(json!({ "error": error }))).into_response(),
    }
}

/// Passes a signed answer on: its type and body, and nothing that names the address.
async fn pass_on(state: &AppState, id: &str, url: reqwest::Url) -> axum::response::Response {
    match state.sources.fetch(id, url).await {
        Ok(answer) => {
            let kind = answer
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            match answer.bytes().await {
                Ok(body) => ([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, "max-age=300".to_string())], body).into_response(),
                Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.without_url().to_string() }))).into_response(),
            }
        }
        Err(refusal) => refused(refusal),
    }
}

/// `GET /api/sources/<id>/tile/<z>/<x>/<y>`: one map tile from a tile source, signed.
async fn source_tile(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Path((id, z, x, y)): axum::extract::Path<(String, u32, u32, String)>,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    // Map libraries ask for `…/{y}.png` or `…/{y}@2x`; the source's own address decides.
    let Ok(y) = y.split(['.', '@']).next().unwrap_or("").parse::<u32>() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "no such tile" }))).into_response();
    };
    match state.sources.tile_url(&id, z, x, y) {
        Ok(url) => pass_on(&state, &id, url).await,
        Err(refusal) => refused(refusal),
    }
}

#[derive(serde::Deserialize)]
struct ProxyQuery {
    url: String,
}

/// `GET /api/sources/<id>/proxy?url=…`: any address on the source's own server, signed.
async fn source_proxy(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<ProxyQuery>,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    match reqwest::Url::parse(&query.url) {
        Ok(url) => pass_on(&state, &id, url).await,
        Err(_) => (StatusCode::BAD_REQUEST, Json(json!({ "error": "url must be a web address" }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct TransitQuery {
    bbox: String,
}

/// `GET /api/transit/<id>/vehicles?bbox=w,s,e,n`: live vehicles from a transit source.
async fn transit_vehicles(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<TransitQuery>,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    match transit::vehicles(&state.sources, &state.transit, &id, &query.bbox).await {
        Ok(value) => ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response(),
        Err(refusal) => refused(refusal),
    }
}

async fn info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let engine = state.engine.info().await.map(|i| json!(i)).unwrap_or(Value::Null);
    Json(json!({ "site": state.hub.site(), "engine": engine, "session": state.hub.session() }))
}

#[derive(serde::Deserialize)]
struct DiagnosticsQuery {
    #[serde(default)]
    format: Option<String>,
}

/// How the running table is doing (#260): JSON, or plain text with `?format=text`.
/// How fast the table and controller windows draw, and their costliest layers (#262), for the
/// editor's slow-table warning.
async fn performance_page(State(state): State<Arc<AppState>>) -> axum::response::Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "windows": state.health.windows() }))).into_response()
}

async fn diagnostics_page(State(state): State<Arc<AppState>>, Query(query): Query<DiagnosticsQuery>) -> axum::response::Response {
    let report = diagnostics::report(&state).await;
    if query.format.as_deref() == Some("text") {
        return ([(header::CONTENT_TYPE, "text/plain; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], diagnostics::text(&report))
            .into_response();
    }
    ([(header::CACHE_CONTROL, "no-store")], Json(report)).into_response()
}

/// The digital twin mesh. Layout in `docs/contracts/model.md`.
async fn model(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-cache")], state.twin.read().unwrap().clone())
}

#[derive(serde::Deserialize)]
struct ImportQuery {
    target: String,
    #[serde(default)]
    crop: Option<String>,
    #[serde(default)]
    swap: Option<String>,
    /// `1`: the terrain has the buildings raised in it; set them back to the ground (#344).
    #[serde(default)]
    flatten: Option<String>,
    /// `EPSG:3006`, for a terrain GeoTIFF that does not say.
    #[serde(default)]
    crs: Option<String>,
    /// `osm`: fetch the data from OpenStreetMap instead of reading the body; `elevation`: free
    /// elevation for the ground.
    #[serde(default)]
    source: Option<String>,
}

fn flag(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| v == "1" || v == "true")
}

/// `POST /api/data/inspect?target=buildings`, the file as the body: what it is and where it lands. Writes nothing.
async fn inspect_data(
    state: State<Arc<AppState>>,
    from: ConnectInfo<SocketAddr>,
    query: Query<ImportQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    data_request(state, from, query, headers, body, false).await
}

/// `POST /api/data/import?target=buildings[&crop=1][&swap=1]`: the same, then saves it and rebuilds the scene.
async fn import_data(
    state: State<Arc<AppState>>,
    from: ConnectInfo<SocketAddr>,
    query: Query<ImportQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    data_request(state, from, query, headers, body, true).await
}

#[derive(serde::Deserialize)]
struct OsmAllQuery {
    /// Comma-separated import targets, such as `buildings,trees,walkways,data:roads`.
    targets: String,
}

/// `POST /api/data/osm?targets=buildings,trees,walkways,data:roads` (#310): asks OpenStreetMap
/// once for every target and keeps each answer for the `source=osm` import that follows, which
/// then asks nothing more. Writes nothing. Answers `{ datasets: [{ dataset, ok, count } | { dataset,
/// ok: false, report }] }` (`dataset` as layers know it: `roads` for `data:roads`), in the order asked.
async fn fetch_osm_all(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Query(query): Query<OsmAllQuery>,
) -> axum::response::Response {
    if !from.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "data can only be added from this computer" }))).into_response();
    }
    let mut targets = Vec::new();
    for name in query.targets.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        match Target::parse(name) {
            Ok(target) if !targets.contains(&target) => targets.push(target),
            Ok(_) => {}
            Err(error) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
        }
    }
    if targets.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "targets must name at least one dataset" }))).into_response();
    }
    let datasets: Vec<Value> = state
        .fetch_osm_all(&targets)
        .await
        .into_iter()
        .map(|(target, result)| match result {
            Ok(count) => json!({ "dataset": target.name(), "ok": true, "count": count }),
            Err(report) => json!({ "dataset": target.name(), "ok": false, "report": report }),
        })
        .collect();
    Json(json!({ "datasets": datasets })).into_response()
}

/// `POST /api/site/place`, `{ name?, origin: { lon, lat }, extent: { width_m, height_m, rotation_deg } }`:
/// renames, moves, resizes or turns the table. Answers with the site as surfaces see it.
/// Where Home finds the picture of a table: the map as it was when the table was last left
/// (#131). Kept with the app's own files in the table folder, out of exports and copies.
pub const THUMBNAIL: &str = ".mrstudio/thumbnail.jpg";

/// Stores the editor's picture of the map, sent when the table is left.
async fn save_thumbnail(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> axum::response::Response {
    if !from.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "the picture of the table is kept from this computer only" })))
            .into_response();
    }
    if body.len() > 4 * 1024 * 1024 || !body.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "expected a JPEG picture under 4 MB" }))).into_response();
    }
    let path = state.site.dir.join(THUMBNAIL);
    let written = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        std::fs::create_dir_all(path.parent().expect("in a folder"))?;
        let partial = path.with_extension("jpg.part");
        std::fs::write(&partial, &body)?;
        std::fs::rename(&partial, &path)
    })
    .await;
    match written {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

/// Largest picture a layer may send for its controller.
const MAX_VIEW_BYTES: usize = 3 * 1024 * 1024;

/// `PUT /api/layers/<id>/view`: the table sends a picture for the layer's controller (#351), a
/// JPEG or WebP. Kept in memory, the latest only. From this computer only, as the table runs here.
async fn save_layer_view(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: Bytes,
) -> axum::response::Response {
    if !from.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "a layer's view is sent from this computer only" }))).into_response();
    }
    let kind = if body.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if body.len() > 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "expected a JPEG or WebP picture" }))).into_response();
    };
    if body.len() > MAX_VIEW_BYTES || id.len() > 128 {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": "the picture is too large" }))).into_response();
    }
    let mut views = state.views.lock().expect("views lock");
    // A few layers at most; a table that keeps sending under new names cannot grow this without end.
    if !views.contains_key(&id) && views.len() >= 32 {
        views.clear();
    }
    let revision = views.get(&id).map_or(0, |v| v.revision) + 1;
    views.insert(id, LayerView { revision, kind, bytes: body });
    Json(json!({ "revision": revision })).into_response()
}

#[derive(serde::Deserialize)]
struct ViewQuery {
    /// The revision the controller already has: an answer of 204 means nothing newer.
    #[serde(default)]
    after: Option<u64>,
}

/// `GET /api/layers/<id>/view?after=N`: the latest picture the layer's table sent, with its
/// revision in `X-Revision`; 204 when there is none newer than `after`.
async fn layer_view(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<ViewQuery>,
) -> axum::response::Response {
    let views = state.views.lock().expect("views lock");
    match views.get(&id) {
        Some(view) if query.after.is_none_or(|after| view.revision > after) => (
            [
                (header::CONTENT_TYPE, view.kind.to_string()),
                (header::CACHE_CONTROL, "no-store".to_string()),
                (header::HeaderName::from_static("x-revision"), view.revision.to_string()),
            ],
            view.bytes.clone(),
        )
            .into_response(),
        _ => StatusCode::NO_CONTENT.into_response(),
    }
}

#[derive(serde::Deserialize)]
struct FieldQuery {
    /// The dataset's name in site.json `data`.
    name: String,
    /// For a folder of hourly rasters, the hour (0 to 23).
    #[serde(default)]
    hour: Option<u32>,
}

/// `GET /api/data/field?name=pet&hour=14`: a raster dataset sampled on the site grid, as a binary
/// field frame of f32 values (NaN where it has no data). 404 when a folder of hourly rasters has
/// none for that hour, so a layer can fall back to what it works out itself (#196).
async fn data_field(State(state): State<Arc<AppState>>, Query(query): Query<FieldQuery>) -> axum::response::Response {
    let dir = state.site.dir.clone();
    let FieldQuery { name, hour } = query;
    let read = tokio::task::spawn_blocking(move || {
        let site = Site::load(&dir).map_err(|e| e.to_string())?;
        mrs_site::field::read(&site, &name, hour)
    })
    .await;
    match read {
        Ok(Ok(Some(field))) => {
            ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-cache")], field.to_frame()).into_response()
        }
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, Json(json!({ "error": "no raster for that hour" }))).into_response(),
        Ok(Err(error)) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": error }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct SoundQuery {
    /// The file's own name; the saved name is made safe from it.
    name: String,
}

/// `GET /api/data/sounds`: the site's sound files (#150), as `{ sounds: ["data/sounds/x.mp3"] }`.
async fn list_sounds(State(state): State<Arc<AppState>>) -> axum::response::Response {
    let dir = state.site.dir.clone();
    match tokio::task::spawn_blocking(move || mrs_site::sound::list(&dir)).await {
        Ok(sounds) => Json(json!({ "sounds": sounds })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

/// `POST /api/data/sounds?name=Blackbird.mp3`: keeps a WAV, MP3, OGG or M4A file under
/// `data/sounds/` as it came, for points that name it in a column. Answers `{ path }`.
async fn save_sound(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Query(query): Query<SoundQuery>,
    body: Bytes,
) -> axum::response::Response {
    if !from.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "sounds are added from this computer only" }))).into_response();
    }
    let dir = state.site.dir.clone();
    match tokio::task::spawn_blocking(move || mrs_site::sound::save(&dir, &query.name, &body)).await {
        Ok(Ok(path)) => Json(json!({ "path": path })).into_response(),
        Ok(Err(error)) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": error }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

/// `GET /api/media`: everything the table has to show (#306), as `{ items: [{ kind, name?, path, bytes?, missing? }] }`:
/// its datasets, pictures, video, sounds and 3D model. Online sources are `GET /api/sources`.
async fn list_library(State(state): State<Arc<AppState>>) -> axum::response::Response {
    let dir = state.site.dir.clone();
    let listed =
        tokio::task::spawn_blocking(move || Site::load(&dir).map(|site| mrs_site::library::list(&site)).map_err(|e| e.to_string())).await;
    match listed {
        Ok(Ok(items)) => ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "items": items }))).into_response(),
        Ok(Err(error)) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": error }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

/// `GET /api/data/media`: the site's pictures and video (#197), as `{ media: ["data/media/x.png"] }`.
async fn list_media(State(state): State<Arc<AppState>>) -> axum::response::Response {
    let dir = state.site.dir.clone();
    match tokio::task::spawn_blocking(move || mrs_site::media::list(&dir)).await {
        Ok(media) => Json(json!({ "media": media })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

/// `POST /api/data/media?name=Aerial.png`: keeps a picture or video under `data/media/` as it
/// came, for a slideshow's picture and video steps. Answers `{ path }`.
async fn save_media(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Query(query): Query<SoundQuery>,
    body: Bytes,
) -> axum::response::Response {
    if !from.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "pictures and video are added from this computer only" }))).into_response();
    }
    let dir = state.site.dir.clone();
    match tokio::task::spawn_blocking(move || mrs_site::media::save(&dir, &query.name, &body)).await {
        Ok(Ok(path)) => Json(json!({ "path": path })).into_response(),
        Ok(Err(error)) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": error }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn place_site(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> axum::response::Response {
    if !from.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "the table can only be moved from this computer" }))).into_response();
    }
    let place: mrs_site::Place = match serde_json::from_slice(&body) {
        Ok(place) => place,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response(),
    };
    match state.place_site(place).await {
        Ok(info) => Json(json!({ "site": info })).into_response(),
        Err(error) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": error }))).into_response(),
    }
}

async fn data_request(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Query(query): Query<ImportQuery>,
    headers: HeaderMap,
    body: Bytes,
    write: bool,
) -> axum::response::Response {
    // The host listens on the network while presenting; only this computer may change the site.
    if !from.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "data can only be added from this computer" }))).into_response();
    }
    let mut filename = headers.get("x-filename").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let mut body = body.to_vec();
    match query.source.as_deref() {
        None | Some("") | Some("file") => {}
        Some("osm") => {
            let target = match Target::parse(&query.target) {
                Ok(target) => target,
                Err(error) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
            };
            match state.fetch_osm(&target).await {
                Ok(bytes) => (body, filename) = (bytes, "openstreetmap.geojson".into()),
                Err(report) => return (StatusCode::UNPROCESSABLE_ENTITY, Json(json!(report))).into_response(),
            }
        }
        Some("elevation") => {
            let target = match Target::parse(&query.target) {
                Ok(target) => target,
                Err(error) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
            };
            match state.fetch_elevation(&target).await {
                Ok(bytes) => (body, filename) = (bytes, "free-elevation.tif".into()),
                Err(report) => return (StatusCode::UNPROCESSABLE_ENTITY, Json(json!(report))).into_response(),
            }
        }
        Some(other) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("source must be osm or elevation, not '{other}'") })))
                .into_response()
        }
    }
    let crs = match query.crs.as_deref().map(|c| c.trim().trim_start_matches("EPSG:").trim_start_matches("epsg:").parse::<u32>()) {
        None => None,
        Some(Ok(code)) => Some(code),
        Some(Err(_)) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "crs must look like EPSG:3006" }))).into_response(),
    };
    let options = Options { crop: flag(&query.crop), swap: flag(&query.swap), crs, flatten: flag(&query.flatten) };
    let free_elevation = query.source.as_deref() == Some("elevation");
    match state.import_data(&query.target, &filename, body, options, write).await.map(|mut report| {
        if free_elevation {
            data::elevation_note(&mut report);
        }
        report
    }) {
        Ok(report) if report.ok => (StatusCode::OK, Json(json!(report))).into_response(),
        Ok(report) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!(report))).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

/// `GET /api/services`: what each of the site's services is doing (#278).
async fn services_page(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({ "services": state.services.statuses() }))
}

/// `GET /api/services/<id>/log`: the last lines the service wrote.
async fn service_log(State(state): State<Arc<AppState>>, axum::extract::Path(id): axum::extract::Path<String>) -> axum::response::Response {
    match state.services.log(&id) {
        Some(lines) => Json(json!({ "lines": lines })).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": format!("this table has no service '{id}'") }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct KeptQuery {
    key: String,
}

/// `GET /api/services/<id>/kept?key=`: a value a layer kept for when the service cannot answer.
async fn service_kept(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<KeptQuery>,
) -> axum::response::Response {
    if !state.services.knows(&id) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("this table has no service '{id}'") }))).into_response();
    }
    match tokio::fs::read(state.services.kept_file(&id, &query.key)).await {
        Ok(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "nothing kept under that key" }))).into_response(),
    }
}

/// `PUT /api/services/<id>/kept?key=`: keeps a JSON value, such as a finished job's result. From this computer only.
async fn keep_for_service(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<KeptQuery>,
    body: Bytes,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    if !state.services.knows(&id) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("this table has no service '{id}'") }))).into_response();
    }
    if serde_json::from_slice::<Value>(&body).is_err() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "keep a JSON value" }))).into_response();
    }
    let file = state.services.kept_file(&id, &query.key);
    match write_cache(&file, &body, "application/json").await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn write_cache(file: &std::path::Path, body: &[u8], kind: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let partial = file.with_extension("partial");
    tokio::fs::write(&partial, body).await?;
    tokio::fs::write(file.with_extension("type"), kind).await?;
    tokio::fs::rename(&partial, file).await
}

async fn call_service_root(
    state: State<Arc<AppState>>,
    from: ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    method: axum::http::Method,
    uri: axum::http::Uri,
    body: Bytes,
) -> axum::response::Response {
    forward_to_service(state, from, headers, id, String::new(), method, uri, body).await
}

async fn call_service(
    state: State<Arc<AppState>>,
    from: ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    axum::extract::Path((id, path)): axum::extract::Path<(String, String)>,
    method: axum::http::Method,
    uri: axum::http::Uri,
    body: Bytes,
) -> axum::response::Response {
    forward_to_service(state, from, headers, id, path, method, uri, body).await
}

/// `/api/services/<id>/call/<path>`: forwards to the service, any method, from this computer only.
/// A good answer is kept; when the service is down or fails, the kept answer to the same
/// request is given instead, marked with `x-mrs-cached` (its time, in seconds since 1970).
#[allow(clippy::too_many_arguments)]
async fn forward_to_service(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    id: String,
    path: String,
    method: axum::http::Method,
    uri: axum::http::Uri,
    body: Bytes,
) -> axum::response::Response {
    if let Err(no) = local(&from, &headers) {
        return *no;
    }
    if !state.services.knows(&id) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("this table has no service '{id}'") }))).into_response();
    }
    let tail = match uri.query() {
        Some(q) => format!("/{path}?{q}"),
        None => format!("/{path}"),
    };
    let cache = state.services.cache_file(&id, method.as_str(), &tail, &body);
    let why = match state.services.address(&id) {
        Ok(address) => {
            let kind = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
            let url = format!("{address}{tail}");
            let method = method.as_str().to_string();
            // Every view of the table runs the layer, so the same request comes from each of them:
            // the service is asked once, and they all get its answer (a job is started once).
            let answer = state.services.once(cache.clone(), ask_service(method, url, kind, body.clone())).await;
            match answer {
                Ok((status, kind, bytes)) => {
                    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
                    if status.is_success() {
                        if let Err(e) = write_cache(&cache, &bytes, &kind).await {
                            tracing::warn!("keeping an answer of service '{id}': {e}");
                        }
                    }
                    return (status, [(header::CONTENT_TYPE, kind)], bytes).into_response();
                }
                Err(why) => why,
            }
        }
        Err(services::Refusal::NotUp(service_state, message)) => {
            format!(
                "it is {}{}",
                serde_json::to_value(&service_state).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
                message.map(|m| format!(": {m}")).unwrap_or_default()
            )
        }
        Err(services::Refusal::Unknown) => unreachable!("checked above"),
    };
    // The service cannot answer: the last answer to the same request, if there is one.
    if let Ok(body) = tokio::fs::read(&cache).await {
        let kind = tokio::fs::read_to_string(cache.with_extension("type")).await.unwrap_or_else(|_| "application/octet-stream".into());
        let when = std::fs::metadata(&cache)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        return ([(header::CONTENT_TYPE, kind), (header::HeaderName::from_static("x-mrs-cached"), when.to_string())], body).into_response();
    }
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": format!("service '{id}' cannot answer: {why}"), "service": id })))
        .into_response()
}

/// One request to a service: its status, content type and body, or why it gave no usable answer
/// (it could not be reached, or it failed with a server error).
async fn ask_service(method: String, url: String, kind: Option<String>, body: Bytes) -> services::Answer {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    // Models take their time: a campus day is seconds, a year minutes. Jobs poll instead.
    let client =
        CLIENT.get_or_init(|| reqwest::Client::builder().timeout(std::time::Duration::from_secs(300)).build().expect("an HTTP client"));
    let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut request = client.request(method, url).body(body);
    if let Some(kind) = kind {
        request = request.header(reqwest::header::CONTENT_TYPE, kind);
    }
    let answer = request.send().await.map_err(|e| format!("it could not be reached: {}", e.without_url()))?;
    if answer.status().is_server_error() {
        return Err(format!("the service answered {}", answer.status()));
    }
    let status = answer.status().as_u16();
    let kind =
        answer.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
    let bytes = answer.bytes().await.map_err(|e| format!("reading its answer: {}", e.without_url()))?;
    Ok((status, kind, bytes))
}
