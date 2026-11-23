//! MR Studio local host: serves the surfaces and the active site, runs the session
//! hub and fronts the compute engine. The desktop shell embeds it; `mrstudio dev`
//! runs it on its own. Contract in `docs/contracts/session.md`.

mod calibration;
mod engine_bridge;
mod hub;
mod layers;
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
use mrs_site::import::{self, Options, Report, Target};
use mrs_site::osm::{self, OsmLayer};
use mrs_site::Site;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};

pub use calibration::Calibration;
pub use engine_bridge::EngineHandle;
pub use hub::{Hub, Role, SessionOptions};
pub use layers::{Control, ControlKind, LayerDef, Tool, ToolKind};

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
}

pub struct AppState {
    pub hub: Hub,
    pub engine: EngineHandle,
    pub site: Site,
    /// The site's digital twin in its wire form, built from the baked scene and rebuilt
    /// when imported data changes the scene.
    pub twin: RwLock<Bytes>,
    pub calibration: Calibration,
    /// One import at a time.
    imports: tokio::sync::Mutex<()>,
}

/// Where OpenStreetMap is asked; `MRS_OVERPASS_URL` points elsewhere (a mirror, or a test).
const OVERPASS_URL: &str = "https://overpass-api.de/api/interpreter";

/// The largest file `/api/data/*` accepts.
pub const MAX_IMPORT_BYTES: usize = 256 * 1024 * 1024;

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
        let dir = self.site.dir.clone();
        let bounds = tokio::task::spawn_blocking(move || Site::load(&dir).map(|site| osm::bounds(&site)))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r.map_err(|e| e.to_string()))
            .map_err(|e| Report::refused(target, "site.unreadable", e.clone(), e))?;
        let offline = |detail: String| {
            tracing::warn!("OpenStreetMap fetch failed: {detail}");
            Report::refused(
                target,
                "osm.offline",
                "We can't reach OpenStreetMap right now. Check the internet connection and try again in a minute.",
                "OpenStreetMap did not answer.",
            )
        };
        let url = std::env::var("MRS_OVERPASS_URL").unwrap_or_else(|_| OVERPASS_URL.to_string());
        let client = reqwest::Client::builder()
            .user_agent("MR Studio")
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| offline(e.to_string()))?;
        let response = client.post(&url).form(&[("data", osm::query(layer, bounds))]).send().await.map_err(|e| offline(e.to_string()))?;
        if !response.status().is_success() {
            return Err(offline(format!("{url} answered {}", response.status())));
        }
        let answer: Value = response.json().await.map_err(|e| offline(e.to_string()))?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let collection = osm::to_geojson(layer, &answer, &osm::date(now));
        if osm::count(&collection) == 0 {
            let words = osm::nothing_found(layer);
            return Err(Report::refused(target, "osm.empty", words.clone(), words));
        }
        Ok(serde_json::to_vec(&collection).expect("json"))
    }

    pub async fn import_data(&self, target: &str, filename: &str, bytes: Vec<u8>, options: Options, write: bool) -> Result<Report, String> {
        let target = Target::parse(target)?;
        let _one = self.imports.lock().await;
        let dir = self.site.dir.clone();
        let filename = filename.to_string();
        // The site as it is on disk now: earlier imports and scene edits included.
        let (updated, report) = tokio::task::spawn_blocking(move || -> Result<(Option<Site>, Report), String> {
            let site = Site::load(&dir).map_err(|e| e.to_string())?;
            let prepared = import::inspect(&site, &target, &filename, &bytes, options);
            if !write || !prepared.report.ok {
                return Ok((None, prepared.report));
            }
            let (site, report) = import::apply(&site, prepared).map_err(|e| e.to_string())?;
            Ok((Some(site), report))
        })
        .await
        .map_err(|e| e.to_string())??;
        let Some(site) = updated else { return Ok(report) };

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
        let rebuilt = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let site = Site::load(&dir).map_err(|e| e.to_string())?.place(&place).map_err(|e| e.to_string())?;
            let (scene, stats) = site.bake().map_err(|e| format!("the table was moved, but its scene could not be rebuilt: {e}"))?;
            tracing::info!("re-baked after a move: {} buildings, {} trees", stats.buildings, stats.trees);
            let twin = Bytes::from(site.twin(&scene).map_err(|e| e.to_string())?.encode());
            Ok((scene, twin, site.info(), site.manifest.origin))
        })
        .await
        .map_err(|e| e.to_string())?;
        let (scene, twin, info, origin) = rebuilt?;
        self.engine.relocate(scene, origin).await?;
        *self.twin.write().unwrap() = twin;
        self.hub.site_changed(info.clone());
        Ok(info)
    }
}

/// A running host. Dropping it does not stop the server; call `shutdown`.
pub struct RunningHost {
    pub addr: SocketAddr,
    pub state: Arc<AppState>,
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
    let engine = EngineHandle::spawn(config.backend, scene, site.manifest.origin)?;
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
    let state = Arc::new(AppState { hub, engine, site, twin: RwLock::new(twin), calibration, imports: Default::default() });
    let app = router(state.clone(), config.web_dir.clone());

    let (shutdown, stop) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let serve = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(async {
            let _ = stop.await;
        });
        if let Err(e) = serve.await {
            tracing::error!("server stopped: {e}");
        }
    });
    Ok(RunningHost { addr, state, shutdown, task })
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
        .route("/api/info", get(info))
        .route("/api/model", get(model))
        .route("/api/data/inspect", post(inspect_data))
        .route("/api/data/import", post(import_data))
        .route("/api/site/place", post(place_site))
        .layer(DefaultBodyLimit::max(MAX_IMPORT_BYTES))
        .nest_service("/site", ServeDir::new(&state.site.dir));
    app = match web_dir {
        // Every surface path (/table, /tv, /phone, /dev) is the same single-page app.
        Some(dir) => app.fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html")))),
        None => app.fallback(|| async { "MR Studio host is running. Surfaces are not built; run the web dev server or pass --web." }),
    };
    app.with_state(state)
}

async fn info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let engine = state.engine.info().await.map(|i| json!(i)).unwrap_or(Value::Null);
    Json(json!({ "site": state.hub.site(), "engine": engine, "session": state.hub.session() }))
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
    /// `EPSG:3006`, for a terrain GeoTIFF that does not say.
    #[serde(default)]
    crs: Option<String>,
    /// `osm`: fetch the data from OpenStreetMap instead of reading the body.
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

/// `POST /api/site/place`, `{ name?, origin: { lon, lat }, extent: { width_m, height_m, rotation_deg } }`:
/// renames, moves, resizes or turns the table. Answers with the site as surfaces see it.
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
        Some(other) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": format!("source must be osm, not '{other}'") }))).into_response()
        }
    }
    let crs = match query.crs.as_deref().map(|c| c.trim().trim_start_matches("EPSG:").trim_start_matches("epsg:").parse::<u32>()) {
        None => None,
        Some(Ok(code)) => Some(code),
        Some(Err(_)) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "crs must look like EPSG:3006" }))).into_response(),
    };
    let options = Options { crop: flag(&query.crop), swap: flag(&query.swap), crs };
    match state.import_data(&query.target, &filename, body, options, write).await {
        Ok(report) if report.ok => (StatusCode::OK, Json(json!(report))).into_response(),
        Ok(report) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!(report))).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}
