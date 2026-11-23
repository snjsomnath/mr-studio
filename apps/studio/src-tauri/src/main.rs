//! MR Studio desktop shell.
//!
//! Runs the host inside this process. A launcher window picks or creates the site and the
//! displays; the editor window authors it; Present opens one window per configured
//! display, each pointed at a surface URL. Surfaces
//! are ordinary pages served by the host, so there are no popups, no browser flags and no
//! permission prompts. Contract in `docs/contracts/session.md`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod colour;
mod config;
mod file_menu;
#[cfg(windows)]
mod models;
mod sites;
mod updates;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use colour::{Colour, ColourConfig};
use config::{Display, Displays, Kind, Settings, WindowSpec, WINDOW_ROLES};
use mrs_engine::Backend;
use mrs_host::sources::{Change, Keychain, Sources};
use mrs_host::{HostConfig, Role, RunningHost};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sites::SiteEntry;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// The first window: recent tables and the way to a new one.
const HOME: &str = "home";
/// Displays, colour, calibration and updates.
const LAUNCHER: &str = "launcher";
/// The Sources page: outside services and their keys (#41). It alone may change them.
const SOURCES: &str = "sources";
/// The window where a site is authored: the host's `/edit` page. It may call the few
/// commands listed in `capabilities/editor.json`.
const EDITOR: &str = "editor";
const PORT: u16 = 4170;

/// Surfaces are remote pages with no access to the shell. These shortcuts reach it by
/// asking to navigate to a path the shell intercepts (see `open_surfaces`).
/// The editor page's link to the shell until it has a Present button of its own.
const EDITOR_BAR: &str = include_str!("editor-bar.js");

/// The way back from a presentation, on the screens people look at up close. Never on
/// the table: nothing of the app's own is projected onto the model.
const SURFACE_EXIT: &str = include_str!("surface-exit.js");

const SHORTCUTS: &str = r"
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
  const action = { KeyS: 'setup', KeyQ: 'quit', KeyE: 'edit' }[event.code];
  if (!action) return;
  event.preventDefault();
  window.location.href = '/__shell/' + action;
}, true);
// Esc leaves presenting, unless the page used the key itself (closing a panel, say).
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;
  window.location.href = '/__shell/escape';
});
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
    /// The open surface windows and the display each one is on: (window label, display index).
    surfaces: Mutex<Vec<(String, usize)>>,
    /// The editor window shows a site that has since been replaced.
    editor_stale: std::sync::atomic::AtomicBool,
    /// The result of the last look for a newer version.
    updates: Mutex<Option<Result<updates::Available, String>>>,
    /// File menu actions that arrive twice (menu shortcut and page) run once.
    file_debounce: file_menu::Debounce,
    /// Outside services and their keys, shared with every host this app runs.
    sources: Arc<Sources>,
}

#[derive(Debug, Clone, Serialize)]
struct Running {
    site: PathBuf,
    site_id: String,
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

    fn colour_path(&self) -> PathBuf {
        self.config_dir.join("colour.json")
    }

    fn settings(&self) -> Settings {
        Settings::read(&self.settings_path())
    }
}

fn main() -> anyhow::Result<()> {
    tauri::Builder::default()
        // A second start (a double click too many) brings up the Home page of the first.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { report(open_home_window(&app)) });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            launcher_state,
            add_site,
            remove_site,
            delete_table,
            identify,
            start,
            open_site,
            create_site,
            present,
            stop_presenting,
            presenting_state,
            save_displays,
            save_settings,
            open_home,
            open_settings,
            open_view,
            new_table,
            quit,
            colour_state,
            set_colour,
            save_preset,
            delete_preset,
            test_card,
            set_layer_intensity,
            calibration_state,
            calibration_mode,
            calibration_clear,
            update_state,
            check_updates,
            set_update_check,
            install_update,
            open_link,
            file_action,
            table_details,
            open_sources,
            sources_page,
            sources_save,
            sources_remove,
            sources_test
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if file_menu::ACTIONS.contains(&id) {
                run_file_action(app, id);
            }
        })
        .setup(|app| {
            let paths = app.path();
            let config_dir = paths.app_config_dir()?;
            init_logging(paths.app_log_dir().ok().as_deref());

            // An installed app has its resources beside it. A `cargo run` uses what build.rs staged.
            let bundled = paths.resource_dir().unwrap_or_default();
            let resources = if bundled.join("web").exists() { bundled } else { Path::new(env!("CARGO_MANIFEST_DIR")).join("staged") };
            let mut sites_folders = Vec::new();
            // Sites live in Documents, where people find them; on a computer without one, with the app's data.
            if let Ok(folder) = paths.document_dir().map(|d| d.join("MR Studio")).or_else(|_| paths.app_data_dir()) {
                sites_folders.push(folder.join("sites"));
            }
            tracing::info!("MR Studio {}; config in {}", app.package_info().version, config_dir.display());
            // The list is a file beside the other settings; the keys are in the system keychain.
            let sources = Sources::open(config_dir.join("sources.json"), Box::new(Keychain)).unwrap_or_else(|e| {
                tracing::error!("sources.json could not be read ({e}); starting with no sources");
                Sources::in_memory()
            });

            app.manage(Shell {
                config_dir,
                resources,
                sites_folders,
                host: tokio::sync::Mutex::new(None),
                running: Mutex::new(None),
                error: Mutex::new(None),
                generation: AtomicU32::new(0),
                surfaces: Mutex::new(Vec::new()),
                editor_stale: Default::default(),
                updates: Mutex::new(None),
                file_debounce: file_menu::Debounce::new(),
                sources: Arc::new(sources),
            });
            // macOS has one menu bar for the app. Elsewhere the File menu sits on the editor window only.
            if cfg!(target_os = "macos") {
                app.set_menu(file_menu::app_menu(app.handle())?)?;
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { startup(handle).await });
            if !app.state::<Shell>().settings().skip_update_check {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // After the table is up; nothing waits for this.
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    look_for_updates(&handle).await;
                });
            }
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
/// - `mr-studio --setup` shows the displays and settings window;
/// - otherwise the last site starts on the saved displays if the settings say so, and
///   the Home page opens if not.
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
        let started = match launch(&app, site, settings.lan).await {
            Ok(()) => usual_displays(&app).and_then(|displays| show(&app, &displays)),
            Err(e) => Err(e),
        };
        match started {
            Ok(()) => return,
            Err(e) => {
                tracing::error!("could not start: {e:#}");
                *shell.error.lock().unwrap() = Some(format!("{e:#}"));
            }
        }
    }
    let opened = if setup { open_launcher(&app) } else { open_home_window(&app) };
    if let Err(e) = opened {
        tracing::error!("could not open the first window: {e:#}");
        app.exit(1);
    }
}

