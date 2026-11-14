//! MR Studio desktop shell.
//!
//! Starts the host inside this process, then opens one window per configured
//! display and points each at a surface URL. Surfaces are ordinary pages served
//! by the host, so the shell needs no popups, no browser flags and no IPC.
//! Contract in `docs/contracts/session.md`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::Context;
use mrs_engine::Backend;
use mrs_host::HostConfig;
use serde::Deserialize;
use tauri::{Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

/// Which surface goes on which display. Lives in the app's config folder, per machine.
#[derive(Debug, Deserialize)]
struct Displays {
    windows: Vec<WindowSpec>,
}

#[derive(Debug, Deserialize)]
struct WindowSpec {
    /// table, tv or dev.
    role: String,
    #[serde(default)]
    display: DisplayRef,
    #[serde(default = "yes")]
    fullscreen: bool,
}

#[derive(Debug, Default, Deserialize)]
struct DisplayRef {
    /// Matched first, against the monitor name the system reports.
    name: Option<String>,
    /// Used when no name matches. 0 is the first monitor.
    index: Option<usize>,
}

fn yes() -> bool {
    true
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let resources = app.path().resource_dir().unwrap_or_default();
            let config_dir = app.path().app_config_dir()?;

            // The site comes from the command line or MRS_SITE until the app has a site picker.
            let site_dir = std::env::args().nth(1).or_else(|| std::env::var("MRS_SITE").ok()).map(PathBuf::from);
            let site_dir = site_dir.context("pass a site folder as the first argument, or set MRS_SITE")?;
            let config = HostConfig {
                site_dir,
                layers_dir: first_existing(&[resources.join("layers"), PathBuf::from("packages/layers")]),
                web_dir: Some(first_existing(&[resources.join("web"), PathBuf::from("packages/runtime/dist")])),
                // All interfaces, so phones on the studio's network can join.
                bind: SocketAddr::from(([0, 0, 0, 0], 4170)),
                backend: Backend::Auto,
                session: Default::default(),
            };
            let host = tauri::async_runtime::block_on(mrs_host::start(config))?;
            let port = host.addr.port();
            tracing::info!("host listening on port {port}, session code {}", host.state.hub.session().code);
            // The host lives as long as the app.
            app.manage(host);

            let displays = read_displays(&config_dir.join("displays.json"));
            let monitors = handle.available_monitors()?;
            for (index, spec) in displays.windows.iter().enumerate() {
                let url = format!("http://127.0.0.1:{port}/{}", spec.role).parse().expect("valid surface url");
                let window = WebviewWindowBuilder::new(&handle, format!("{}-{index}", spec.role), WebviewUrl::External(url))
                    .title(format!("MR Studio · {}", spec.role))
                    .inner_size(1400.0, 840.0)
                    .decorations(!spec.fullscreen)
                    .build()?;
                if let Some(monitor) = pick_monitor(&monitors, &spec.display) {
                    window.set_position(*monitor.position())?;
                } else {
                    tracing::warn!("no display matches {:?}; using the default", spec.display);
                }
                if spec.fullscreen {
                    window.set_fullscreen(true)?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .context("running the app")
}

fn first_existing(candidates: &[PathBuf]) -> PathBuf {
    candidates.iter().find(|p| p.exists()).unwrap_or(&candidates[candidates.len() - 1]).clone()
}

/// Without a displays.json the app opens one windowed dev surface.
fn read_displays(path: &Path) -> Displays {
    let fallback = || Displays { windows: vec![WindowSpec { role: "dev".into(), display: DisplayRef::default(), fullscreen: false }] };
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::error!("{}: {e}", path.display());
            fallback()
        }),
        Err(_) => {
            tracing::info!("no {}; opening a dev window", path.display());
            fallback()
        }
    }
}

fn pick_monitor<'a>(monitors: &'a [Monitor], wanted: &DisplayRef) -> Option<&'a Monitor> {
    let by_name = wanted.name.as_ref().and_then(|name| monitors.iter().find(|m| m.name().is_some_and(|n| n.contains(name.as_str()))));
    by_name.or_else(|| wanted.index.and_then(|i| monitors.get(i)))
}
