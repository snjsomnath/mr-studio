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