fn report(result: anyhow::Result<()>) {
    if let Err(e) = result {
        tracing::error!("{e:#}");
    }
}

fn open_home_window(app: &AppHandle) -> anyhow::Result<()> {
    let window = match app.get_webview_window(HOME) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, HOME, WebviewUrl::App("home.html".into()))
            .title("MR Studio")
            .inner_size(1040.0, 720.0)
            .min_inner_size(760.0, 560.0)
            .center()
            .build()?,
    };
    window.set_always_on_top(is_presenting(app))?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn open_launcher(app: &AppHandle) -> anyhow::Result<()> {
    let window = match app.get_webview_window(LAUNCHER) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, LAUNCHER, WebviewUrl::App("index.html".into()))
            .title("MR Studio · Displays and settings")
            .inner_size(1080.0, 720.0)
            .min_inner_size(820.0, 560.0)
            .center()
            .build()?,
    };
    // A fullscreen surface may cover the display the launcher is on.
    window.set_always_on_top(is_presenting(app))?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn open_sources_window(app: &AppHandle) -> anyhow::Result<()> {
    let window = match app.get_webview_window(SOURCES) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, SOURCES, WebviewUrl::App("sources.html".into()))
            .title("MR Studio · Sources")
            .inner_size(1000.0, 720.0)
            .min_inner_size(720.0, 520.0)
            .center()
            .build()?,
    };
    window.set_always_on_top(is_presenting(app))?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn list_displays(app: &AppHandle) -> anyhow::Result<Vec<Display>> {
    let primary = app.primary_monitor()?;
    let is_primary = |m: &tauri::Monitor| primary.as_ref().is_some_and(|p| p.position() == m.position() && p.name() == m.name());
    let monitors = app.available_monitors()?;
    #[cfg(windows)]
    let models = models::models();
    let model = |name: Option<&String>| -> Option<String> {
        #[cfg(windows)]
        if let Some((_, model)) = models.iter().find(|(system, _)| Some(system) == name) {
            return Some(model.clone());
        }
        name.filter(|n| !n.is_empty() && !n.starts_with(r"\\.\")).cloned()
    };
    let displays = monitors.iter().enumerate().map(|(index, m)| {
        let model = model(m.name());
        Display {
            index,
            name: m.name().cloned(),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
            primary: is_primary(m),
            kind: model.as_deref().and_then(Kind::guess),
            model,
        }
    });
    Ok(displays.collect())
}

/// Stops whatever is running, then runs `site`. No window is opened: `show` puts it on
/// the displays and `open_editor` opens it for authoring.
async fn launch(app: &AppHandle, site: PathBuf, lan: bool) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    // One start at a time.
    let mut host = shell.host.lock().await;
    close_surfaces(app)?;
    // The editor window stays: it may be the only window, and an app without windows quits.
    // It shows the site that is about to stop, so it is marked for a reload.
    shell.editor_stale.store(true, Ordering::Relaxed);
    for (label, window) in app.webview_windows() {
        if label.starts_with("view-") {
            window.destroy()?;
        }
    }
    *shell.running.lock().unwrap() = None;
    if let Some(old) = host.take() {
        old.stop(Duration::from_secs(2)).await;
    }

    // A site saved by an older version is brought up to this version's format, on disk,
    // with the original kept beside it. A site from a newer version is refused with advice.
    if let Some(done) = mrs_site::migrate::upgrade_site(&site)? {
        tracing::info!("upgraded {} from site format {} to {}: {}", site.display(), done.from, done.to, done.changes.join("; "));
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
        session: Default::default(),
        sources: shell.sources.clone(),
    })
    .await?;
    let running = Running {
        site,
        site_id: started.state.site.manifest.id.clone(),
        name: started.state.site.manifest.name.clone(),
        port: started.addr.port(),
        code: started.state.hub.session().code.clone(),
        lan,
    };
    tracing::info!("running '{}' on port {}, session code {}", running.name, running.port, running.code);
    // Layer intensities tuned on this machine for this site.
    let colours = ColourConfig::read(&shell.colour_path());
    for (layer, intensity) in colours.layers.get(&running.site_id).into_iter().flatten() {
        if let Err(e) = started.state.hub.request(Role::Tv, 0, "layer.intensity", &json!({ "layer": layer, "intensity": intensity })) {
            tracing::warn!("saved intensity for layer '{layer}' not applied: {e}");
        }
    }
    *host = Some(started);
    *shell.running.lock().unwrap() = Some(running);
    Ok(())
}

/// Runs `site` unless it is what is running already, with the same network choice.
/// Returns the folder that runs: `site` itself, or the person's own copy of a built-in one.
async fn ensure_running(app: &AppHandle, site: &Path, lan: bool) -> anyhow::Result<PathBuf> {
    let shell = app.state::<Shell>();
    let site = sites::canonical(working_copy(&shell, site)?);
    let same = |r: &Running| r.lan == lan && r.site == site;
    if !shell.running.lock().unwrap().as_ref().is_some_and(same) {
        launch(app, site.clone(), lan).await?;
    }
    Ok(site)
}

