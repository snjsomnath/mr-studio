//! Update commands: what is new, checking and installing updates (#541). The update logic
//! itself is in `updates.rs`.

use super::*;

#[derive(Serialize)]
pub(crate) struct UpdateState {
    current: String,
    /// The app looks for a newer version when it starts.
    automatic: bool,
    /// This build can install an update itself. Otherwise the button opens the download page.
    can_install: bool,
    /// None until the first look has finished.
    available: Option<updates::Available>,
    /// Why the last look failed, for example no internet.
    error: Option<String>,
    /// The commit and time this copy was built from, when known (the build stamp).
    commit: Option<String>,
    built: Option<String>,
    /// The version whose notes were put away on Home.
    seen_notes: Option<String>,
    /// The installer of the newest version for this kind of computer.
    download: Option<String>,
}

pub(crate) fn current_version(app: &AppHandle) -> semver::Version {
    app.package_info().version.clone()
}

/// Asks for the published releases, remembers the answer and tells the launcher.
pub(crate) async fn look_for_updates(app: &AppHandle) {
    let result = updates::check(&current_version(app)).await.map_err(text);
    match &result {
        Ok(found) => {
            tracing::info!("update check: {}", found.latest.as_deref().map_or("up to date".into(), |v| format!("{v} is available")))
        }
        Err(e) => tracing::warn!("update check failed: {e}"),
    }
    *app.state::<Shell>().updates.lock() = Some(result);
    let _ = app.emit_to(LAUNCHER, "updates", ());
    // Home shows what is new too.
    let _ = app.emit_to(HOME, "updates", ());
}

#[tauri::command]
pub(crate) fn update_state(app: AppHandle, shell: State<'_, Shell>) -> UpdateState {
    let (available, error) = match shell.updates.lock().clone() {
        Some(Ok(found)) => (Some(found), None),
        Some(Err(e)) => (None, Some(e)),
        None => (None, None),
    };
    let (commit, built) = updates::build_stamp();
    UpdateState {
        current: current_version(&app).to_string(),
        automatic: !shell.settings().skip_update_check,
        can_install: updates::public_key().is_some(),
        download: available.as_ref().and_then(|a| a.latest.as_deref()).map(updates::download_url),
        available,
        error,
        commit: commit.map(String::from),
        built: built.map(String::from),
        seen_notes: shell.settings().seen_notes,
    }
}

/// Puts away "New in this version" on Home for this version.
#[tauri::command]
pub(crate) fn dismiss_whats_new(app: AppHandle, shell: State<'_, Shell>) -> Result<(), String> {
    let mut settings = shell.settings();
    settings.seen_notes = Some(current_version(&app).to_string());
    settings.write(&shell.settings_path()).map_err(text)
}

#[tauri::command]
pub(crate) async fn check_updates(app: AppHandle) -> Result<(), String> {
    look_for_updates(&app).await;
    Ok(())
}

#[tauri::command]
pub(crate) fn set_update_check(shell: State<'_, Shell>, automatic: bool) -> Result<(), String> {
    let mut settings = shell.settings();
    settings.skip_update_check = !automatic;
    settings.write(&shell.settings_path()).map_err(text)
}

/// Downloads the latest release, checks its signature, installs it and restarts the app.
/// A build without the signing key opens the download page instead.
#[tauri::command]
pub(crate) async fn install_update(app: AppHandle) -> Result<(), String> {
    let Some(key) = updates::public_key() else {
        // No signing key: the browser downloads this computer's installer of the newest version.
        let latest = app.state::<Shell>().updates.lock().clone().and_then(Result::ok).and_then(|a| a.latest);
        let url = latest.as_deref().map_or_else(|| updates::DOWNLOAD_PAGE.to_string(), updates::download_url);
        return app.opener().open_url(url, None::<&str>).map_err(text);
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
