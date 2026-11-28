//! Home's commands: the list of tables, adding, copying and removing them, starting one on
//! the chosen displays and making a new one (#541).

use super::*;

#[derive(Serialize)]
pub(crate) struct LauncherState {
    version: String,
    sites: Vec<SiteEntry>,
    /// Where to drop site packages so they show up by themselves.
    sites_folder: Option<PathBuf>,
    /// The site to preselect.
    site: Option<PathBuf>,
    displays: Vec<Display>,
    windows: Vec<Assigned>,
    /// The displays were chosen by hand and the choice fits what is connected. Otherwise
    /// `windows` is the automatic choice.
    configured: bool,
    lan: bool,
    autostart: bool,
    /// The nightly restart time, "03:00", or none.
    nightly_restart: Option<String>,
    /// Start in operator mode (#394), and whether an operator PIN is set.
    operator_start: bool,
    operator_pin: bool,
    running: Option<Running>,
    /// Where phones join the running table, when they can: on this network, through the phone
    /// relay or the bridge (#574). None when they cannot.
    join_url: Option<String>,
    /// The running table is a read-only copy (#575).
    read_only: bool,
    /// The running site is on the displays, not only open in the editor.
    presenting: bool,
    /// The name of a table whose newer version waits for the show to stop (#401).
    waiting: Option<String>,
    error: Option<String>,
}

/// A window on a connected display, as the launcher shows and sends it.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Assigned {
    pub(crate) display: usize,
    pub(crate) role: String,
    #[serde(default = "yes")]
    pub(crate) fullscreen: bool,
}

pub(crate) fn yes() -> bool {
    true
}