/// A site that ships inside the app is a starting point, not a place to save: the app
/// folder is replaced by every update and may not be writable. It is copied to the sites
/// folder once, and that copy is what opens from then on.
fn working_copy(shell: &Shell, site: &Path) -> anyhow::Result<PathBuf> {
    let built_in = sites::canonical(shell.resources.join("sites"));
    let site = sites::canonical(site.to_path_buf());
    let (Ok(inside), Some(folder)) = (site.strip_prefix(&built_in), shell.sites_folders.first()) else { return Ok(site) };
    let copy = folder.join(inside);
    if !copy.join("site.json").exists() {
        copy_dir(&site, &copy).with_context(|| format!("copying the example to {}", copy.display()))?;
        tracing::info!("copied the built-in site to {}", copy.display());
    }
    Ok(copy)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Opens one surface of the running site in a normal window, for looking at it beside the editor.
fn show_view(app: &AppHandle, role: &str) -> anyhow::Result<()> {
    anyhow::ensure!(["table", "tv", "dev", "phone"].contains(&role), "'{role}' is not a view");
    let running = app.state::<Shell>().running.lock().unwrap().clone().context("no site is open")?;
    let label = format!("view-{role}");
    let window = match app.get_webview_window(&label) {
        Some(window) => window,
        None => {
            let url = format!("http://127.0.0.1:{}/{role}", running.port).parse().expect("valid view url");
            let (width, height) = if role == "phone" { (420.0, 800.0) } else { (1100.0, 700.0) };
            WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
                .title(format!("MR Studio · {} · {role}", running.name))
                .inner_size(width, height)
                .build()?
        }
    };
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn close_surfaces(app: &AppHandle) -> anyhow::Result<()> {
    for (label, window) in app.webview_windows() {
        if label.starts_with("surface-") {
            window.destroy()?;
        }
    }
    app.state::<Shell>().surfaces.lock().unwrap().clear();
    Ok(())
}

fn is_presenting(app: &AppHandle) -> bool {
    app.webview_windows().keys().any(|label| label.starts_with("surface-"))
}

/// Puts the running site on the displays: one window per entry of `displays`, replacing
/// the ones that are open.
fn show(app: &AppHandle, displays: &Displays) -> anyhow::Result<()> {
    let port = app.state::<Shell>().running.lock().unwrap().as_ref().map(|r| r.port).context("no site is open")?;
    close_surfaces(app)?;
    open_surfaces(app, port, displays)
}

/// The displays to present on when nobody says: the saved choice while it fits what is
/// connected, else the table and the controller fullscreen on displays of their own.
fn usual_displays(app: &AppHandle) -> anyhow::Result<Displays> {
    let saved = Displays::read(&app.state::<Shell>().displays_path()).unwrap_or_else(|e| {
        tracing::warn!("displays.json: {e}; presenting on the suggested displays");
        None
    });
    Ok(Displays::usual(saved, &list_displays(app)?))
}

/// Opens the running site in the editor window, at `page` of the host: `edit` for the
/// editor, `edit?welcome=1` for a table that was just created, `new` for the new-table wizard.
fn open_editor(app: &AppHandle, page: &str) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    let running = shell.running.lock().unwrap().clone().context("no site is open")?;
    let url: tauri::Url = format!("http://127.0.0.1:{}/{page}", running.port).parse().context("the editor's address")?;
    let title = if page == "new" { "MR Studio · New table".to_string() } else { format!("MR Studio · {}", running.name) };
    let stale = shell.editor_stale.swap(false, Ordering::Relaxed);
    let window = match app.get_webview_window(EDITOR) {
        Some(window) => {
            if stale || window.url().ok().as_ref() != Some(&url) {
                window.navigate(url)?;
            }
            window.set_title(&title)?;
            window
        }
        None => {
            let handle = app.clone();
            let builder = WebviewWindowBuilder::new(app, EDITOR, WebviewUrl::External(url));
            #[cfg(not(target_os = "macos"))]
            let builder = builder.menu(file_menu::editor_menu(app)?);
            let window = builder
                .title(title)
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .initialization_script(EDITOR_BAR)
                .on_navigation(move |url| match url.path().strip_prefix("/__shell/") {
                    Some(action) => {
                        shell_action(&handle, action);
                        false
                    }
                    None => true,
                })
                .build()?;
            // Closing the editor leads back to Home, as closing a document does, unless the
            // table is being presented. The page first gets a moment to keep a picture of
            // the map for the table's card on Home (#131).
            let handle = app.clone();
            window.on_window_event(move |event| {
                let tauri::WindowEvent::CloseRequested { api, .. } = event else { return };
                api.prevent_close();
                let Some(editor) = handle.get_webview_window(EDITOR) else { return };
                let _ = editor.eval("window.mrsBeforeLeave && window.mrsBeforeLeave()");
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(700)).await;
                    if !is_presenting(&handle) {
                        report(open_home_window(&handle));
                    }
                    if let Some(editor) = handle.get_webview_window(EDITOR) {
                        report(editor.destroy().map_err(anyhow::Error::from));
                    }
                });
            });
            window
        }
    };
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Closes the shell's own pages once a site is in front.
fn close_shell_pages(app: &AppHandle) {
    for label in [HOME, LAUNCHER] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
}

fn open_surfaces(app: &AppHandle, port: u16, displays: &Displays) -> anyhow::Result<()> {
    let connected = list_displays(app)?;
    let shell = app.state::<Shell>();
    let generation = shell.generation.fetch_add(1, Ordering::Relaxed);
    let colours = ColourConfig::read(&shell.colour_path());
    for (n, spec) in displays.windows.iter().enumerate() {
        let target = spec.display.resolve(&connected).or_else(|| {
            // A window with no display named (the dev window) simply belongs on the primary one.
            if spec.display != Default::default() {
                tracing::warn!("no display matches {:?} for the {} window; using the primary display", spec.display, spec.role);
            }
            connected.iter().find(|d| d.primary).or(connected.first())
        });
        let url = format!("http://127.0.0.1:{port}/{}", spec.role).parse().expect("valid surface url");
        let handle = app.clone();
        let label = format!("surface-{generation}-{n}-{}", spec.role);
        // The colour pass for this display is in place before the page draws anything.
        let colour = target.map(|d| colours.for_display(d)).unwrap_or_default();
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
            .title(format!("MR Studio · {}", spec.role))
            .inner_size(1400.0, 840.0)
            .visible(false)
            .initialization_script(format!(
                "{SHORTCUTS}\n{}\n{}\n{}",
                colour::SCRIPT,
                colour.script(),
                // The table shows the way back only when it is alone, on the author's own screen.
                if spec.role == "table" && displays.windows.len() > 1 { "" } else { SURFACE_EXIT }
            ))
            .on_navigation(move |url| match url.path().strip_prefix("/__shell/") {
                Some(action) => {
                    shell_action(&handle, action);
                    false
                }
                None => true,
            })
            .build()?;
        place(&window, target, spec)?;
        if let Some(d) = target {
            shell.surfaces.lock().unwrap().push((label, d.index));
        }
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
        // Back from the table to the editor.
        "edit" => drop(tauri::async_runtime::spawn(async move {
            // The editor first: with the surfaces gone and no other window, the app would quit.
            report(open_editor(&app, "edit").or_else(|_| open_home_window(&app)));
            report(close_surfaces(&app));
        })),
        // A page asked for a view of its own (the editor's "Open in a window").
        view if view.starts_with("window/") => {
            let role = view["window/".len()..].to_string();
            drop(tauri::async_runtime::spawn(async move { report(show_view(&app, &role)) }));
        }
        // Esc on a surface: the way back for the author, as in a slideshow. A table that
        // presents by itself, with no editor open, ignores it.
        "escape" if app.get_webview_window(EDITOR).is_some() => shell_action(&app, "edit"),
        "escape" => {}
        "quit" => app.exit(0),
        other => tracing::warn!("unknown shell action '{other}'"),
    }
}

