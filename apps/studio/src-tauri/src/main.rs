//! MR Studio desktop shell.
//!
//! Runs the host inside this process and opens one window per configured display, each
//! pointed at a surface URL. A launcher window picks the site and the displays. Surfaces
//! are ordinary pages served by the host, so there are no popups, no browser flags and no
//! permission prompts. Contract in `docs/contracts/session.md`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod sites;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::Context;
use config::{Display, Displays, Settings, WindowSpec, WINDOW_ROLES};
use mrs_engine::Backend;
use mrs_host::{HostConfig, RunningHost};
use serde::{Deserialize, Serialize};
use sites::SiteEntry;
use tauri::{AppHandle, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const LAUNCHER: &str = "launcher";
const PORT: u16 = 4170;

/// Surfaces are remote pages with no access to the shell. These two shortcuts reach it by
/// asking to navigate to a path the shell intercepts (see `open_surfaces`).
const SHORTCUTS: &str = r"
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
  const action = { KeyS: 'setup', KeyQ: 'quit' }[event.code];
  if (!action) return;
  event.preventDefault();
  window.location.href = '/__shell/' + action;
}, true);
";

struct Shell {
    config_dir: PathBuf,
    /// What ships inside the app: `web`, `layers` and `sites`.
    resources: PathBuf,
    /// Folders of site packages that are scanned for the picker.
    sites_folders: Vec<PathBuf>,
    host: tokio::sync::Mutex<Option<RunningHost>>,
    running: Mutex<Option<Running>>,
    /// Shown once by the launcher, for a start that failed before it was open.
    error: Mutex<Option<String>>,
    /// Makes window labels unique across restarts of the session.
    generation: AtomicU32,
}

#[derive(Debug, Clone, Serialize)]
struct Running {
    site: PathBuf,
    name: String,
    port: u16,
    code: String,
    lan: bool,
}

impl Shell {
    fn displays_path(&self) -> PathBuf {
        self.config_dir.join("displays.json")
    }

    fn settings_path(&self) -> PathBuf {
        self.config_dir.join("studio.json")
    }

    fn settings(&self) -> Settings {
        Settings::read(&self.settings_path())
    }
}

fn main() -> anyhow::Result<()> {
    tauri::Builder::default()
        // A second start (a double click too many) brings up the launcher of the first.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { report(open_launcher(&app)) });
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![launcher_state, add_site, remove_site, identify, start, quit])
        .setup(|app| {
            let paths = app.path();
            let config_dir = paths.app_config_dir()?;
            init_logging(paths.app_log_dir().ok().as_deref());

            // An installed app has its resources beside it. A `cargo run` uses what build.rs staged.
            let bundled = paths.resource_dir().unwrap_or_default();
            let resources = if bundled.join("web").exists() { bundled } else { Path::new(env!("CARGO_MANIFEST_DIR")).join("staged") };
            let mut sites_folders = Vec::new();
            if let Ok(documents) = paths.document_dir() {
                sites_folders.push(documents.join("MR Studio").join("sites"));
            }
            tracing::info!("MR Studio {}; config in {}", app.package_info().version, config_dir.display());

            app.manage(Shell {
                config_dir,
                resources,
                sites_folders,
                host: tokio::sync::Mutex::new(None),
                running: Mutex::new(None),
                error: Mutex::new(None),
                generation: AtomicU32::new(0),
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { startup(handle).await });
            Ok(())
        })
        .run(tauri::generate_context!())
        .context("running the app")
}

/// In a release build there is no console (on Windows not even a hidden one), so log to a file.
fn init_logging(log_dir: Option<&Path>) {
    let file = log_dir.filter(|_| !cfg!(debug_assertions)).and_then(|dir| {
        std::fs::create_dir_all(dir).ok()?;
        std::fs::File::create(dir.join("mr-studio.log")).ok()
    });
    match file {
        Some(file) => tracing_subscriber::fmt().with_target(false).with_ansi(false).with_writer(Mutex::new(file)).init(),
        None => tracing_subscriber::fmt().with_target(false).init(),
    }
}

