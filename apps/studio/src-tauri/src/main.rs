//! MR Studio desktop shell.
//!
//! Runs the host inside this process. A launcher window picks or creates the site and the
//! displays; the editor window authors it; Present opens one window per configured
//! display, each pointed at a surface URL. Surfaces
//! are ordinary pages served by the host, so there are no popups, no browser flags and no
//! permission prompts. Contract in `docs/contracts/session.md`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_tool;
mod colour;
#[cfg(test)]
mod command_permissions;
mod commands;
mod config;
mod diagnostics;
mod file_menu;
#[cfg(windows)]
mod gpu;
mod mail;
#[cfg(windows)]
mod models;
mod operator;
mod operator_mode;
mod programs;
mod screens;
mod sites;
mod startup;
mod table;
mod updates;
mod waiting;
mod watchdog;

use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use colour::{Colour, ColourConfig};
use commands::*;
use config::{Display, Displays, Kind, Settings, WindowSpec, WINDOW_ROLES};
use mrs_engine::Backend;
use mrs_host::sources::{Change, Keychain, Sources};
use mrs_host::{HostConfig, Role, RunningHost};
use screens::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sites::SiteEntry;
use startup::*;
use table::*;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// The first window: recent tables and the way to a new one.
const HOME: &str = "home";
/// Displays, colour, calibration and updates.
const LAUNCHER: &str = "launcher";
/// The Sources page: outside services and their keys (#41). It alone may change them.
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
    /// The table's window covers its display; the controller's Full screen button toggles it (#198).
    table_fullscreen: std::sync::atomic::AtomicBool,
    /// The result of the last look for a newer version.
    updates: Mutex<Option<Result<updates::Available, String>>>,
    /// File menu actions that arrive twice (menu shortcut and page) run once.
    file_debounce: file_menu::Debounce,
    /// Outside services and their keys, shared with every host this app runs.
    sources: Arc<Sources>,
    /// A table file the app was asked to open (a double click, or `mr-studio file.mrstable`)
    /// that Home has not picked up yet.
    opened_file: Mutex<Option<PathBuf>>,
    /// Tables opened without their own programs in this run of the app (#506), with the
    /// programs that were turned down: the question is not asked again until they change or the app restarts.
    without_programs: Mutex<std::collections::HashMap<PathBuf, String>>,
    /// Tables from a newer MR Studio that were opened anyway in this run of the app (#509),
    /// with the version they named: asked once, not at every start.
    opened_newer: Mutex<std::collections::HashSet<(PathBuf, String)>>,
    /// What happened while nobody watched: one file a day for the team (#79).
    operator: operator::OperatorLog,
    /// Operator mode (#394): while it is on, the ways to the editor lead to the operator window.
    operator_mode: operator_mode::OperatorMode,
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

    /// Which tables may run their own programs (#506).
    fn programs_path(&self) -> PathBuf {
        self.config_dir.join("programs.json")
    }

    /// Changes the record of which tables may run their own programs.
    fn allow(&self, change: impl FnOnce(&mut programs::Allowed)) {
        let mut allowed = programs::Allowed::read(&self.programs_path());
        change(&mut allowed);
        if let Err(e) = allowed.write(&self.programs_path()) {
            tracing::warn!("the answer about a table's programs was not saved: {e:#}");
        }
    }
}

fn main() -> anyhow::Result<()> {
    // Before any window: laptops with two graphics chips draw on the fast one (#652).
    #[cfg(windows)]
    gpu::prefer_fast_gpu();
    tauri::Builder::default()
        // A second start (a double click too many) brings up the Home page of the first.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let app = app.clone();
            // Windows and Linux hand a double-clicked table file to a second start.
            let file = args.iter().skip(1).map(PathBuf::from).find(|p| is_table_file(p));
            tauri::async_runtime::spawn(async move {
                match file {
                    Some(file) => opened_table_file(&app, file),
                    None => report(open_home_window(&app)),
                }
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        // Starting with the computer, for a table that runs unattended (#79). The flag marks a
        // start by the system; the saved settings decide what is presented.
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--at-login"])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            launcher_state,
            add_site,
            remove_site,
            delete_table,
            duplicate_table,
            identify,
            start,
            open_site,
            open_site_read_only,
            create_site,
            present,
            stop_presenting,
            update_waiting_now,
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
            dismiss_whats_new,
            open_link,
            file_action,
            starter_pack,
            table_details,
            recordings_list,
            recording_update,
            recording_delete,
            recording_reveal,
            recording_open,
            recording_import,
            recording_export,
            open_sources,
            sources_page,
            sources_save,
            sources_remove,
            sources_test,
            import_table,
            take_opened_file,
            open_operator_log,
            diagnostics_report,
            save_diagnostics,
            cli_state,
            install_cli,
            remove_cli,
            operator_mode::open_operator,
            operator_mode::operator_state,
            operator_mode::operator_present,
            operator_mode::operator_restart_screens,
            operator_mode::operator_set_pin,
            operator_mode::operator_exit,
            operator_mode::operator_password,
            operator_mode::set_operator_start
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if file_menu::ACTIONS.contains(&id) {
                run_file_action(app, id);
            }
            if file_menu::EDIT_ACTIONS.contains(&id) {
                file_menu::tell_editor_edit(app, EDITOR, id);
            }
            if diagnostics::ACTIONS.contains(&id) {
                diagnostics::menu_action(app, id);
            }
            if id == file_menu::INSTALL_CLI {
                install_cli_from_menu(app.clone());
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
                table_fullscreen: Default::default(),
                updates: Mutex::new(None),
                file_debounce: file_menu::Debounce::new(),
                sources: Arc::new(sources),
                opened_file: Mutex::new(None),
                without_programs: Default::default(),
                opened_newer: Default::default(),
                operator: operator::OperatorLog::new(paths.app_log_dir().ok()),
                operator_mode: Default::default(),
            });
            app.state::<Shell>().operator.note(format!("MR Studio {} started.", app.package_info().version));
            // Keeps a presented table running with nobody at the computer (#79).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { watchdog::run(handle).await });
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
        .build(tauri::generate_context!())
        .context("building the app")?
        .run(|app, event| match event {
            // macOS hands a double-clicked table file to the running app as an event.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if is_table_file(&path) {
                            opened_table_file(app, path);
                        }
                    }
                }
            }
            // In operator mode the last window closing, or Quit from the menu, does not end the
            // show: the operator window comes forward and asks for the PIN (#394). An exit the
            // app asks for itself (a restart, an update, Quit with the PIN) has a code and goes.
            tauri::RunEvent::ExitRequested { code: None, api, .. } if app.state::<Shell>().operator_mode.is_on() => {
                api.prevent_exit();
                report(operator_mode::open_window(app));
            }
            tauri::RunEvent::Exit => app.state::<Shell>().operator.note("MR Studio quit."),
            _ => {}
        });
    Ok(())
}

/// Opens a link from the release notes in the person's browser.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links are opened.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(text)
}
