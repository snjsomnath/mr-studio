//! Tables: opening `.mrstable` files, starting, stopping and updating the host that runs a
//! table, and the working copy it runs from (#541).

use super::*;

/// Whether a path is a table file (`.mrstable`, #85).
pub(crate) fn is_table_file(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(mrs_site::package::EXTENSION)) && path.is_file()
}

/// A table file to open: Home unpacks it and says what it needs. Home picks it up when it
/// loads, or at once when it is already open.
pub(crate) fn opened_table_file(app: &AppHandle, path: PathBuf) {
    tracing::info!("asked to open {}", path.display());
    *app.state::<Shell>().opened_file.lock() = Some(path);
    match app.get_webview_window(HOME) {
        Some(home) => {
            let _ = home.eval("window.dispatchEvent(new CustomEvent('mrs-opened-file'))");
            report(open_home_window(app));
        }
        None => report(open_home_window(app)),
    }
}

/// The table file waiting for Home, once.
#[tauri::command]
pub(crate) fn take_opened_file(shell: State<'_, Shell>) -> Option<PathBuf> {
    shell.opened_file.lock().take()
}

/// What opening a table file did, for Home to show.
#[derive(Serialize)]
pub(crate) struct ImportedTable {
    path: PathBuf,
    name: String,
    upgraded: Option<String>,
    /// Sources its layers use that are not set up on this computer, or have no key yet.
    missing: Vec<mrs_site::package::SourceNeed>,
    problems: Vec<String>,
    /// True when it replaced an earlier version of the same table (#372).
    updated: bool,
}

/// What Home hears back from `import_table`.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ImportOutcome {
    /// The table is open as a new table, or as the newer version of one.
    Done(ImportedTable),
    /// This computer already has this table (#372): Home asks whether to update it or keep
    /// both, and calls again with `mode`.
    SameTable {
        file: PathBuf,
        name: String,
        existing: PathBuf,
        existing_name: String,
        edited: Option<u64>,
        /// That table is open here, in the editor or on the screens (#401).
        open: bool,
        /// It is on the screens: Home offers to update when the show stops.
        presenting: bool,
    },
    /// The file waits until the show stops (#401).
    Waiting { name: String },
}

/// Opens a `.mrstable` file (#85): asks for one when `file` is not given, unpacks it as a new
/// table in the sites folder and says what this computer still needs for it. `None` when the
/// dialog was cancelled.
///
/// When this computer already has the same table (same id), it first answers `SameTable`.
/// `mode` "update" then replaces that table's content and keeps this computer's calibration,
/// history and kept answers, putting the earlier version in the Trash; "copy" opens it as a
/// second table, as before. When that table is open, "update" stops it, updates it and opens
/// it again (on the screens if it was presenting), and "wait" keeps the file until the show
/// stops (#401).
#[tauri::command]
pub(crate) async fn import_table(
    app: AppHandle,
    shell: State<'_, Shell>,
    file: Option<PathBuf>,
    mode: Option<String>,
) -> Result<Option<ImportOutcome>, String> {
    let file = match file {
        Some(file) => file,
        None => {
            let picked = app
                .dialog()
                .file()
                .set_title("Open a table file")
                .add_filter("MR Studio table", &[mrs_site::package::EXTENSION])
                .blocking_pick_file();
            let Some(picked) = picked else { return Ok(None) };
            picked.into_path().map_err(text)?
        }
    };
    let opened = |e: mrs_site::package::PackageError| format!("That table file could not be opened: {e}");
    let id = {
        let file = file.clone();
        tokio::task::spawn_blocking(move || mrs_site::package::table_id(&file)).await.map_err(text)?.map_err(opened)?
    };
    let settings = shell.settings();
    let same = (!id.is_empty())
        .then(|| sites::discover(&settings.sites, &shell.sites_folders, &shell.resources.join("sites")))
        .and_then(|found| found.into_iter().find(|s| s.id == id && s.problem.is_none() && s.source != "built in"));
    let open = |same: &SiteEntry| shell.running.lock().as_ref().is_some_and(|r| sites::canonical(r.site.clone()) == same.path);
    let imported = match (same, mode.as_deref()) {
        (Some(same), None) => {
            let open = open(&same);
            return Ok(Some(ImportOutcome::SameTable {
                file,
                name: same.name.clone(),
                existing: same.path,
                existing_name: same.name,
                edited: same.edited,
                open,
                presenting: open && is_presenting(&app),
            }));
        }
        (Some(same), Some("wait")) => {
            let waiting = waiting::hold(&shell.config_dir.join("waiting"), &file, &same.path, &same.name).map_err(text)?;
            shell.operator.note(format!("A new version of '{}' waits for the show to stop.", waiting.name));
            return Ok(Some(ImportOutcome::Waiting { name: waiting.name }));
        }
        (Some(same), Some("update")) => {
            let present = open(&same) && is_presenting(&app);
            if present {
                shell.operator.note(format!("Stopped presenting '{}' to update it.", same.name));
            }
            update_table(&app, file, same.path.clone(), present).await.map_err(text)?
        }
        _ => {
            let into = shell.sites_folders.first().cloned().ok_or("This computer has no folder for tables.")?;
            let imported =
                tokio::task::spawn_blocking(move || mrs_site::package::import(&file, &into)).await.map_err(text)?.map_err(opened)?;
            tracing::info!("opened table file as {}", imported.dir.display());
            shell.allow(|allowed| allowed.came_as_file(&sites::canonical(imported.dir.clone())));
            imported
        }
    };
    let missing = mrs_host::missing_sources(&shell.sources, &imported.sources);
    Ok(Some(ImportOutcome::Done(ImportedTable {
        path: sites::canonical(imported.dir),
        name: imported.name,
        upgraded: imported.upgraded,
        missing,
        problems: imported.problems,
        updated: imported.replaced.is_some(),
    })))
}

