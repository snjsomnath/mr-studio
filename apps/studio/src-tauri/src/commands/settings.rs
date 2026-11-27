//! Presenting, settings and the shell's views: what is on show, this computer's settings,
//! diagnostics, the command-line tool and the sources window (#541).

use super::*;

#[derive(Serialize)]
pub(crate) struct PresentingState {
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
pub(crate) fn presenting_state(app: AppHandle, shell: State<'_, Shell>) -> Result<PresentingState, String> {
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
        site: shell.running.lock().clone(),
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
pub(crate) async fn save_settings(
    app: AppHandle,
    shell: State<'_, Shell>,
    lan: bool,
    autostart: bool,
    nightly_restart: Option<String>,
) -> Result<(), String> {
    let nightly_restart = nightly_restart.filter(|t| !t.is_empty());
    if let Some(at) = &nightly_restart {
        if chrono::NaiveTime::parse_from_str(at, "%H:%M").is_err() {
            return Err(format!("'{at}' is not a time of day, such as 03:00"));
        }
    }
    let mut settings = shell.settings();
    settings.lan = lan;
    let login_changed = settings.autostart != autostart;
    settings.autostart = autostart;
    settings.nightly_restart = nightly_restart;
    settings.write(&shell.settings_path()).map_err(text)?;
    if login_changed {
        start_with_computer(&app, autostart)?;
    }
    let running = shell.running.lock().clone();
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

/// Makes the app start when someone logs in to this computer, or stops it doing so: a login
/// item on macOS, a startup entry on Windows (#79). Goes with "present the last table by itself".
pub(crate) fn start_with_computer(app: &AppHandle, on: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    let done =
        if on { launcher.enable() } else { launcher.is_enabled().and_then(|enabled| if enabled { launcher.disable() } else { Ok(()) }) };
    match done {
        Ok(()) => {
            app.state::<Shell>().operator.note(if on {
                "MR Studio will start with this computer."
            } else {
                "MR Studio no longer starts with this computer."
            });
            Ok(())
        }
        Err(e) => Err(format!(
            "The setting is saved, but this computer did not let MR Studio {} start with it: {e}",
            if on { "" } else { "stop" }
        )),
    }
}

/// Shows the folder with the operator logs (#79).
#[tauri::command]
pub(crate) fn open_operator_log(app: AppHandle, shell: State<'_, Shell>) -> Result<(), String> {
    let dir = shell.operator.dir().ok_or("This computer has no folder for logs.")?;
    std::fs::create_dir_all(dir).map_err(text)?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(text)
}

/// The diagnostics report (#260), for the editor's Copy diagnostics.
#[tauri::command]
pub(crate) async fn diagnostics_report(app: AppHandle) -> Result<String, String> {
    Ok(diagnostics::report(&app).await)
}

/// Save diagnostics… (#260): the report as a text file.
#[tauri::command]
pub(crate) async fn save_diagnostics(app: AppHandle) -> Result<(), String> {
    diagnostics::save(&app).await.map_err(text)
}

/// Saves which display shows the table and which the controller, from the editor's
/// Display tab (#188). While the table is presented it moves at once; otherwise the
/// choice waits for Present. An empty list forgets the choice, so the automatic one is used.
#[tauri::command]
pub(crate) async fn save_displays(app: AppHandle, shell: State<'_, Shell>, windows: Vec<Assigned>) -> Result<(), String> {
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
pub(crate) async fn present(app: AppHandle, shell: State<'_, Shell>, windows: Option<Vec<Assigned>>) -> Result<(), String> {
    let displays = match windows {
        Some(windows) => {
            let displays = chosen_displays(&app, &windows)?;
            displays.write(&shell.displays_path()).map_err(text)?;
            displays
        }
        None => usual_displays(&app).map_err(text)?,
    };
    // A show starts at rest (#419): the layer the editor had open to work on closes, as the
    // controller's Reset does, and the table plays its opening.
    if let Some(host) = shell.host.lock().await.as_ref() {
        if let Err(e) = host.state.hub.request(Role::Tv, 0, "layers.reset", &json!({})) {
            tracing::warn!("present: reset to rest: {e}");
        }
    }
    show(&app, &displays).map_err(text)
}

/// Takes the site off the displays. It stays open in the editor.
#[tauri::command]
pub(crate) async fn stop_presenting(app: AppHandle) -> Result<(), String> {
    app.state::<Shell>().operator.note("Stopped presenting.");
    close_surfaces(&app).map_err(text)?;
    // A newer version of the table waited for the show to stop (#401).
    apply_waiting(&app, false).await;
    Ok(())
}

/// Home's "Update now" for the version waiting for the show to stop (#401): the show stops,
/// the table updates and goes back on the screens.
#[tauri::command]
pub(crate) async fn update_waiting_now(app: AppHandle) -> Result<(), String> {
    let present = is_presenting(&app);
    apply_waiting(&app, present).await;
    Ok(())
}

/// Shows the Home page: recent tables and New table.
#[tauri::command]
pub(crate) async fn open_home(app: AppHandle) -> Result<(), String> {
    open_home_window(&app).map_err(text)
}

/// Opens one view of the open table (`table`, `tv`, `dev` or `phone`) in a window of its own,
/// or brings it forward: the editor's Preview and "Open in a window". A command, like
/// `present`, rather than `window.open` caught on its way out of the webview, which macOS
/// does not reliably let through (#51).
#[tauri::command]
pub(crate) async fn open_view(app: AppHandle, role: String) -> Result<(), String> {
    show_view(&app, &role).map_err(text)
}

/// Shows File › Settings (#393): this computer's screens, colour, calibration and phones, then
/// the app's updates, command line and sources. `page` opens it at one page.
#[tauri::command]
pub(crate) async fn open_settings(app: AppHandle, page: Option<String>) -> Result<(), String> {
    open_launcher_at(&app, page.as_deref()).map_err(text)
}

/// The Command line page in settings (#370): is `mrstudio` on this computer's PATH.
#[tauri::command]
pub(crate) async fn cli_state() -> Result<cli_tool::CliState, String> {
    tauri::async_runtime::spawn_blocking(cli_tool::state).await.map_err(text)
}

/// Puts `mrstudio` on the PATH; `false` when the password prompt was cancelled.
#[tauri::command]
pub(crate) async fn install_cli() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(cli_tool::install).await.map_err(text)?.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn remove_cli() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(cli_tool::remove).await.map_err(text)?.map_err(|e| format!("{e:#}"))
}

/// MR Studio > Install command line tool… (and File on Windows): installs, then says what
/// happened in a small dialog, since the menu has no page of its own to show it on.
pub(crate) fn install_cli_from_menu(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let (title, message, kind) = match cli_tool::install() {
            Ok(true) => (
                "The mrstudio command is installed",
                if cfg!(windows) {
                    "Open a new terminal window and type: mrstudio --help\n\nTerminals that were already open do not see it yet."
                        .to_string()
                } else {
                    "Open a new Terminal window and type: mrstudio --help\n\nIt stays up to date with the app. Remove it again under Settings, Command line.".to_string()
                },
                tauri_plugin_dialog::MessageDialogKind::Info,
            ),
            Ok(false) => return,
            Err(e) => ("The mrstudio command was not installed", format!("{e:#}"), tauri_plugin_dialog::MessageDialogKind::Error),
        };
        app.state::<Shell>().operator.note(format!("{title}."));
        app.dialog().message(message).title(title).kind(kind).show(|_| {});
    });
}

/// Shows the Sources page: the services tables read from, their keys and a Test for each.
#[tauri::command]
pub(crate) async fn open_sources(app: AppHandle) -> Result<(), String> {
    open_sources_window(&app).map_err(text)
}

/// The connections (never their keys) and the kinds that can be added.
#[tauri::command]
pub(crate) fn sources_page(shell: State<'_, Shell>) -> serde_json::Value {
    shell.sources.page()
}

/// Adds or changes a connection. A key in it goes to the system keychain and nowhere else.
#[tauri::command]
pub(crate) async fn sources_save(shell: State<'_, Shell>, change: Change) -> Result<mrs_host::sources::View, String> {
    let sources = shell.sources.clone();
    tauri::async_runtime::spawn_blocking(move || sources.save(change)).await.map_err(text)?
}

#[tauri::command]
pub(crate) async fn sources_remove(shell: State<'_, Shell>, id: String) -> Result<(), String> {
    let sources = shell.sources.clone();
    tauri::async_runtime::spawn_blocking(move || sources.remove(&id)).await.map_err(text)?
}

#[tauri::command]
pub(crate) async fn sources_test(shell: State<'_, Shell>, id: String) -> Result<mrs_host::sources::Status, String> {
    let sources = shell.sources.clone();
    sources.test(&id).await
}