// The shell's commands. The launcher may call all of them and the editor window a few
// (`capabilities/`); Tauri refuses commands from every other page, such as the surfaces.

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
    /// The displays were chosen by hand and the choice fits what is connected. Otherwise
    /// `windows` is the automatic choice.
    configured: bool,
    lan: bool,
    autostart: bool,
    running: Option<Running>,
    /// The running site is on the displays, not only open in the editor.
    presenting: bool,
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
    let configured = saved.as_ref().is_some_and(|s| s.fits(&displays));
    let windows = Displays::usual(saved, &displays).windows;
    let assigned = windows.iter().filter_map(|w| {
        let display =
            w.display.resolve(&displays).or_else(|| displays.iter().find(|d| d.primary).filter(|_| w.display == Default::default()))?;
        Some(Assigned { display: display.index, role: w.role.clone(), fullscreen: w.fullscreen })
    });
    let running = shell.running.lock().unwrap().clone();
    let mut sites = sites::discover(&settings.sites, &shell.sites_folders, &shell.resources.join("sites"));
    // The sites opened last come first; the rest keep their order.
    let recency = |s: &SiteEntry| settings.recent.iter().position(|p| p == &s.path).unwrap_or(usize::MAX);
    sites.sort_by_key(recency);
    // An example that has been opened lives on as the person's own copy; list that one only.
    let own: Vec<_> = sites.iter().filter(|s| s.source != "built in").filter_map(|s| s.path.file_name().map(|n| n.to_owned())).collect();
    sites.retain(|s| s.source != "built in" || s.path.file_name().is_none_or(|n| !own.iter().any(|o| o == n)));
    let usable = |path: &PathBuf| sites.iter().any(|s| &s.path == path && s.problem.is_none());
    let site = running.as_ref().map(|r| r.site.clone()).or(settings.site.clone()).filter(usable);
    Ok(LauncherState {
        version: app.package_info().version.to_string(),
        site: site.or_else(|| sites.iter().find(|s| s.problem.is_none()).map(|s| s.path.clone())),
        sites,
        sites_folder: shell.sites_folders.first().cloned(),
        windows: assigned.collect(),
        displays,
        configured,
        lan: settings.lan,
        // A table that starts by itself is a choice for a finished installation, never the default.
        autostart: settings.autostart,
        running,
        presenting: is_presenting(&app),
        error,
    })
}