/// Stops whatever is running, then runs `site`. No window is opened: `show` puts it on
/// the displays and `open_editor` opens it for authoring.
pub(crate) async fn launch(app: &AppHandle, site: PathBuf, lan: bool) -> anyhow::Result<()> {
    launch_with(app, site, lan, None).await
}

/// Runs a recorded session played back (#526): a copy of its table as it was, on this
/// computer only, moved only by the playback room. No programs and no services start.
pub(crate) async fn launch_playback(app: &AppHandle, copy: PathBuf, recording: PathBuf) -> anyhow::Result<()> {
    launch_with(app, copy, false, Some(recording)).await
}

async fn launch_with(app: &AppHandle, site: PathBuf, lan: bool, playback: Option<PathBuf>) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    // One start at a time.
    let mut host = shell.host.lock().await;
    stop_locked(app, &mut host).await?;

    // A site saved by an older version is brought up to this version's format, on disk,
    // with the original kept beside it. A site from a newer version is refused with advice.
    let upgraded = mrs_site::migrate::upgrade_site(&site).map_err(|e| match mrs_site::version::needs_newer(&site) {
        Some(needed) => anyhow::anyhow!(mrs_site::version::update_message(&needed)),
        None => e.into(),
    })?;
    if let Some(done) = upgraded {
        tracing::info!("upgraded {} from site format {} to {}: {}", site.display(), done.from, done.to, done.changes.join("; "));
    }

    // A table changed by a newer MR Studio opens only when someone says so (#509).
    may_open_newer(app, &site).await?;

    // A table from elsewhere runs its own programs only after someone said so (#506). A
    // recording played back runs none (#526).
    let run_programs = playback.is_none() && may_run_programs(app, &site).await?;

    let ip = if lan { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    // Keep the usual port when it is free, so phone links and bookmarks stay valid.
    let port = if std::net::TcpListener::bind(SocketAddr::from((ip, PORT))).is_ok() { PORT } else { 0 };
    let started = mrs_host::start(HostConfig {
        site_dir: site.clone(),
        layers_dir: shell.resources.join("layers"),
        web_dir: Some(shell.resources.join("web")),
        bind: SocketAddr::from((ip, port)),
        backend: Backend::Auto,
        session: mrs_host::SessionOptions { playback, ..Default::default() },
        sources: shell.sources.clone(),
        programs: run_programs,
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
    *shell.running.lock() = Some(running);
    Ok(())
}

/// A table that a newer MR Studio changed (#509). One this version cannot read is refused,
/// naming the version to install. One it can read may still use a layer or a setting from
/// later, so the person is told once and chooses; an error when they cancel.
pub(crate) async fn may_open_newer(app: &AppHandle, site: &Path) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    let site = sites::canonical(site.to_path_buf());
    let Some(needed) = mrs_site::version::needs_newer(&site) else { return Ok(()) };
    let read = {
        let site = site.clone();
        tokio::task::spawn_blocking(move || mrs_site::Site::load(&site)).await?
    };
    if let Err(mrs_site::SiteError::Newer { .. }) = &read {
        anyhow::bail!(mrs_site::version::update_message(&needed));
    }
    if shell.opened_newer.lock().contains(&(site.clone(), needed.clone())) {
        return Ok(());
    }
    let asking = app
        .dialog()
        .message(format!(
            "{}\n\nIt can be opened here, but anything it uses that came after this version will be missing or will not work.",
            mrs_site::version::update_message(&needed)
        ))
        .title(NEWER_TITLE)
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(NEWER_OPEN.into(), NEWER_CANCEL.into()));
    use tauri_plugin_dialog::MessageDialogResult as Pressed;
    let open = match tokio::task::spawn_blocking(move || asking.blocking_show_with_result()).await? {
        Pressed::Ok | Pressed::Yes => true,
        Pressed::Custom(label) => label == NEWER_OPEN,
        _ => false,
    };
    if !open {
        anyhow::bail!(
            "{} was not opened. {}",
            file_menu::name_from(&site).unwrap_or_else(|| "The table".into()),
            mrs_site::version::update_message(&needed)
        );
    }
    shell.operator.note(format!(
        "Opened a table made with MR Studio {} in {}.",
        mrs_site::version::short(&needed),
        mrs_site::version::short(mrs_site::version::THIS)
    ));
    shell.opened_newer.lock().insert((site, needed));
    Ok(())
}