/// What to do when the app starts:
/// - `mr-studio <site folder>` (or MRS_SITE) runs that site straight away;
/// - `mr-studio --setup` always shows the launcher;
/// - otherwise the last site starts on the saved displays if the launcher was told to
///   do that, and the launcher opens if not.
async fn startup(app: AppHandle) {
    let shell = app.state::<Shell>();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let setup = args.iter().any(|a| a == "--setup");
    let explicit = args.iter().find(|a| !a.starts_with('-')).cloned().or_else(|| std::env::var("MRS_SITE").ok()).map(PathBuf::from);
    let settings = shell.settings();
    let saved = Displays::read(&shell.displays_path()).unwrap_or_else(|e| {
        tracing::error!("displays.json: {e}");
        None
    });

    let site = match (setup, explicit, &saved) {
        (true, _, _) => None,
        (false, Some(site), _) => Some(site),
        (false, None, Some(_)) if settings.autostart => settings.site.clone(),
        _ => None,
    };
    if let Some(site) = site {
        match launch(&app, site, saved.unwrap_or_else(Displays::dev), settings.lan).await {
            Ok(()) => return,
            Err(e) => {
                tracing::error!("could not start: {e:#}");
                *shell.error.lock().unwrap() = Some(format!("{e:#}"));
            }
        }
    }
    if let Err(e) = open_launcher(&app) {
        tracing::error!("could not open the launcher: {e:#}");
        app.exit(1);
    }
}

fn report(result: anyhow::Result<()>) {
    if let Err(e) = result {
        tracing::error!("{e:#}");
    }
}

fn open_launcher(app: &AppHandle) -> anyhow::Result<()> {
    let window = match app.get_webview_window(LAUNCHER) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("index.html".into()))
            .title("MR Studio")
            .inner_size(1080.0, 720.0)
            .min_inner_size(820.0, 560.0)
            .center()
            .build()?,
    };
    // A fullscreen surface may cover the display the launcher is on.
    window.set_always_on_top(app.state::<Shell>().running.lock().unwrap().is_some())?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn list_displays(app: &AppHandle) -> anyhow::Result<Vec<Display>> {
    let primary = app.primary_monitor()?;
    let is_primary = |m: &tauri::Monitor| primary.as_ref().is_some_and(|p| p.position() == m.position() && p.name() == m.name());
    let monitors = app.available_monitors()?;
    let displays = monitors.iter().enumerate().map(|(index, m)| Display {
        index,
        name: m.name().cloned(),
        x: m.position().x,
        y: m.position().y,
        width: m.size().width,
        height: m.size().height,
        scale: m.scale_factor(),
        primary: is_primary(m),
    });
    Ok(displays.collect())
}

/// Stops whatever is running, then runs `site` with one window per entry of `displays`.
async fn launch(app: &AppHandle, site: PathBuf, displays: Displays, lan: bool) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    // One start at a time.
    let mut host = shell.host.lock().await;
    for (label, window) in app.webview_windows() {
        if label.starts_with("surface-") {
            window.destroy()?;
        }
    }
    *shell.running.lock().unwrap() = None;
    if let Some(old) = host.take() {
        old.stop(Duration::from_secs(2)).await;
    }

    let ip = if lan { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    // Keep the usual port when it is free, so phone links and bookmarks stay valid.
    let port = if std::net::TcpListener::bind(SocketAddr::from((ip, PORT))).is_ok() { PORT } else { 0 };
    let started = mrs_host::start(HostConfig {
        site_dir: site.clone(),
        layers_dir: shell.resources.join("layers"),
        web_dir: Some(shell.resources.join("web")),
        bind: SocketAddr::from((ip, port)),
        backend: Backend::Auto,
    })
    .await?;
    let running = Running {
        site,
        name: started.state.site.manifest.name.clone(),
        port: started.addr.port(),
        code: started.state.hub.session().code.clone(),
        lan,
    };
    tracing::info!("running '{}' on port {}, session code {}", running.name, running.port, running.code);
    *host = Some(started);
    *shell.running.lock().unwrap() = Some(running.clone());

    open_surfaces(app, running.port, &displays)
}

