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
use std::sync::Arc;

use anyhow::Context as _;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use mrs_engine::Backend;
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
    /// The site's digital twin in its wire form, built once from the baked scene.
    pub twin: Bytes,
    pub calibration: Calibration,
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
    let state = Arc::new(AppState { hub, engine, site, twin, calibration });
    let app = router(state.clone(), config.web_dir.clone());

    let (shutdown, stop) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let serve = axum::serve(listener, app).with_graceful_shutdown(async {
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
    Json(json!({ "site": state.site.info(), "engine": engine, "session": state.hub.session() }))
}

/// The digital twin mesh. Layout in `docs/contracts/model.md`.
async fn model(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-cache")], state.twin.clone())
}
