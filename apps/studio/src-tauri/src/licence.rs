//! Licences on this computer (#725): the Licence page in Settings, Home's first-run question,
//! the editor's quiet reminder, double-clicked `.mrslicence` files, and the open-source notices.
//! The rules and the files are in the `mrs-licence` crate and docs/licensing.md.
//!
//! Gated: while `mrs_licence::shown()` is false (the default until Sanjay turns licensing on)
//! nothing here shows itself, and no check ever blocks anything. `MRS_LICENSING=preview` shows it.

use super::*;
use mrs_licence::{Day, Status, Store, Use};

pub(crate) fn store(shell: &Shell) -> Store {
    Store::new(&shell.config_dir)
}

pub(crate) fn current(shell: &Shell) -> Status {
    store(shell).status(Day::today())
}

pub(crate) fn is_licence_file(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(mrs_licence::EXTENSION)) && path.is_file()
}

/// The different tables (places) among the tables on this computer (Sanjay, 2026-11-28:
/// copies of a table are the same table).
fn table_count(shell: &Shell) -> usize {
    let settings = shell.settings();
    let sites = sites::discover(&settings.sites, &shell.sites_folders, &shell.resources.join("sites"));
    let keys: Vec<String> = sites
        .iter()
        .filter(|s| s.source != "built in")
        .filter_map(|s| std::fs::read_to_string(s.path.join("site.json")).ok())
        .filter_map(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter_map(|site| mrs_licence::table_key_of(&site))
        .collect();
    mrs_licence::count_tables(keys.iter().map(String::as_str))
}

#[derive(Serialize)]
pub(crate) struct LicenceState {
    #[serde(flatten)]
    status: Status,
    /// Different tables (places) on this computer.
    tables_here: usize,
    /// What the licence would say about them, while nothing is enforced.
    tables_check: mrs_licence::Check,
    /// Whether this build has the open-source notices bundled.
    notices: bool,
    version: String,
}

/// Everything the Licence page and Home show.
#[tauri::command]
pub(crate) fn licence_state(app: AppHandle, shell: State<'_, Shell>) -> LicenceState {
    let status = current(&shell);
    let tables_here = table_count(&shell);
    let tables_check = status.entitlements.check_tables(tables_here);
    LicenceState {
        status,
        tables_here,
        tables_check,
        notices: shell.resources.join(NOTICES).exists(),
        version: app.package_info().version.to_string(),
    }
}

/// Saves the answer to "How will you use MR Studio?".
#[tauri::command]
pub(crate) fn licence_set_use(shell: State<'_, Shell>, kind: String) -> Result<(), String> {
    let kind = Use::parse(&kind).ok_or_else(|| format!("{kind:?} is not a way of using MR Studio."))?;
    store(&shell).set_usage(kind, Day::today()).map_err(text)?;
    tracing::info!("licence: this computer is used for {kind:?}");
    Ok(())
}

/// Adds a licence file: the one given, or one picked in a dialog. Returns the licence's
/// holder, or None when the dialog was closed.
#[tauri::command]
pub(crate) fn licence_add(app: AppHandle, shell: State<'_, Shell>, file: Option<PathBuf>) -> Result<Option<String>, String> {
    let file = match file {
        Some(file) => file,
        None => {
            let picked = app
                .dialog()
                .file()
                .set_title("Add a licence file")
                .add_filter("MR Studio licence", &[mrs_licence::EXTENSION])
                .blocking_pick_file();
            let Some(picked) = picked else { return Ok(None) };
            picked.into_path().map_err(text)?
        }
    };
    add_file(&shell, &file).map(Some)
}

fn add_file(shell: &Shell, file: &Path) -> Result<String, String> {
    let contents = std::fs::read_to_string(file).map_err(|e| format!("{} could not be read: {e}", file.display()))?;
    let licence = store(shell).add(&contents).map_err(text)?;
    tracing::info!("licence {} added", licence.id);
    Ok(licence.holder())
}

#[tauri::command]
pub(crate) fn licence_remove(shell: State<'_, Shell>) -> Result<(), String> {
    store(&shell).remove().map_err(text)?;
    tracing::info!("licence removed");
    Ok(())
}

/// Where the build puts the open-source notices (scripts/third-party-notices.mjs).
const NOTICES: &str = "notices/third-party-notices.json";

/// The open-source notices: every crate and package the app ships, with its licence text.
#[tauri::command]
pub(crate) fn licence_notices(shell: State<'_, Shell>) -> Result<serde_json::Value, String> {
    let path = shell.resources.join(NOTICES);
    let contents = std::fs::read_to_string(&path)
        .map_err(|_| "This copy of MR Studio was built without its open-source notices. Installed releases have them.".to_string())?;
    serde_json::from_str(&contents).map_err(text)
}

/// A double-clicked `.mrslicence` file. It is checked and kept whether or not licensing is
/// shown; while it is shown, Settings opens on the Licence page to say what it covers.
pub(crate) fn opened_licence_file(app: &AppHandle, path: PathBuf) {
    let shell = app.state::<Shell>();
    match add_file(&shell, &path) {
        Ok(holder) => tracing::info!("licence for {holder} added from {}", path.display()),
        Err(e) => {
            tracing::warn!("{} was not added: {e}", path.display());
            *shell.error.lock() = Some(e);
        }
    }
    if mrs_licence::shown() {
        report(open_launcher_at(app, Some("licence")));
    } else {
        report(open_home_window(app));
    }
}

/// The reminder for the editor's banner, when licensing is shown and there is one.
pub(crate) fn editor_reminder(shell: &Shell) -> Option<String> {
    if !mrs_licence::shown() {
        return None;
    }
    current(shell).reminder
}

/// Logs what the licence would say about opening this table, while nothing is enforced.
/// Never blocks: a table that opens, opens.
pub(crate) fn note_opened(shell: &Shell, site: &Path) {
    let status = current(shell);
    let Ok(contents) = std::fs::read_to_string(site.join("site.json")) else { return };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else { return };
    for kind in json["layers"].as_array().into_iter().flatten().filter_map(|l| l["use"].as_str().or(l["id"].as_str())) {
        let _ = status.entitlements.check_layer(kind);
    }
    let _ = status.entitlements.check_tables(table_count(shell));
}

/// The licence facts for Copy diagnostics (#732).
pub(crate) fn diagnostics_line(shell: &Shell) -> String {
    let status = current(shell);
    let id = status.licence.as_ref().map(|l| l.id.as_str()).unwrap_or("none");
    format!(
        "Licence: {id} ({:?}, {:?}), install {}{}",
        status.tier,
        status.state,
        status.install_code,
        if status.shown { "" } else { ", licensing switched off" }
    )
}

/// What goes into an exported table about the licence (#732), while licensing is shown.
pub(crate) fn export_stamp(shell: &Shell) -> Option<serde_json::Value> {
    mrs_licence::shown().then(|| mrs_licence::stamp(&current(shell)))
}

/// Before a table leaves this computer (Export, Share by email): when its data includes files
/// that should stay here (#731), such as SGU data under an FUK agreement, ask first. While
/// licensing is not shown it only logs them.
pub(crate) async fn may_leave(app: &AppHandle, site: &Path, how: &str) -> anyhow::Result<bool> {
    use tauri_plugin_dialog::{MessageDialogButtons as Buttons, MessageDialogKind, MessageDialogResult as Pressed};
    let Ok(loaded) = mrs_site::Site::load(site) else { return Ok(true) };
    let sources = mrs_site::data_sources(&loaded);
    let restricted = mrs_site::restricted(&sources);
    if restricted.is_empty() {
        return Ok(true);
    }
    let lines: Vec<String> = restricted
        .iter()
        .map(|s| match (&s.source, &s.licence) {
            (Some(source), Some(licence)) => format!("{} ({source}, {licence})", s.file),
            (Some(source), None) => format!("{} ({source})", s.file),
            _ => s.file.clone(),
        })
        .collect();
    if !mrs_licence::shown() {
        tracing::info!("{how}: the table holds data marked as not to be shared: {}", lines.join(", "));
        return Ok(true);
    }
    const GO: &str = "Share anyway";
    const STOP: &str = "Cancel";
    let text = format!(
        "This table holds data that its licence says should stay on this computer:\n\n{}\n\nSend it only to someone the licence covers.",
        lines.iter().map(|l| format!("• {l}")).collect::<Vec<_>>().join("\n")
    );
    let asking = app
        .dialog()
        .message(text)
        .title(format!("{how}: data that should not be shared"))
        .kind(MessageDialogKind::Warning)
        .buttons(Buttons::OkCancelCustom(GO.into(), STOP.into()));
    let pressed = tokio::task::spawn_blocking(move || asking.blocking_show_with_result()).await?;
    let go = matches!(&pressed, Pressed::Ok) || matches!(&pressed, Pressed::Custom(label) if label == GO);
    tracing::info!("{how} of a table with restricted data: {}", if go { "went ahead" } else { "cancelled" });
    Ok(go)
}