fn open_surfaces(app: &AppHandle, port: u16, displays: &Displays) -> anyhow::Result<()> {
    let connected = list_displays(app)?;
    let generation = app.state::<Shell>().generation.fetch_add(1, Ordering::Relaxed);
    for (n, spec) in displays.windows.iter().enumerate() {
        let target = spec.display.resolve(&connected).or_else(|| {
            tracing::warn!("no display matches {:?} for the {} window; using the primary display", spec.display, spec.role);
            connected.iter().find(|d| d.primary).or(connected.first())
        });
        let url = format!("http://127.0.0.1:{port}/{}", spec.role).parse().expect("valid surface url");
        let handle = app.clone();
        let window = WebviewWindowBuilder::new(app, format!("surface-{generation}-{n}-{}", spec.role), WebviewUrl::External(url))
            .title(format!("MR Studio · {}", spec.role))
            .inner_size(1400.0, 840.0)
            .visible(false)
            .initialization_script(SHORTCUTS)
            .on_navigation(move |url| match url.path().strip_prefix("/__shell/") {
                Some(action) => {
                    shell_action(&handle, action);
                    false
                }
                None => true,
            })
            .build()?;
        place(&window, target, spec)?;
        tracing::info!("{} window on display {:?}", spec.role, target.map(|d| (d.index, d.name.as_deref().unwrap_or(""))));
    }
    Ok(())
}

/// Puts a window on its display: borderless fullscreen, or a normal window near its corner.
fn place(window: &WebviewWindow, display: Option<&Display>, spec: &WindowSpec) -> tauri::Result<()> {
    if let Some(d) = display {
        let inset = if spec.fullscreen { 0 } else { (60.0 * d.scale) as i32 };
        window.set_position(PhysicalPosition::new(d.x + inset, d.y + inset))?;
    }
    if !spec.fullscreen {
        return window.show();
    }
    // macOS: the system's fullscreen moves the window to a space of its own with an
    // animation, and two of those fight each other. Simple fullscreen just covers the
    // display the window is on, including the menu bar and the Dock.
    #[cfg(target_os = "macos")]
    {
        window.show()?;
        window.set_simple_fullscreen(true)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_decorations(false)?;
        match display {
            Some(d) => window.set_fullscreen_on_monitor(PhysicalPosition::new(
                f64::from(d.x) + f64::from(d.width) / 2.0,
                f64::from(d.y) + f64::from(d.height) / 2.0,
            ))?,
            None => window.set_fullscreen(true)?,
        }
        window.show()?;
    }
    Ok(())
}

fn shell_action(app: &AppHandle, action: &str) {
    let app = app.clone();
    match action {
        // Off the event loop: creating a window from inside a webview callback can deadlock on Windows.
        "setup" => drop(tauri::async_runtime::spawn(async move { report(open_launcher(&app)) })),
        "quit" => app.exit(0),
        other => tracing::warn!("unknown shell action '{other}'"),
    }
}

// The launcher's commands. Only the launcher window can call them: it is the only local
// page, and Tauri refuses commands from remote pages such as the surfaces.

#[derive(Serialize)]
struct LauncherState {
    version: String,
    sites: Vec<SiteEntry>,
    /// Where to drop site packages so they show up by themselves.
    sites_folder: Option<PathBuf>,
    /// The site to preselect.
    site: Option<PathBuf>,
    displays: Vec<Display>,
    windows: Vec<Assigned>,
    /// A displays.json exists on this machine.
    configured: bool,
    lan: bool,
    autostart: bool,
    running: Option<Running>,
    error: Option<String>,
}

/// A window on a connected display, as the launcher shows and sends it.
#[derive(Debug, Serialize, Deserialize)]
struct Assigned {
    display: usize,
    role: String,
    #[serde(default = "yes")]
    fullscreen: bool,
}

fn yes() -> bool {
    true
}

