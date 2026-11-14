//! MR Studio local host: serves the surfaces and the active site, runs the session
//! hub and fronts the compute engine. The desktop shell embeds it; `mrstudio dev`
//! runs it on its own. Contract in `docs/contracts/session.md`.

mod engine_bridge;
mod hub;
mod layers;
mod ws;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context as _;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use mrs_engine::Backend;
use mrs_site::Site;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};

pub use engine_bridge::EngineHandle;
pub use hub::{Hub, Role};
pub use layers::{Control, ControlKind, LayerDef};

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
}

pub struct AppState {
    pub hub: Hub,
    pub engine: EngineHandle,
    pub site: Site,
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
    let defs = layers::load_for_site(&site, &config.layers_dir)?;
    let engine = EngineHandle::spawn(config.backend, scene, site.manifest.origin)?;
    let info = engine.info().await?;
    tracing::info!("engine: {:?} backend{}", info.backend, info.adapter.as_ref().map(|a| format!(", {a}")).unwrap_or_default());

    let listener = tokio::net::TcpListener::bind(config.bind).await.with_context(|| format!("binding {}", config.bind))?;
    let addr = listener.local_addr()?;
    let hub = Hub::new(&site, defs, addr.port());
    let state = Arc::new(AppState { hub, engine, site });
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

fn router(state: Arc<AppState>, web_dir: Option<PathBuf>) -> Router {
    let mut app =
        Router::new().route("/ws", get(ws::upgrade)).route("/api/info", get(info)).nest_service("/site", ServeDir::new(&state.site.dir));
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
