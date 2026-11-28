//! Home's Recorded sessions library (#525): the recordings this computer keeps, apart from the
//! tables. A recording is never listed as a table, and nothing here opens the editor.

use super::*;
use tauri_plugin_dialog::DialogExt;
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
    let catalogue = read_catalogue(&folder)?;
    let table = recording_table(&shell, &folder, &catalogue)?;
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
    let copy = mrs_host::playback_table(&folder, &table, &root.join(format!("playback-{stamp}")))?;
    tracing::info!("playing back {} on a copy of {}", folder.display(), table.display());
    // Calibration and colour are this computer's, for its projector (#528): a table that came
    // inside a .mrsession file uses this computer's calibration of the same table, or none.
    if table.starts_with(&folder) {
        let here = local_table(&shell, catalogue.table["id"].as_str().unwrap_or_default());
        let calibration = here.map(|t| t.join("calibration.json")).filter(|c| c.is_file());
        let into = copy.join("calibration.json");
        let _ = match calibration {
            Some(mine) => std::fs::copy(mine, &into).map(|_| ()),
            None => std::fs::remove_file(&into),
        };
    }
    table::launch_playback(&app, copy, folder).await.map_err(text)?;
    open_editor(&app, "playback").map_err(text)?;
    close_shell_pages(&app);
    Ok(())
}

fn read_catalogue(folder: &Path) -> Result<mrs_host::Catalogue, String> {
    std::fs::read(folder.join("recording.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| "This recording could not be read.".to_string())
}

/// The table a recording plays on: the copy that came inside its .mrsession file (#529), else
/// the table it was recorded on, its own folder before the copy that ships with the app.
fn recording_table(shell: &Shell, folder: &Path, catalogue: &mrs_host::Catalogue) -> Result<PathBuf, String> {
    let inside = folder.join(mrs_site::session_file::TABLE);
    if inside.join("site.json").is_file() {
        return Ok(inside);
    }
    let table_id = catalogue.table["id"].as_str().unwrap_or_default();
    local_table(shell, table_id).ok_or_else(|| {
        let name = catalogue.table["name"].as_str().unwrap_or(table_id);
        format!("The table this was recorded on ({name}) is not on this computer. Add it on Home, then play the recording again.")
    })
}

/// This computer's own copy of the table `id`: its folder before the one that ships with the app.
fn local_table(shell: &Shell, id: &str) -> Option<PathBuf> {
    let settings = shell.settings();
    let tables = sites::discover(&settings.sites, &shell.sites_folders, &shell.resources.join("sites"));
    tables.into_iter().filter(|t| t.id == id && t.problem.is_none()).min_by_key(|t| t.source == "built in").map(|t| t.path)
}

/// Export… (#529): the recording and a frozen copy of its table as one .mrsession file, with
/// or without its videos and large pictures. Answers what was written, or nothing when cancelled.
#[tauri::command]
pub(crate) async fn recording_export(
    app: AppHandle,
    shell: State<'_, Shell>,
    id: String,
    media: bool,
) -> Result<Option<mrs_site::session_file::SessionExported>, String> {
    let folder = mrs_host::recording_folder(&mrs_host::default_recordings_dir(), &id)?;
    let catalogue = read_catalogue(&folder)?;
    let table = recording_table(&shell, &folder, &catalogue)?;
    let name = mrs_site::package::folder_name(&catalogue.name);
    let (send, receive) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export recorded session")
        .set_file_name(format!("{name}.{}", mrs_site::session_file::EXTENSION))
        .add_filter("MR Studio recorded session", &[mrs_site::session_file::EXTENSION]);
    if let Ok(documents) = app.path().document_dir() {
        dialog = dialog.set_directory(documents);
    }
    dialog.save_file(move |path| {
        let _ = send.send(path);
    });
    let Some(out) = receive.await.ok().flatten() else { return Ok(None) };
    let mut out = out.into_path().map_err(|_| "The chosen place is not a folder on this computer.".to_string())?;
    if out.extension().is_none_or(|e| e != mrs_site::session_file::EXTENSION) {
        out.set_extension(mrs_site::session_file::EXTENSION);
    }
    let about = mrs_site::session_file::SessionAbout {
        id: catalogue.id.clone(),
        name: catalogue.name.clone(),
        table_id: catalogue.table["id"].as_str().unwrap_or_default().into(),
        table_name: catalogue.table["name"].as_str().unwrap_or_default().into(),
        app: env!("CARGO_PKG_VERSION").into(),
        ..Default::default()
    };
    let exported = tokio::task::spawn_blocking(move || mrs_site::session_file::export(&folder, &table, &out, about, media))
        .await
        .map_err(text)?
        .map_err(text)?;
    tracing::info!("exported recording {id} to {} ({} bytes)", exported.path.display(), exported.bytes);
    Ok(Some(exported))
}

/// Open a recorded session… (#529): a .mrsession file joins Recorded sessions. Its table copy
/// stays inside the recording: it is never listed with the tables or opened in the editor.
#[tauri::command]
pub(crate) async fn recording_import(app: AppHandle, path: Option<PathBuf>) -> Result<Option<mrs_host::Catalogue>, String> {
    let file = match path {
        Some(path) => path,
        None => {
            let (send, receive) = tokio::sync::oneshot::channel();
            app.dialog()
                .file()
                .set_title("Open a recorded session")
                .add_filter("MR Studio recorded session", &[mrs_site::session_file::EXTENSION])
                .pick_file(move |path| {
                    let _ = send.send(path);
                });
            let Some(file) = receive.await.ok().flatten() else { return Ok(None) };
            file.into_path().map_err(|_| "That file is not on this computer.".to_string())?
        }
    };
    let opened = tokio::task::spawn_blocking(move || mrs_site::session_file::open(&file, &mrs_host::default_recordings_dir()))
        .await
        .map_err(text)?
        .map_err(|e| format!("This recorded session could not be opened: {e}"))?;
    tracing::info!("opened recorded session '{}' into {}", opened.about.name, opened.dir.display());
    read_catalogue(&opened.dir).map(Some)
}