fn text(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

#[tauri::command]
fn launcher_state(app: AppHandle, shell: State<'_, Shell>) -> Result<LauncherState, String> {
    let settings = shell.settings();
    let displays = list_displays(&app).map_err(text)?;
    let mut error = shell.error.lock().unwrap().take();
    let saved = Displays::read(&shell.displays_path()).unwrap_or_else(|e| {
        error.get_or_insert(format!("displays.json could not be read ({e}). Choose the displays again."));
        None
    });
    let windows = saved.clone().unwrap_or_else(|| Displays::suggest(&displays)).windows;
    let assigned = windows.iter().filter_map(|w| {
        let display =
            w.display.resolve(&displays).or_else(|| displays.iter().find(|d| d.primary).filter(|_| w.display == Default::default()))?;
        Some(Assigned { display: display.index, role: w.role.clone(), fullscreen: w.fullscreen })
    });
    let running = shell.running.lock().unwrap().clone();
    let sites = sites::discover(&settings.sites, &shell.sites_folders, &shell.resources.join("sites"));
    let usable = |path: &PathBuf| sites.iter().any(|s| &s.path == path && s.problem.is_none());
    let site = running.as_ref().map(|r| r.site.clone()).or(settings.site.clone()).filter(usable);
    Ok(LauncherState {
        version: app.package_info().version.to_string(),
        site: site.or_else(|| sites.iter().find(|s| s.problem.is_none()).map(|s| s.path.clone())),
        sites,
        sites_folder: shell.sites_folders.first().cloned(),
        windows: assigned.collect(),
        displays,
        configured: saved.is_some(),
        lan: settings.lan,
        // Offered by default on a machine that is being set up for the first time.
        autostart: settings.autostart || saved.is_none(),
        running,
        error,
    })
}

/// Asks for a folder and adds it to the picker. `None` when the dialog was cancelled.
#[tauri::command]
async fn add_site(app: AppHandle, shell: State<'_, Shell>) -> Result<Option<SiteEntry>, String> {
    let Some(folder) = app.dialog().file().set_title("Choose a site folder (the one with site.json)").blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(text)?;
    let entry = sites::describe(path.clone(), "added");
    if let Some(problem) = &entry.problem {
        return Err(format!("{} is not a usable site: {problem}", path.display()));
    }
    let mut settings = shell.settings();
    if !settings.sites.contains(&path) {
        settings.sites.push(path);
        settings.write(&shell.settings_path()).map_err(text)?;
    }
    Ok(Some(entry))
}

#[tauri::command]
fn remove_site(shell: State<'_, Shell>, path: PathBuf) -> Result<(), String> {
    let mut settings = shell.settings();
    settings.sites.retain(|p| p != &path && p.canonicalize().ok().as_ref() != Some(&path));
    settings.write(&shell.settings_path()).map_err(text)
}

/// Shows each display's number on it for a few seconds.
#[tauri::command]
async fn identify(app: AppHandle) -> Result<(), String> {
    let mut windows = Vec::new();
    for d in list_displays(&app).map_err(text)? {
        let label = format!("identify-{}", d.index);
        if let Some(old) = app.get_webview_window(&label) {
            let _ = old.destroy();
        }
        let (width, height) = (360.0, 240.0);
        let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(format!("identify.html#{}", d.index + 1).into()))
            .title(format!("Display {}", d.index + 1))
            .inner_size(width, height)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build()
            .map_err(text)?;
        let x = f64::from(d.x) + (f64::from(d.width) - width * d.scale) / 2.0;
        let y = f64::from(d.y) + (f64::from(d.height) - height * d.scale) / 2.0;
        window.set_position(PhysicalPosition::new(x, y)).map_err(text)?;
        window.show().map_err(text)?;
        windows.push(window);
    }
    tokio::time::sleep(Duration::from_millis(2500)).await;
    for window in windows {
        let _ = window.destroy();
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct StartRequest {
    site: PathBuf,
    windows: Vec<Assigned>,
    lan: bool,
    autostart: bool,
}

/// Saves the choices, starts the session and closes the launcher.
#[tauri::command]
async fn start(app: AppHandle, shell: State<'_, Shell>, request: StartRequest) -> Result<(), String> {
    let connected = list_displays(&app).map_err(text)?;
    let mut displays = Displays { windows: Vec::new() };
    for window in &request.windows {
        if !WINDOW_ROLES.contains(&window.role.as_str()) {
            return Err(format!("'{}' is not a window role", window.role));
        }
        let display = connected.iter().find(|d| d.index == window.display).ok_or("that display is no longer connected")?;
        displays.windows.push(WindowSpec { role: window.role.clone(), display: display.reference(), fullscreen: window.fullscreen });
    }
    if displays.windows.is_empty() {
        displays = Displays::dev();
    }
    displays.write(&shell.displays_path()).map_err(text)?;
    let mut settings = shell.settings();
    settings.site = Some(request.site.clone());
    settings.lan = request.lan;
    settings.autostart = request.autostart;
    settings.write(&shell.settings_path()).map_err(text)?;

    launch(&app, request.site, displays, request.lan).await.map_err(text)?;
    if let Some(launcher) = app.get_webview_window(LAUNCHER) {
        launcher.close().map_err(text)?;
    }
    Ok(())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}
