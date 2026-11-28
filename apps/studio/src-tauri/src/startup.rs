//! Starting the app: logging, what opens first, and reporting a step that went wrong (#541).

use super::*;

/// In a release build there is no console (on Windows not even a hidden one), so log to a file.
pub(crate) fn init_logging(log_dir: Option<&Path>) {
    let file = log_dir.filter(|_| !cfg!(debug_assertions)).and_then(|dir| {
        std::fs::create_dir_all(dir).ok()?;
        std::fs::File::create(dir.join("mr-studio.log")).ok()
    });
    match file {
        Some(file) => tracing_subscriber::fmt().with_target(false).with_ansi(false).with_writer(std::sync::Mutex::new(file)).init(),
        None => tracing_subscriber::fmt().with_target(false).init(),
    }
}

/// What to do when the app starts:
/// - `mr-studio <site folder>` (or MRS_SITE) runs that site straight away;
/// - `mr-studio --setup` shows the displays and settings window;
/// - otherwise the last site starts on the saved displays if the settings say so, and
///   the Home page opens if not.
pub(crate) async fn startup(app: AppHandle) {
    let shell = app.state::<Shell>();
    // A newer version that waited for a show that ended with the app (#401) is applied first.
    apply_waiting(&app, false).await;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let setup = args.iter().any(|a| a == "--setup");
    let explicit = args.iter().find(|a| !a.starts_with('-')).cloned().or_else(|| std::env::var("MRS_SITE").ok()).map(PathBuf::from);
    let settings = shell.settings();
    let saved = Displays::read(&shell.displays_path()).unwrap_or_else(|e| {
        tracing::error!("displays.json: {e}");
        None
    });

    // `mr-studio Lindholmen.mrstable` (a double click on Windows): Home opens the file.
    let (explicit, file) = match explicit {
        Some(path) if path.extension().is_some_and(|e| e.eq_ignore_ascii_case(mrs_site::package::EXTENSION)) => (None, Some(path)),
        other => (other, None),
    };
    if let Some(file) = file {
        *shell.opened_file.lock() = Some(file);
    }
    // `mr-studio Universeum.mrslicence` (#727): the licence is checked and kept, then the app
    // starts as it would have.
    let explicit = match explicit {
        Some(path) if path.extension().is_some_and(|e| e.eq_ignore_ascii_case(mrs_licence::EXTENSION)) => {
            licence::opened_licence_file(&app, path);
            return;
        }
        other => other,
    };
    // Operator mode (#394): the last table goes on the screens and the operator window stands
    // in for the editor. Shift held at the start asks for this computer's password instead.
    let operator = settings.operator_start && !setup;
    let shift = operator && operator_mode::shift_held();
    if operator {
        shell.operator_mode.set(true);
        shell.operator.note(if shift { "Started in operator mode with Shift held." } else { "Started in operator mode." });
    }
    if shift {
        report(operator_mode::open_window_at(&app, "shift"));
        return;
    }
    let site = match (setup, explicit, &saved) {
        (true, _, _) => None,
        (false, Some(site), _) => Some(site),
        (false, None, _) if operator => settings.site.clone(),
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
                *shell.error.lock() = Some(format!("{e:#}"));
            }
        }
    }
    let opened = if setup { open_launcher(&app) } else { open_home_window(&app) };
    if let Err(e) = opened {
        tracing::error!("could not open the first window: {e:#}");
        app.exit(1);
    }
}

pub(crate) fn report(result: anyhow::Result<()>) {
    if let Err(e) = result {
        tracing::error!("{e:#}");
    }
}
