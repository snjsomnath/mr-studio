//! Home's Recorded sessions library (#525): the recordings this computer keeps, apart from the
//! tables. A recording is never listed as a table, and nothing here opens the editor.

use super::*;
use tauri_plugin_opener::OpenerExt;

/// Every recording in the app's data folder, newest first.
#[tauri::command]
pub(crate) async fn recordings_list() -> Result<Vec<mrs_host::Catalogue>, String> {
    tokio::task::spawn_blocking(|| mrs_host::list_recordings(&mrs_host::default_recordings_dir())).await.map_err(text)
}

/// Edit details: name, facilitator, purpose, notes and tags.
#[tauri::command]
pub(crate) async fn recording_update(id: String, details: serde_json::Value) -> Result<mrs_host::Catalogue, String> {
    // Chapters are changed in the wrap-up and the playback room, not from Home.
    let mut details = details;
    if let Some(details) = details.as_object_mut() {
        details.remove("chapters");
    }
    mrs_host::edit_recording(&mrs_host::default_recordings_dir(), &id, &details, false)
}

/// Moves a recording, with everything phones sent, to the Trash or Recycle Bin.
#[tauri::command]
pub(crate) async fn recording_delete(id: String) -> Result<(), String> {
    let folder = mrs_host::recording_folder(&mrs_host::default_recordings_dir(), &id)?;
    sites::move_to_trash(&folder).map_err(text)?;
    tracing::info!("moved recording {} to the trash", folder.display());
    Ok(())
}

/// Shows the recording's folder in Finder or Explorer.
#[tauri::command]
pub(crate) async fn recording_reveal(app: AppHandle, id: String) -> Result<(), String> {
    let folder = mrs_host::recording_folder(&mrs_host::default_recordings_dir(), &id)?;
    app.opener().reveal_item_in_dir(folder.join("recording.json")).map_err(text)
}

/// Plays a recording back (#526): a copy of the table it was recorded on, as it was then, runs
/// read only, and the playback room opens on it. The table itself is never opened or changed.
#[tauri::command]
pub(crate) async fn recording_open(app: AppHandle, shell: State<'_, Shell>, id: String) -> Result<(), String> {
    let folder = mrs_host::recording_folder(&mrs_host::default_recordings_dir(), &id)?;
    let catalogue: mrs_host::Catalogue = std::fs::read(folder.join("recording.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or("This recording could not be read.")?;
    let table_id = catalogue.table["id"].as_str().unwrap_or_default();
    let settings = shell.settings();
    let tables = sites::discover(&settings.sites, &shell.sites_folders, &shell.resources.join("sites"));
    // The table's own folder first; the copy that ships with the app only when there is none.
    let table =
        tables.iter().filter(|t| t.id == table_id && t.problem.is_none()).min_by_key(|t| t.source == "built in").ok_or_else(|| {
            let name = catalogue.table["name"].as_str().unwrap_or(table_id);
            format!("The table this was recorded on ({name}) is not on this computer. Add it on Home, then play the recording again.")
        })?;
    let root = read_only_root(&app).ok_or("The app's cache folder could not be found.")?;
    let running = shell.running.lock().as_ref().map(|r| r.site.clone());
    // Earlier playback copies go, except the one running.
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("playback-") && running.as_ref().is_none_or(|r| !r.starts_with(entry.path())) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    let copy = mrs_host::playback_table(&folder, &table.path, &root.join(format!("playback-{stamp}")))?;
    tracing::info!("playing back {} on a copy of {}", folder.display(), table.path.display());
    table::launch_playback(&app, copy, folder).await.map_err(text)?;
    open_editor(&app, "playback").map_err(text)?;
    close_shell_pages(&app);
    Ok(())
}