pub(crate) fn text(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

#[tauri::command]
pub(crate) fn launcher_state(app: AppHandle, shell: State<'_, Shell>) -> Result<LauncherState, String> {
    let settings = shell.settings();
    let displays = list_displays(&app).map_err(text)?;
    let mut error = shell.error.lock().take();
    let saved = Displays::read(&shell.displays_path()).unwrap_or_else(|e| {
        error.get_or_insert(format!("displays.json could not be read ({e}). Choose the displays again."));
        None
    });
    let configured = saved.as_ref().is_some_and(|s| s.fits(&displays));
    let windows = Displays::usual(saved, &displays).windows;
    let assigned = windows.iter().filter_map(|w| {
        let display =
            w.display.resolve(&displays).or_else(|| displays.iter().find(|d| d.primary).filter(|_| w.display == Default::default()))?;
        Some(Assigned { display: display.index, role: w.role.clone(), fullscreen: w.fullscreen })
    });
    let running = shell.running.lock().clone();
    let mut sites = sites::discover(&settings.sites, &shell.sites_folders, &shell.resources.join("sites"));
    // The sites opened last come first; the rest keep their order.
    let recency = |s: &SiteEntry| settings.recent.iter().position(|p| p == &s.path).unwrap_or(usize::MAX);
    sites.sort_by_key(recency);
    // An example that has been opened lives on as the person's own copy; list that one only.
    let own: Vec<_> = sites.iter().filter(|s| s.source != "built in").filter_map(|s| s.path.file_name().map(|n| n.to_owned())).collect();
    sites.retain(|s| s.source != "built in" || s.path.file_name().is_none_or(|n| !own.iter().any(|o| o == n)));
    let usable = |path: &PathBuf| sites.iter().any(|s| &s.path == path && s.problem.is_none());
    let site = running.as_ref().map(|r| r.site.clone()).or(settings.site.clone()).filter(usable);
    Ok(LauncherState {
        version: app.package_info().version.to_string(),
        site: site.or_else(|| sites.iter().find(|s| s.problem.is_none()).map(|s| s.path.clone())),
        sites,
        sites_folder: shell.sites_folders.first().cloned(),
        windows: assigned.collect(),
        displays,
        configured,
        lan: settings.lan,
        // A table that starts by itself is a choice for a finished installation, never the default.
        autostart: settings.autostart,
        nightly_restart: settings.nightly_restart.clone(),
        operator_start: settings.operator_start,
        operator_pin: settings.operator_pin.is_some(),
        join_url: shell.host.try_lock().ok().and_then(|host| host.as_ref().and_then(|h| h.state.hub.session().join_url)),
        read_only: running.as_ref().is_some_and(|r| is_read_only_copy(&app, &r.site)),
        running,
        presenting: is_presenting(&app),
        waiting: waiting::read(&shell.config_dir.join("waiting")).map(|w| w.name),
        error,
    })
}

/// The size and picture of a table, for its card on Home. Separate from `launcher_state`
/// so Home shows the list at once and fills these in as they come.
#[tauri::command]
pub(crate) async fn table_details(path: PathBuf) -> Result<sites::Details, String> {
    tokio::task::spawn_blocking(move || sites::details(&path)).await.map_err(text)
}

/// Shows a table's folder in Finder or Explorer, from its card's menu on Home (#709). Only a
/// folder with a site.json is shown.
#[tauri::command]
pub(crate) async fn table_reveal(app: AppHandle, path: PathBuf) -> Result<(), String> {
    let site = path.join("site.json");
    if !site.is_file() {
        return Err(format!("{} is not a table folder.", path.display()));
    }
    app.opener().reveal_item_in_dir(site).map_err(text)
}

/// Asks for a folder and adds it to the picker. `None` when the dialog was cancelled.
#[tauri::command]
pub(crate) async fn add_site(app: AppHandle, shell: State<'_, Shell>) -> Result<Option<SiteEntry>, String> {
    let Some(folder) = app.dialog().file().set_title("Choose a site folder (the one with site.json)").blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(text)?;
    let entry = sites::describe(path.clone(), "added");
    if let Some(problem) = &entry.problem {
        return Err(format!("{} is not a usable site: {problem}", path.display()));
    }
    let mut settings = shell.settings();
    if !settings.sites.contains(&path) {
        settings.sites.push(path);
        settings.write(&shell.settings_path()).map_err(text)?;
    }
    Ok(Some(entry))
}

#[tauri::command]
pub(crate) fn remove_site(shell: State<'_, Shell>, path: PathBuf) -> Result<(), String> {
    let mut settings = shell.settings();
    settings.sites.retain(|p| p != &path && p.canonicalize().ok().as_ref() != Some(&path));
    settings.write(&shell.settings_path()).map_err(text)
}

/// Duplicate on a Home card (#99): copies the table, an example that comes with the app too,
/// into the folder for tables as "<name> copy", with its own id and without its history.
/// The original stays as it was. Answers the copy's folder; Home lists it.
#[tauri::command]
pub(crate) fn duplicate_table(shell: State<'_, Shell>, path: PathBuf) -> Result<PathBuf, String> {
    let path = sites::canonical(path);
    let site: serde_json::Value = std::fs::read_to_string(path.join("site.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or_else(|| format!("{} is not a table folder (it has no site.json).", path.display()))?;
    let name = site["name"]
        .as_str()
        .filter(|n| !n.trim().is_empty())
        .map(str::to_string)
        .or_else(|| file_menu::name_from(&path))
        .unwrap_or_else(|| "Table".into());
    let folder = file_menu::default_folder(&path, &shell.sites_folders);
    let copy = file_menu::copy_name(&folder, &name);
    let target = folder.join(&copy);
    file_menu::copy_table(&path, &target, &copy).map_err(text)?;
    tracing::info!("duplicated '{name}' as '{copy}' in {}", target.display());
    shell.allow(|allowed| allowed.copied(&path, &sites::canonical(target.clone())));
    // A copy outside the sites folder is remembered, so Home lists it.
    if !shell.sites_folders.iter().any(|f| f == &folder) {
        let mut settings = shell.settings();
        let target = sites::canonical(target.clone());
        if !settings.sites.contains(&target) {
            settings.sites.push(target);
            settings.write(&shell.settings_path()).map_err(text)?;
        }
    }
    Ok(target)
}

/// Deletes a table from Home (#184): its folder goes to the Trash (Mac, Linux) or the Recycle
/// Bin (Windows), where it can be got back. Home asks first. Refused for an example that comes
/// with the app, for a folder without site.json, and for the table that is open in the editor
/// or on the displays. A table that was left but still runs in the background is stopped first.
#[tauri::command]
pub(crate) async fn delete_table(app: AppHandle, shell: State<'_, Shell>, path: PathBuf) -> Result<(), String> {
    let path = sites::canonical(path);
    if !path.join("site.json").is_file() {
        return Err(format!("{} is not a table folder (it has no site.json), so it was not deleted.", path.display()));
    }
    if path.starts_with(sites::canonical(shell.resources.clone())) {
        return Err("The examples come with MR Studio and cannot be deleted.".into());
    }
    let running = shell.running.lock().as_ref().is_some_and(|r| r.site == path);
    if running {
        if app.get_webview_window(EDITOR).is_some() || is_presenting(&app) {
            return Err("This table is open. Close it first (File > Close table), then delete it.".into());
        }
        // Left, but its host still holds the folder: stop it, so the files are free to move.
        let mut host = shell.host.lock().await;
        *shell.running.lock() = None;
        if let Some(old) = host.take() {
            old.stop(Duration::from_secs(2)).await;
        }
    }
    sites::move_to_trash(&path).map_err(text)?;
    tracing::info!("moved {} to the trash", path.display());
    shell.allow(|allowed| allowed.forget(&path));
    let mut settings = shell.settings();
    settings.sites.retain(|p| sites::canonical(p.clone()) != path);
    settings.recent.retain(|p| sites::canonical(p.clone()) != path);
    if settings.site.as_ref().is_some_and(|p| sites::canonical(p.clone()) == path) {
        settings.site = None;
    }
    settings.write(&shell.settings_path()).map_err(text)
}

/// Shows each display's number on it for a few seconds.
#[tauri::command]
pub(crate) async fn identify(app: AppHandle) -> Result<(), String> {
    let mut windows = Vec::new();
    for d in list_displays(&app).map_err(text)? {
        let label = format!("identify-{}", d.index);
        if let Some(old) = app.get_webview_window(&label) {
            let _ = old.destroy();
        }
        let (width, height) = (360.0, 240.0);
        let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(format!("identify.html#{}", d.index + 1).into()))
            .title(format!("Display {}", d.index + 1))
            .inner_size(width, height)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build()
            .map_err(text)?;
        // macOS places windows in points, so a number centred in physical pixels lands on the
        // built-in Retina display when the others are at scale 1 (#611); Present does the same.
        #[cfg(target_os = "macos")]
        {
            let (lx, ly, lw, lh) = logical_frame(&d);
            window.set_position(tauri::LogicalPosition::new(lx + (lw - width) / 2.0, ly + (lh - height) / 2.0)).map_err(text)?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            let x = f64::from(d.x) + (f64::from(d.width) - width * d.scale) / 2.0;
            let y = f64::from(d.y) + (f64::from(d.height) - height * d.scale) / 2.0;
            window.set_position(PhysicalPosition::new(x, y)).map_err(text)?;
        }
        window.show().map_err(text)?;
        windows.push(window);
    }
    tokio::time::sleep(Duration::from_millis(2500)).await;
    for window in windows {
        let _ = window.destroy();
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub(crate) struct StartRequest {
    site: PathBuf,
    windows: Vec<Assigned>,
    lan: bool,
    autostart: bool,
}

/// Saves the choices, puts the site on the displays and closes the launcher.
#[tauri::command]
pub(crate) async fn start(app: AppHandle, shell: State<'_, Shell>, request: StartRequest) -> Result<(), String> {
    let displays = chosen_displays(&app, &request.windows)?;
    displays.write(&shell.displays_path()).map_err(text)?;
    let mut settings = shell.settings();
    settings.lan = request.lan;
    let login_changed = settings.autostart != request.autostart;
    settings.autostart = request.autostart;
    settings.write(&shell.settings_path()).map_err(text)?;
    if login_changed {
        start_with_computer(&app, request.autostart)?;
    }

    // An editor that is open on this site stays open; its changes are already on the table.
    let site = ensure_running(&app, &request.site, request.lan).await.map_err(text)?;
    let mut settings = shell.settings();
    settings.opened(&site);
    settings.write(&shell.settings_path()).map_err(text)?;
    if app.get_webview_window(EDITOR).is_some() {
        open_editor(&app, "edit").map_err(text)?;
    }
    show(&app, &displays).map_err(text)?;
    if let Some(launcher) = app.get_webview_window(LAUNCHER) {
        launcher.close().map_err(text)?;
    }
    Ok(())
}

/// The launcher's or the editor's choice of displays, as it is saved.
pub(crate) fn chosen_displays(app: &AppHandle, windows: &[Assigned]) -> Result<Displays, String> {
    let connected = list_displays(app).map_err(text)?;
    let mut displays = Displays { windows: Vec::new() };
    for window in windows {
        if !WINDOW_ROLES.contains(&window.role.as_str()) {
            return Err(format!("'{}' is not a window role", window.role));
        }
        let display = connected.iter().find(|d| d.index == window.display).ok_or("that display is no longer connected")?;
        displays.windows.push(WindowSpec { role: window.role.clone(), display: display.reference(), fullscreen: window.fullscreen });
    }
    if displays.windows.is_empty() {
        displays = Displays::dev();
    }
    Ok(displays)
}

/// Opens a site in the editor and closes the shell's own pages. Nothing goes on the
/// displays until Present. `welcome` is for a table that was just created: the editor
/// continues the new-table wizard.
#[tauri::command]
pub(crate) async fn open_site(app: AppHandle, shell: State<'_, Shell>, path: PathBuf, welcome: Option<bool>) -> Result<(), String> {
    let mut settings = shell.settings();
    let path = ensure_running(&app, &path, settings.lan).await.map_err(text)?;
    // What the licence would say about this table; it only logs (#726).
    licence::note_opened(&shell, &path);
    settings.opened(&path);
    settings.write(&shell.settings_path()).map_err(text)?;
    open_editor(&app, if welcome == Some(true) { "edit?welcome=1" } else { "edit" }).map_err(text)?;
    close_shell_pages(&app);
    Ok(())
}

/// Where read-only copies are made (#565).
pub(crate) fn read_only_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|dir| dir.join("read-only"))
}

/// The table at `site` is a read-only copy made by Open read-only (#565, #575).
pub fn is_read_only_copy(app: &AppHandle, site: &Path) -> bool {
    read_only_root(app)
        .is_some_and(|root| site.starts_with(&root) || sites::canonical(site.to_path_buf()).starts_with(sites::canonical(root)))
}

/// Opens a table read-only: a copy of it in the app's cache is opened instead, so nothing done
/// in the editor, on the controller or on the phones is saved to the table itself. Earlier
/// read-only copies are thrown away, except one still running. The copy keeps the table's id
/// and calibration, so it presents on the same projector. File › Save As keeps changes as a new table.
#[tauri::command]
pub(crate) async fn open_site_read_only(app: AppHandle, shell: State<'_, Shell>, path: PathBuf) -> Result<(), String> {
    let path = sites::canonical(path);
    if !path.join("site.json").is_file() {
        return Err(format!("{} is not a table folder (it has no site.json).", path.display()));
    }
    let root = read_only_root(&app).ok_or("The app's cache folder could not be found.")?;
    let running = shell.running.lock().as_ref().map(|r| r.site.clone());
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if running.as_ref().is_none_or(|r| !r.starts_with(entry.path())) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    let folder = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "table".into());
    let copy = root.join(format!("{stamp}")).join(folder);
    file_menu::copy_dir(&path, &copy).map_err(|e| format!("Could not make a read-only copy of the table: {e}"))?;
    tracing::info!("opening {} read-only from {}", path.display(), copy.display());
    ensure_running(&app, &copy, shell.settings().lan).await.map_err(text)?;
    open_editor(&app, "edit?readonly=1").map_err(text)?;
    close_shell_pages(&app);
    Ok(())
}

/// Starts a new table. With the editor's wizard in the bundle, the editor window opens on
/// it, over the sample site as a backdrop, and `true` is returned. Without it `false` is
/// returned and the Home page asks the first questions itself.
#[tauri::command]
pub(crate) async fn new_table(app: AppHandle, shell: State<'_, Shell>) -> Result<bool, String> {
    let features = std::fs::read_to_string(shell.resources.join("web").join("features.json")).unwrap_or_default();
    let has_wizard = serde_json::from_str::<serde_json::Value>(&features).is_ok_and(|f| f["new_table_wizard"] == true);
    if !has_wizard {
        return Ok(false);
    }
    // The wizard is a page of the host, and a host needs a site. Whatever is open will do.
    if shell.running.lock().is_none() {
        let sample = shell.resources.join("sites").join("sample");
        launch(&app, sample, shell.settings().lan).await.map_err(text)?;
    }
    open_editor(&app, "new").map_err(text)?;
    close_shell_pages(&app);
    Ok(true)
}

#[derive(Debug, Deserialize)]
pub(crate) struct NewSite {
    name: String,
    lat: f64,
    lon: f64,
    width_m: f64,
    height_m: f64,
    /// Turns the table clockwise from north. Left out, the table faces north.
    #[serde(default)]
    rotation_deg: f64,
    /// The physical table's width in centimetres, which sets the model scale. Left out, 100 cm.
    #[serde(default)]
    table_width_cm: Option<f64>,
    /// The side of a square 3D-printed tile in centimetres; left out or 0, no tiles.
    #[serde(default)]
    tile_cm: Option<f64>,
    /// How fine the analysis grid is (#513); left out, normal.
    #[serde(default)]
    detail: Option<mrs_site::detail::Detail>,
}

/// Makes an empty site in the sites folder and returns where. The caller opens it.
#[tauri::command]
pub(crate) fn create_site(shell: State<'_, Shell>, site: NewSite) -> Result<PathBuf, String> {
    let folder = shell.sites_folders.first().ok_or("this computer has no folder to keep sites in")?;
    let name = site.name.trim();
    let id = mrs_site::create::id_from(name);
    if id.is_empty() {
        return Err("Give the site a name with at least one letter or digit.".into());
    }
    let dir = folder.join(&id);
    mrs_site::create::create(&dir, name, site.lon, site.lat, site.width_m, site.height_m, site.rotation_deg).map_err(text)?;
    if let Some(width_cm) = site.table_width_cm {
        let place = mrs_site::Place {
            name: None,
            origin: mrs_site::LonLat { lon: site.lon, lat: site.lat },
            extent: mrs_site::Extent { width_m: site.width_m, height_m: site.height_m, rotation_deg: site.rotation_deg },
            table_width_cm: Some(width_cm),
            tile_cm: site.tile_cm,
            detail: site.detail,
        };
        let sized = mrs_site::Site::load(&dir).and_then(|made| made.place(&place));
        if let Err(error) = sized {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(text(error));
        }
    }
    shell.allow(|allowed| allowed.made_here(&sites::canonical(dir.clone())));
    Ok(dir)
}
