//! Home's commands for tables kept in a git repository (#570). See `git_tables`.

use super::*;

/// Get a table from a repository…: clones it into the sites folder; Home lists it from there.
#[tauri::command]
pub(crate) async fn table_from_git(shell: State<'_, Shell>, remote: String) -> Result<SiteEntry, String> {
    let remote = remote.trim().to_string();
    if remote.is_empty() {
        return Err("Paste the repository's address, as its Clone button shows it.".into());
    }
    let into = shell.sites_folders.first().cloned().ok_or("There is no sites folder to keep the table in.")?;
    let path = tokio::task::spawn_blocking(move || git_tables::clone(&remote, &into)).await.map_err(text)??;
    let entry = sites::describe(sites::canonical(path), "sites folder");
    tracing::info!("got table '{}' from a repository into {}", entry.name, entry.path.display());
    Ok(entry)
}

/// What is new in the table's repository. None for a table that does not follow one.
#[tauri::command]
pub(crate) async fn table_git_state(path: PathBuf) -> Result<Option<git_tables::GitState>, String> {
    if !git_tables::follows(&path) {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || Some(git_tables::state(&path))).await.map_err(text)
}

/// Update: the repository's newest version, never while this table is on the screens. A table
/// open in the editor runs again on the new version.
#[tauri::command]
pub(crate) async fn table_git_update(app: AppHandle, shell: State<'_, Shell>, path: PathBuf) -> Result<u32, String> {
    let path = sites::canonical(path);
    let running = shell.running.lock().clone().filter(|r| r.site == path);
    if running.is_some() && is_presenting(&app) {
        return Err("This table is on the screens. Stop presenting, then update it.".into());
    }
    let table = path.clone();
    let taken = tokio::task::spawn_blocking(move || git_tables::update(&table)).await.map_err(text)??;
    if let (Some(running), true) = (running, taken > 0) {
        table::launch(&app, path.clone(), running.lan).await.map_err(text)?;
        app.state::<Shell>().operator.note(format!("'{}' is updated from its repository.", running.name));
    }
    Ok(taken)
}