pub(crate) const NEWER_TITLE: &str = "Made with a newer MR Studio";
pub(crate) const NEWER_OPEN: &str = "Open anyway";
pub(crate) const NEWER_CANCEL: &str = "Cancel";

/// Whether the table in `site` runs its own programs (#506): the services the host would start
/// and its layers' code. A table of data, one made here and one already allowed run without
/// a question. Otherwise the person is asked, naming the programs. An error when they cancel.
pub(crate) async fn may_run_programs(app: &AppHandle, site: &Path) -> anyhow::Result<bool> {
    let shell = app.state::<Shell>();
    let site = sites::canonical(site.to_path_buf());
    let found = {
        let site = site.clone();
        tokio::task::spawn_blocking(move || mrs_site::programs::Programs::of(&site)).await?
    };
    if programs::Allowed::read(&shell.programs_path()).allows(&site, &found) {
        return Ok(true);
    }
    if shell.without_programs.lock().get(&site) == Some(&found.fingerprint) {
        return Ok(false);
    }
    let name = std::fs::read_to_string(site.join("site.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|site| site["name"].as_str().filter(|n| !n.trim().is_empty()).map(str::to_string))
        .or_else(|| file_menu::name_from(&site))
        .unwrap_or_else(|| "This table".into());
    let asking = app
        .dialog()
        .message(programs::question(&name, &found))
        .title(programs::TITLE)
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::YesNoCancelCustom(
            programs::RUN.into(),
            programs::WITHOUT.into(),
            programs::CANCEL.into(),
        ));
    use tauri_plugin_dialog::MessageDialogResult as Pressed;
    let answer = match tokio::task::spawn_blocking(move || asking.blocking_show_with_result()).await? {
        Pressed::Yes | Pressed::Ok => programs::Answer::Run,
        Pressed::Custom(label) if label == programs::RUN => programs::Answer::Run,
        Pressed::No => programs::Answer::Without,
        Pressed::Custom(label) if label == programs::WITHOUT => programs::Answer::Without,
        _ => programs::Answer::Cancel,
    };
    match answer {
        programs::Answer::Run => {
            shell.without_programs.lock().remove(&site);
            shell.allow(|allowed| allowed.said_run(&site, &found));
            shell.operator.note(format!("'{name}' may run its own programs on this computer: {}.", found.lines().join("; ")));
            Ok(true)
        }
        programs::Answer::Without => {
            shell.without_programs.lock().insert(site, found.fingerprint.clone());
            shell.operator.note(format!("'{name}' was opened without its own programs: {}.", found.lines().join("; ")));
            Ok(false)
        }
        programs::Answer::Cancel => anyhow::bail!("The table was not opened: its programs were not allowed to run."),
    }
}

/// Stops the running table, with the host's lock held: its screens and views close, and the
/// editor window, which stays, is marked for a reload.
pub(crate) async fn stop_locked(app: &AppHandle, host: &mut Option<RunningHost>) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    close_surfaces(app)?;
    // The editor window stays: it may be the only window, and an app without windows quits.
    // It shows the site that is about to stop, so it is marked for a reload.
    shell.editor_stale.store(true, Ordering::Relaxed);
    for (label, window) in app.webview_windows() {
        if label.starts_with("view-") {
            window.destroy()?;
        }
    }
    *shell.running.lock() = None;
    if let Some(old) = host.take() {
        old.stop(Duration::from_secs(2)).await;
    }
    Ok(())
}