/// The size and picture of a table, for its card on Home. Separate from `launcher_state`
/// so Home shows the list at once and fills these in as they come.
#[tauri::command]
async fn table_details(path: PathBuf) -> Result<sites::Details, String> {
    tokio::task::spawn_blocking(move || sites::details(&path)).await.map_err(text)
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

/// Deletes a table from Home (#184): its folder goes to the Trash (Mac, Linux) or the Recycle
/// Bin (Windows), where it can be got back. Home asks first. Refused for an example that comes
/// with the app, for a folder without site.json, and for the table that is open in the editor
/// or on the displays. A table that was left but still runs in the background is stopped first.
#[tauri::command]
async fn delete_table(app: AppHandle, shell: State<'_, Shell>, path: PathBuf) -> Result<(), String> {
    let path = sites::canonical(path);
    if !path.join("site.json").is_file() {
        return Err(format!("{} is not a table folder (it has no site.json), so it was not deleted.", path.display()));
    }
    if path.starts_with(sites::canonical(shell.resources.clone())) {
        return Err("The examples come with MR Studio and cannot be deleted.".into());
    }
    let running = shell.running.lock().unwrap().as_ref().is_some_and(|r| r.site == path);
    if running {
        if app.get_webview_window(EDITOR).is_some() || is_presenting(&app) {
            return Err("This table is open. Close it first (File > Close table), then delete it.".into());
        }
        // Left, but its host still holds the folder: stop it, so the files are free to move.
        let mut host = shell.host.lock().await;
        *shell.running.lock().unwrap() = None;
        if let Some(old) = host.take() {
            old.stop(Duration::from_secs(2)).await;
        }
    }
    sites::move_to_trash(&path).map_err(text)?;
    tracing::info!("moved {} to the trash", path.display());
    let mut settings = shell.settings();
    settings.sites.retain(|p| sites::canonical(p.clone()) != path);
    settings.recent.retain(|p| sites::canonical(p.clone()) != path);
    if settings.site.as_ref().is_some_and(|p| sites::canonical(p.clone()) == path) {
        settings.site = None;
    }
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

/// Saves the choices, puts the site on the displays and closes the launcher.
#[tauri::command]
async fn start(app: AppHandle, shell: State<'_, Shell>, request: StartRequest) -> Result<(), String> {
    let displays = chosen_displays(&app, &request.windows)?;
    displays.write(&shell.displays_path()).map_err(text)?;
    let mut settings = shell.settings();
    settings.lan = request.lan;
    settings.autostart = request.autostart;
    settings.write(&shell.settings_path()).map_err(text)?;

    // An editor that is open on this site stays open; its changes are already on the table.
    let site = ensure_running(&app, &request.site, request.lan).await.map_err(text)?;
    let mut settings = shell.settings();
    settings.opened(&site);
    settings.write(&shell.settings_path()).map_err(text)?;
    if app.get_webview_window(EDITOR).is_some() {
        open_editor(&app, "edit").map_err(text)?;
    }
    show(&app, &displays).map_err(text)?;
    if let Some(launcher) = app.get_webview_window(LAUNCHER) {
        launcher.close().map_err(text)?;
    }
    Ok(())
}

/// The launcher's or the editor's choice of displays, as it is saved.
fn chosen_displays(app: &AppHandle, windows: &[Assigned]) -> Result<Displays, String> {
    let connected = list_displays(app).map_err(text)?;
    let mut displays = Displays { windows: Vec::new() };
    for window in windows {
        if !WINDOW_ROLES.contains(&window.role.as_str()) {
            return Err(format!("'{}' is not a window role", window.role));
        }
        let display = connected.iter().find(|d| d.index == window.display).ok_or("that display is no longer connected")?;
        displays.windows.push(WindowSpec { role: window.role.clone(), display: display.reference(), fullscreen: window.fullscreen });
    }
    if displays.windows.is_empty() {
        displays = Displays::dev();
    }
    Ok(displays)
}

/// Opens a site in the editor and closes the shell's own pages. Nothing goes on the
/// displays until Present. `welcome` is for a table that was just created: the editor
/// continues the new-table wizard.
#[tauri::command]
async fn open_site(app: AppHandle, shell: State<'_, Shell>, path: PathBuf, welcome: Option<bool>) -> Result<(), String> {
    let mut settings = shell.settings();
    let path = ensure_running(&app, &path, settings.lan).await.map_err(text)?;
    settings.opened(&path);
    settings.write(&shell.settings_path()).map_err(text)?;
    open_editor(&app, if welcome == Some(true) { "edit?welcome=1" } else { "edit" }).map_err(text)?;
    close_shell_pages(&app);
    Ok(())
}

/// Starts a new table. With the editor's wizard in the bundle, the editor window opens on
/// it, over the sample site as a backdrop, and `true` is returned. Without it `false` is
/// returned and the Home page asks the first questions itself.
#[tauri::command]
async fn new_table(app: AppHandle, shell: State<'_, Shell>) -> Result<bool, String> {
    let features = std::fs::read_to_string(shell.resources.join("web").join("features.json")).unwrap_or_default();
    let has_wizard = serde_json::from_str::<serde_json::Value>(&features).is_ok_and(|f| f["new_table_wizard"] == true);
    if !has_wizard {
        return Ok(false);
    }
    // The wizard is a page of the host, and a host needs a site. Whatever is open will do.
    if shell.running.lock().unwrap().is_none() {
        let sample = shell.resources.join("sites").join("sample");
        launch(&app, sample, shell.settings().lan).await.map_err(text)?;
    }
    open_editor(&app, "new").map_err(text)?;
    close_shell_pages(&app);
    Ok(true)
}

#[derive(Debug, Deserialize)]
struct NewSite {
    name: String,
    lat: f64,
    lon: f64,
    width_m: f64,
    height_m: f64,
    /// Turns the table clockwise from north. Left out, the table faces north.
    #[serde(default)]
    rotation_deg: f64,
    /// The physical table's width in centimetres, which sets the model scale. Left out, 100 cm.
    #[serde(default)]
    table_width_cm: Option<f64>,
    /// The side of a square 3D-printed tile in centimetres; left out or 0, no tiles.
    #[serde(default)]
    tile_cm: Option<f64>,
}

/// Makes an empty site in the sites folder and returns where. The caller opens it.
#[tauri::command]
fn create_site(shell: State<'_, Shell>, site: NewSite) -> Result<PathBuf, String> {
    let folder = shell.sites_folders.first().ok_or("this computer has no folder to keep sites in")?;
    let name = site.name.trim();
    let id = mrs_site::create::id_from(name);
    if id.is_empty() {
        return Err("Give the site a name with at least one letter or digit.".into());
    }
    let dir = folder.join(&id);
    mrs_site::create::create(&dir, name, site.lon, site.lat, site.width_m, site.height_m, site.rotation_deg).map_err(text)?;
    if let Some(width_cm) = site.table_width_cm {
        let place = mrs_site::Place {
            name: None,
            origin: mrs_site::LonLat { lon: site.lon, lat: site.lat },
            extent: mrs_site::Extent { width_m: site.width_m, height_m: site.height_m, rotation_deg: site.rotation_deg },
            table_width_cm: Some(width_cm),
            tile_cm: site.tile_cm,
        };
        let sized = mrs_site::Site::load(&dir).and_then(|made| made.place(&place));
        if let Err(error) = sized {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(text(error));
        }
    }
    Ok(dir)
}

#[derive(Serialize)]
struct PresentingState {
    version: String,
    site: Option<Running>,
    presenting: bool,
    displays: Vec<Display>,
    /// What Present uses when it is not told otherwise.
    windows: Vec<Assigned>,
    /// `windows` was chosen by hand and still fits; otherwise it is the automatic choice.
    configured: bool,
}

/// What the editor needs to know to offer Present.
#[tauri::command]
fn presenting_state(app: AppHandle, shell: State<'_, Shell>) -> Result<PresentingState, String> {
    let displays = list_displays(&app).map_err(text)?;
    let saved = Displays::read(&shell.displays_path()).unwrap_or(None);
    let configured = saved.as_ref().is_some_and(|s| s.fits(&displays));
    let usual = Displays::usual(saved, &displays);
    let windows = usual.windows.iter().filter_map(|w| {
        let display = w.display.resolve(&displays)?;
        Some(Assigned { display: display.index, role: w.role.clone(), fullscreen: w.fullscreen })
    });
    Ok(PresentingState {
        version: app.package_info().version.to_string(),
        site: shell.running.lock().unwrap().clone(),
        presenting: is_presenting(&app),
        windows: windows.collect(),
        displays,
        configured,
    })
}

/// Saves "Let phones on this network join" and "Present the last table when the app
/// opens" from Displays and settings (#40). A table that is running is restarted on the
/// new network setting, and the editor and the screens follow it.
#[tauri::command]
async fn save_settings(app: AppHandle, shell: State<'_, Shell>, lan: bool, autostart: bool) -> Result<(), String> {
    let mut settings = shell.settings();
    settings.lan = lan;
    settings.autostart = autostart;
    settings.write(&shell.settings_path()).map_err(text)?;
    let running = shell.running.lock().unwrap().clone();
    if let Some(running) = running.filter(|r| r.lan != lan) {
        let presenting = is_presenting(&app);
        ensure_running(&app, &running.site, lan).await.map_err(text)?;
        if app.get_webview_window(EDITOR).is_some() {
            open_editor(&app, "edit").map_err(text)?;
        }
        if presenting {
            show(&app, &usual_displays(&app).map_err(text)?).map_err(text)?;
        }
        // The editor came forward on reloading; the person is still in this window.
        if let Some(settings) = app.get_webview_window(LAUNCHER) {
            settings.set_focus().map_err(text)?;
        }
    }
    Ok(())
}

/// Saves which display shows the table and which the controller, from the editor's
/// Display tab (#188). While the table is presented it moves at once; otherwise the
/// choice waits for Present. An empty list forgets the choice, so the automatic one is used.
#[tauri::command]
async fn save_displays(app: AppHandle, shell: State<'_, Shell>, windows: Vec<Assigned>) -> Result<(), String> {
    let displays = if windows.is_empty() {
        match std::fs::remove_file(shell.displays_path()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(text(e)),
            _ => {}
        }
        usual_displays(&app).map_err(text)?
    } else {
        let displays = chosen_displays(&app, &windows)?;
        displays.write(&shell.displays_path()).map_err(text)?;
        displays
    };
    if is_presenting(&app) {
        show(&app, &displays).map_err(text)?;
    }
    Ok(())
}

/// Puts the open site on the displays. With `windows` the choice is saved first; without,
/// the saved displays are used.
#[tauri::command]
async fn present(app: AppHandle, shell: State<'_, Shell>, windows: Option<Vec<Assigned>>) -> Result<(), String> {
    let displays = match windows {
        Some(windows) => {
            let displays = chosen_displays(&app, &windows)?;
            displays.write(&shell.displays_path()).map_err(text)?;
            displays
        }
        None => usual_displays(&app).map_err(text)?,
    };
    show(&app, &displays).map_err(text)
}

/// Takes the site off the displays. It stays open in the editor.
#[tauri::command]
async fn stop_presenting(app: AppHandle) -> Result<(), String> {
    close_surfaces(&app).map_err(text)
}

/// Shows the Home page: recent tables and New table.
#[tauri::command]
async fn open_home(app: AppHandle) -> Result<(), String> {
    open_home_window(&app).map_err(text)
}

/// Opens one view of the open table (`table`, `tv`, `dev` or `phone`) in a window of its own,
/// or brings it forward: the editor's Preview and "Open in a window". A command, like
/// `present`, rather than `window.open` caught on its way out of the webview, which macOS
/// does not reliably let through (#51).
#[tauri::command]
async fn open_view(app: AppHandle, role: String) -> Result<(), String> {
    show_view(&app, &role).map_err(text)
}

/// Shows the displays and settings window: displays, colour, calibration and updates.
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    open_launcher(&app).map_err(text)
}

/// Shows the Sources page: the services tables read from, their keys and a Test for each.
#[tauri::command]
async fn open_sources(app: AppHandle) -> Result<(), String> {
    open_sources_window(&app).map_err(text)
}

/// The connections (never their keys) and the kinds that can be added.
#[tauri::command]
fn sources_page(shell: State<'_, Shell>) -> serde_json::Value {
    shell.sources.page()
}

/// Adds or changes a connection. A key in it goes to the system keychain and nowhere else.
#[tauri::command]
async fn sources_save(shell: State<'_, Shell>, change: Change) -> Result<mrs_host::sources::View, String> {
    let sources = shell.sources.clone();
    tauri::async_runtime::spawn_blocking(move || sources.save(change)).await.map_err(text)?
}

#[tauri::command]
async fn sources_remove(shell: State<'_, Shell>, id: String) -> Result<(), String> {
    let sources = shell.sources.clone();
    tauri::async_runtime::spawn_blocking(move || sources.remove(&id)).await.map_err(text)?
}

#[tauri::command]
async fn sources_test(shell: State<'_, Shell>, id: String) -> Result<mrs_host::sources::Status, String> {
    let sources = shell.sources.clone();
    sources.test(&id).await
}

/// The File menu, from the editor page's own File button and its keys (#130).
/// `checked` says the page has already made sure nothing is still being saved; without
/// it an action that leaves the table, or Save, is handed to the page to check first.
#[tauri::command]
fn file_action(app: AppHandle, action: String, checked: Option<bool>) -> Result<(), String> {
    if !file_menu::ACTIONS.contains(&action.as_str()) {
        return Err(format!("'{action}' is not a File menu action"));
    }
    if checked == Some(true) {
        perform_file_action(&app, &action);
    } else {
        run_file_action(&app, &action);
    }
    Ok(())
}

/// Runs one File menu action. Off the event loop: windows are opened and closed, and a
/// dialog waits for the person.
fn run_file_action(app: &AppHandle, action: &str) {
    if !app.state::<Shell>().file_debounce.allow(action) {
        return;
    }
    // Save, and anything that leaves the table, goes past the editor page first: it waits for
    // a change still on its way to the host and asks if one could not be saved. It then
    // calls `file_action` with `checked`. Close only when the editor is the window in front.
    if let Some(editor) = app.get_webview_window(EDITOR) {
        let ask = match action {
            "save" | "save_as" | "home" | "open" | "new" => true,
            "close" => editor.is_focused().unwrap_or(false),
            _ => false,
        };
        if ask {
            file_menu::tell_editor(app, EDITOR, json!({ "action": "ask", "then": action }));
            return;
        }
    }
    perform_file_action(app, action);
}

fn perform_file_action(app: &AppHandle, action: &str) {
    let app = app.clone();
    let action = action.to_string();
    tauri::async_runtime::spawn(async move {
        let done = match action.as_str() {
            "new" => {
                let shell = app.state::<Shell>();
                match new_table(app.clone(), shell).await {
                    // Without the editor's wizard, Home asks the first questions.
                    Ok(false) => open_home_window(&app),
                    Ok(true) => Ok(()),
                    Err(e) => Err(anyhow::anyhow!(e)),
                }
            }
            "open" | "home" => open_home_window(&app),
            "settings" => open_launcher(&app),
            // Every change is written as it is made, and the page has checked that nothing is
            // still on its way: Save has nothing left to write. With the revision history
            // (#72) it will also mark a save point here.
            "save" => Ok(()),
            "save_as" => save_as(&app).await,
            "reveal" => {
                let site = app.state::<Shell>().running.lock().unwrap().as_ref().map(|r| r.site.join("site.json"));
                match site {
                    Some(site) => app.opener().reveal_item_in_dir(site).map_err(anyhow::Error::from),
                    None => Ok(()),
                }
            }
            "close" => close_focused(&app),
            other => Err(anyhow::anyhow!("unknown File action '{other}'")),
        };
        if let Err(e) = done {
            tracing::error!("File > {action}: {e:#}");
            file_menu::tell_editor(&app, EDITOR, json!({ "action": "problem", "message": format!("{e:#}") }));
        }
    });
}

/// Close: the editor goes back to Home, as closing a document does; another of the app's
/// own windows just closes. The table and TV windows are left alone (Esc and the way back
/// on them are for that).
fn close_focused(app: &AppHandle) -> anyhow::Result<()> {
    let focused = app.webview_windows().into_iter().find(|(_, w)| w.is_focused().unwrap_or(false));
    match focused {
        Some((label, window)) if label == EDITOR => {
            open_home_window(app)?;
            window.close()?;
        }
        Some((label, window)) if !label.starts_with("surface-") => window.close()?,
        _ => {}
    }
    Ok(())
}

/// Save As: the person names the copy in the system's save dialog, the table's folder is
/// copied there with its own id and name, and the editor switches to the copy. The original
/// stays as it was.
async fn save_as(app: &AppHandle) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    let Some(running) = shell.running.lock().unwrap().clone() else { return Ok(()) };
    let folder = file_menu::default_folder(&running.site, &shell.sites_folders);
    let (send, receive) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Save table as").set_directory(&folder).set_file_name(format!("{} copy", running.name));
    if let Some(window) = app.get_webview_window(EDITOR) {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |path| {
        let _ = send.send(path);
    });
    let Some(target) = receive.await.ok().flatten() else { return Ok(()) };
    let target = target.into_path().context("the chosen place is not a folder on this computer")?;
    let name = file_menu::name_from(&target).context("Give the table a name.")?;
    // The dialog may have added an extension; the folder is named as the table is.
    let target = target.with_file_name(&name);
    file_menu::copy_table(&running.site, &target, &name)?;
    tracing::info!("saved '{}' as '{name}' in {}", running.name, target.display());
    // A copy outside the sites folder is remembered, so Home lists it.
    let mut settings = shell.settings();
    let in_sites_folder = shell.sites_folders.iter().any(|f| target.parent() == Some(f.as_path()));
    let target = sites::canonical(target);
    if !in_sites_folder && !settings.sites.contains(&target) {
        settings.sites.push(target.clone());
        settings.write(&shell.settings_path())?;
    }
    // The editor reloads on the copy, whose name is in its title.
    open_site(app.clone(), app.state::<Shell>(), target, None).await.map_err(|e| anyhow::anyhow!(e))
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

// Colour: the final pass per display. See colour.rs.

#[derive(Serialize)]
struct ColourState {
    displays: Vec<DisplayColour>,
    presets: Vec<Preset>,
    /// The running session's layers; empty when nothing runs.
    layers: Vec<LayerIntensity>,
}

#[derive(Serialize)]
struct LayerIntensity {
    id: String,
    name: String,
    active: bool,
    intensity: f64,
}

#[derive(Serialize)]
struct DisplayColour {
    display: usize,
    name: String,
    /// What is showing on it now, if a session is running: table, tv or dev.
    role: Option<String>,
    colour: Colour,
}

#[derive(Serialize)]
struct Preset {
    name: String,
    built_in: bool,
    colour: Colour,
}

#[tauri::command]
async fn colour_state(app: AppHandle, shell: State<'_, Shell>) -> Result<ColourState, String> {
    let config = ColourConfig::read(&shell.colour_path());
    let surfaces = shell.surfaces.lock().unwrap().clone();
    let connected = list_displays(&app).map_err(text)?;
    let displays = connected.iter().map(|d| DisplayColour {
        display: d.index,
        name: d.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Display {}", d.index + 1)),
        role: surfaces.iter().find(|(_, index)| *index == d.index).and_then(|(label, _)| label.rsplit('-').next().map(str::to_string)),
        colour: config.for_display(d),
    });
    let built_in = colour::built_in_presets().into_iter().map(|(name, colour)| Preset { name: name.into(), built_in: true, colour });
    let saved = config.presets.iter().map(|(name, colour)| Preset { name: name.clone(), built_in: false, colour: colour.clamped() });
    // The host is the authority on layer state, so ask it rather than the file.
    let mut layers = Vec::new();
    if let Some(host) = shell.host.lock().await.as_ref() {
        let welcome = host.state.hub.welcome(0);
        // One row per layer in the scene, top of the stack first. A second copy of a layer is named by its id.
        let manifests = welcome["manifests"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        for id in welcome["state"]["scene"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().rev() {
            let Some(id) = id.as_str() else { continue };
            let state = &welcome["state"]["layers"][id];
            let package = state["layer"].as_str().unwrap_or(id);
            let name = manifests.iter().find(|m| m["id"] == package).and_then(|m| m["name"].as_str()).unwrap_or(package);
            layers.push(LayerIntensity {
                id: id.to_string(),
                name: if id == package { name.to_string() } else { format!("{name} ({id})") },
                active: state["active"].as_bool().unwrap_or(false),
                intensity: state["intensity"].as_f64().unwrap_or(1.0),
            });
        }
    }
    Ok(ColourState { displays: displays.collect(), presets: built_in.chain(saved).collect(), layers })
}

/// Runs a script in every surface window on a display.
fn on_display(app: &AppHandle, display: usize, script: &str) {
    let surfaces = app.state::<Shell>().surfaces.lock().unwrap().clone();
    for (label, _) in surfaces.iter().filter(|(_, index)| *index == display) {
        if let Some(window) = app.get_webview_window(label) {
            report(window.eval(script).map_err(Into::into));
        }
    }
}

/// Saves a display's settings and applies them to what is showing on it.
#[tauri::command]
fn set_colour(app: AppHandle, shell: State<'_, Shell>, display: usize, colour: Colour) -> Result<(), String> {
    let colour = colour.clamped();
    let displays = list_displays(&app).map_err(text)?;
    let target = displays.iter().find(|d| d.index == display).ok_or("that display is no longer connected")?;
    let mut config = ColourConfig::read(&shell.colour_path());
    if colour == Colour::default() {
        config.displays.remove(&colour::key(target));
    } else {
        config.displays.insert(colour::key(target), colour);
    }
    config.write(&shell.colour_path()).map_err(text)?;
    on_display(&app, display, &colour.script());
    Ok(())
}

#[tauri::command]
fn save_preset(shell: State<'_, Shell>, name: String, colour: Colour) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Give the preset a name.".into());
    }
    if colour::built_in_presets().iter().any(|(built_in, _)| built_in.eq_ignore_ascii_case(&name)) {
        return Err(format!("'{name}' is a built-in preset. Choose another name."));
    }
    let mut config = ColourConfig::read(&shell.colour_path());
    config.presets.insert(name, colour.clamped());
    config.write(&shell.colour_path()).map_err(text)
}

#[tauri::command]
fn delete_preset(shell: State<'_, Shell>, name: String) -> Result<(), String> {
    let mut config = ColourConfig::read(&shell.colour_path());
    config.presets.remove(&name);
    config.write(&shell.colour_path()).map_err(text)
}

/// Shows or hides the colour test card on a display's surface.
#[tauri::command]
fn test_card(app: AppHandle, display: usize, on: bool) {
    on_display(&app, display, &format!("window.__mrsTestCard && window.__mrsTestCard({on});"));
}

/// Sets how strongly a layer of the running session is drawn, and remembers it for the site.
#[tauri::command]
async fn set_layer_intensity(shell: State<'_, Shell>, layer: String, intensity: f64) -> Result<(), String> {
    let site = shell.running.lock().unwrap().as_ref().map(|r| r.site_id.clone()).ok_or("Start a session first.")?;
    let host = shell.host.lock().await;
    let hub = &host.as_ref().ok_or("Start a session first.")?.state.hub;
    // The shell acts with the TV's rights; the host clamps and broadcasts.
    hub.request(Role::Tv, 0, "layer.intensity", &json!({ "layer": layer, "intensity": intensity }))?;
    let mut config = ColourConfig::read(&shell.colour_path());
    let saved = config.layers.entry(site.clone()).or_default();
    if (intensity - 1.0).abs() < 1e-6 {
        saved.remove(&layer);
    } else {
        saved.insert(layer, intensity.clamp(0.0, 2.0));
    }
    if config.layers.get(&site).is_some_and(BTreeMap::is_empty) {
        config.layers.remove(&site);
    }
    config.write(&shell.colour_path()).map_err(text)
}

// Calibration: the tool itself lives on the table surface (docs/contracts/model.md).
// The shell only opens and closes it and shows what is saved.

#[derive(Serialize)]
struct CalibrationState {
    /// The running site's name; none when nothing runs.
    site: Option<String>,
    /// A window is showing the table (a table or dev surface), so the tool has somewhere to open.
    table: bool,
    /// The saved projector calibration, or null when the table is shown flat.
    projector: serde_json::Value,
}

/// The surface window that shows the table, if any.
fn table_window(app: &AppHandle) -> Option<WebviewWindow> {
    let surfaces = app.state::<Shell>().surfaces.lock().unwrap().clone();
    let label = |role: &str| surfaces.iter().map(|(label, _)| label).find(|label| label.ends_with(role)).cloned();
    app.get_webview_window(&label("-table").or_else(|| label("-dev"))?)
}

#[tauri::command]
async fn calibration_state(app: AppHandle, shell: State<'_, Shell>) -> Result<CalibrationState, String> {
    let site = shell.running.lock().unwrap().as_ref().map(|r| r.name.clone());
    let projector = match shell.host.lock().await.as_ref() {
        Some(host) => host.state.calibration.projector(),
        None => serde_json::Value::Null,
    };
    Ok(CalibrationState { site, table: table_window(&app).is_some(), projector })
}

/// Opens or closes the calibration tool on the table.
#[tauri::command]
async fn calibration_mode(app: AppHandle, shell: State<'_, Shell>, active: bool) -> Result<(), String> {
    let table = table_window(&app).ok_or("No window is showing the table. Give a display the table on the Setup tab and start.")?;
    let host = shell.host.lock().await;
    host.as_ref().ok_or("Start a session first.")?.state.calibration_request("calibration.mode", &json!({ "active": active }))?;
    if active {
        // The markers are moved with the mouse and the arrow keys in the table window.
        table.set_focus().map_err(text)?;
    }
    Ok(())
}

/// Forgets the saved calibration, so the table is shown flat again.
#[tauri::command]
async fn calibration_clear(shell: State<'_, Shell>) -> Result<(), String> {
    let host = shell.host.lock().await;
    host.as_ref().ok_or("Start a session first.")?.state.calibration_request("calibration.set", &json!({ "projector": null })).map(|_| ())
}

// Updates: what is new comes from the published releases (updates.rs); installing is the
// Tauri updater's job, from the signed files of the latest release.

#[derive(Serialize)]
struct UpdateState {
    current: String,
    /// The app looks for a newer version when it starts.
    automatic: bool,
    /// This build can install an update itself. Otherwise the button opens the download page.
    can_install: bool,
    /// None until the first look has finished.
    available: Option<updates::Available>,
    /// Why the last look failed, for example no internet.
    error: Option<String>,
}

fn current_version(app: &AppHandle) -> semver::Version {
    app.package_info().version.clone()
}

/// Asks for the published releases, remembers the answer and tells the launcher.
async fn look_for_updates(app: &AppHandle) {
    let result = updates::check(&current_version(app)).await.map_err(text);
    match &result {
        Ok(found) => {
            tracing::info!("update check: {}", found.latest.as_deref().map_or("up to date".into(), |v| format!("{v} is available")))
        }
        Err(e) => tracing::warn!("update check failed: {e}"),
    }
    *app.state::<Shell>().updates.lock().unwrap() = Some(result);
    let _ = app.emit_to(LAUNCHER, "updates", ());
}

#[tauri::command]
fn update_state(app: AppHandle, shell: State<'_, Shell>) -> UpdateState {
    let (available, error) = match shell.updates.lock().unwrap().clone() {
        Some(Ok(found)) => (Some(found), None),
        Some(Err(e)) => (None, Some(e)),
        None => (None, None),
    };
    UpdateState {
        current: current_version(&app).to_string(),
        automatic: !shell.settings().skip_update_check,
        can_install: updates::public_key().is_some(),
        available,
        error,
    }
}

#[tauri::command]
async fn check_updates(app: AppHandle) -> Result<(), String> {
    look_for_updates(&app).await;
    Ok(())
}

#[tauri::command]
fn set_update_check(shell: State<'_, Shell>, automatic: bool) -> Result<(), String> {
    let mut settings = shell.settings();
    settings.skip_update_check = !automatic;
    settings.write(&shell.settings_path()).map_err(text)
}

/// Downloads the latest release, checks its signature, installs it and restarts the app.
/// A build without the signing key opens the download page instead.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let Some(key) = updates::public_key() else {
        return app.opener().open_url(updates::DOWNLOAD_PAGE, None::<&str>).map_err(text);
    };
    let feed = std::env::var("MRS_UPDATE_FEED").unwrap_or_else(|_| updates::FEED_URL.into());
    let updater = app.updater_builder().pubkey(key).endpoints(vec![feed.parse().map_err(text)?]).map_err(text)?.build().map_err(text)?;
    let update = updater
        .check()
        .await
        .map_err(text)?
        .ok_or("The newest release has no installer for this computer yet. Try again in a few minutes.")?;
    tracing::info!("installing MR Studio {}", update.version);
    let mut received = 0u64;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                let _ = progress.emit_to(LAUNCHER, "update-progress", json!({ "received": received, "total": total }));
            },
            || {},
        )
        .await
        .map_err(text)?;
    app.restart()
}

/// Opens a link from the release notes in the person's browser.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links are opened.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(text)
}