/// Puts the table file `file` in place of the table in `table` (#372), keeping this computer's
/// calibration. When that table is running it stops first and starts again on the new version,
/// back on the screens when `present` and in the editor when the editor is open (#401).
pub(crate) async fn update_table(
    app: &AppHandle,
    file: PathBuf,
    table: PathBuf,
    present: bool,
) -> anyhow::Result<mrs_site::package::Imported> {
    let shell = app.state::<Shell>();
    let was = shell.running.lock().clone().filter(|r| sites::canonical(r.site.clone()) == table);
    if was.is_some() {
        let mut host = shell.host.lock().await;
        stop_locked(app, &mut host).await?;
    }
    let existing = table.clone();
    let updated = tokio::task::spawn_blocking(move || mrs_site::package::update(&file, &existing))
        .await?
        .map_err(|e| anyhow::anyhow!("That table file could not be opened: {e}"))?;
    if let Some(old) = &updated.replaced {
        if let Err(e) = sites::move_to_trash(old) {
            tracing::warn!("the earlier version stays in {}: {e:#}", old.display());
        }
    }
    tracing::info!("updated {} from a table file", table.display());
    shell.allow(|allowed| allowed.came_as_file(&sites::canonical(table.clone())));
    if let Some(was) = was {
        launch(app, was.site.clone(), was.lan).await?;
        if present {
            show(app, &usual_displays(app)?)?;
        }
        if app.get_webview_window(EDITOR).is_some() {
            open_editor(app, "edit")?;
        }
    }
    Ok(updated)
}

/// Applies the version waiting for the show to stop (#401), if there is one. The table starts
/// again if it was running, on the screens when `present`. True when a version was applied.
pub(crate) async fn apply_waiting(app: &AppHandle, present: bool) -> bool {
    let shell = app.state::<Shell>();
    let dir = shell.config_dir.join("waiting");
    let Some(waiting) = waiting::read(&dir) else { return false };
    let result = update_table(app, waiting.file.clone(), waiting.table.clone(), present).await;
    waiting::clear(&dir);
    match result {
        Ok(_) => shell.operator.note(format!("'{}' is updated to the version that waited for the show to stop.", waiting.name)),
        Err(e) => shell.operator.note(format!("The version of '{}' that waited could not be applied: {e:#}", waiting.name)),
    }
    true
}

/// Runs `site` unless it is what is running already, with the same network choice.
/// Returns the folder that runs: `site` itself, or the person's own copy of a built-in one.
pub(crate) async fn ensure_running(app: &AppHandle, site: &Path, lan: bool) -> anyhow::Result<PathBuf> {
    let shell = app.state::<Shell>();
    let site = sites::canonical(working_copy(&shell, site)?);
    let same = |r: &Running| r.lan == lan && r.site == site;
    if !shell.running.lock().as_ref().is_some_and(same) {
        launch(app, site.clone(), lan).await?;
    }
    Ok(site)
}

/// A site that ships inside the app is a starting point, not a place to save: the app
/// folder is replaced by every update and may not be writable. It is copied to the sites
/// folder once, and that copy is what opens from then on.
pub(crate) fn working_copy(shell: &Shell, site: &Path) -> anyhow::Result<PathBuf> {
    let built_in = sites::canonical(shell.resources.join("sites"));
    let site = sites::canonical(site.to_path_buf());
    let (Ok(inside), Some(folder)) = (site.strip_prefix(&built_in), shell.sites_folders.first()) else { return Ok(site) };
    let copy = folder.join(inside);
    if !copy.join("site.json").exists() {
        copy_dir(&site, &copy).with_context(|| format!("copying the example to {}", copy.display()))?;
        tracing::info!("copied the built-in site to {}", copy.display());
        shell.allow(|allowed| allowed.made_here(&sites::canonical(copy.clone())));
    }
    Ok(copy)
}

pub(crate) fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        // The example's revision history (#72) belongs to the example, not the copy.
        if entry.file_name() == ".mrstudio" {
            continue;
        }
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
