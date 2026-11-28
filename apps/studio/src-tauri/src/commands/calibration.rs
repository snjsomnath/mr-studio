//! Colour and calibration commands: each display's colour, presets, the test card, layer
//! intensity and the calibration mode (#541).

use super::*;

#[derive(Serialize)]
pub(crate) struct ColourState {
    displays: Vec<DisplayColour>,
    presets: Vec<Preset>,
    /// The running session's layers; empty when nothing runs.
    layers: Vec<LayerIntensity>,
}

#[derive(Serialize)]
pub(crate) struct LayerIntensity {
    id: String,
    name: String,
    active: bool,
    intensity: f64,
}

#[derive(Serialize)]
pub(crate) struct DisplayColour {
    display: usize,
    name: String,
    /// What is showing on it now, if a session is running: table, tv or dev.
    role: Option<String>,
    colour: Colour,
    /// The controller's size there, as a share of the designed size (#682).
    size: f64,
}

#[derive(Serialize)]
pub(crate) struct Preset {
    name: String,
    built_in: bool,
    colour: Colour,
}

#[tauri::command]
pub(crate) async fn colour_state(app: AppHandle, shell: State<'_, Shell>) -> Result<ColourState, String> {
    let config = ColourConfig::read(&shell.colour_path());
    let surfaces = shell.surfaces.lock().clone();
    let connected = list_displays(&app).map_err(text)?;
    let displays = connected.iter().map(|d| DisplayColour {
        display: d.index,
        name: d.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Display {}", d.index + 1)),
        role: surfaces.iter().find(|(_, index)| *index == d.index).and_then(|(label, _)| label.rsplit('-').next().map(str::to_string)),
        colour: config.for_display(d),
        size: config.size_for(d),
    });
    let built_in = colour::built_in_presets().into_iter().map(|(name, colour)| Preset { name: name.into(), built_in: true, colour });
    let saved = config.presets.iter().map(|(name, colour)| Preset { name: name.clone(), built_in: false, colour: colour.clamped() });
    // The host is the authority on layer state, so ask it rather than the file.
    let mut layers = Vec::new();
    if let Some(host) = shell.host.lock().await.as_ref() {
        let welcome = host.state.hub.welcome(0);
        // One row per layer in the scene, top of the stack first. A second copy of a layer is named by its id.
        let manifests = welcome["manifests"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        for id in welcome["state"]["scene"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().rev() {
            let Some(id) = id.as_str() else { continue };
            let state = &welcome["state"]["layers"][id];
            let package = state["layer"].as_str().unwrap_or(id);
            let name = manifests.iter().find(|m| m["id"] == package).and_then(|m| m["name"].as_str()).unwrap_or(package);
            layers.push(LayerIntensity {
                id: id.to_string(),
                name: if id == package { name.to_string() } else { format!("{name} ({id})") },
                active: state["active"].as_bool().unwrap_or(false),
                intensity: state["intensity"].as_f64().unwrap_or(1.0),
            });
        }
    }
    Ok(ColourState { displays: displays.collect(), presets: built_in.chain(saved).collect(), layers })
}

/// Runs a script in every surface window on a display.
pub(crate) fn on_display(app: &AppHandle, display: usize, script: &str) {
    let surfaces = app.state::<Shell>().surfaces.lock().clone();
    for (label, _) in surfaces.iter().filter(|(_, index)| *index == display) {
        if let Some(window) = app.get_webview_window(label) {
            report(window.eval(script).map_err(Into::into));
        }
    }
}

/// Saves a display's settings and applies them to what is showing on it.
#[tauri::command]
pub(crate) fn set_colour(app: AppHandle, shell: State<'_, Shell>, display: usize, colour: Colour) -> Result<(), String> {
    let colour = colour.clamped();
    let displays = list_displays(&app).map_err(text)?;
    let target = displays.iter().find(|d| d.index == display).ok_or("that display is no longer connected")?;
    let mut config = ColourConfig::read(&shell.colour_path());
    if colour == Colour::default() {
        config.displays.remove(&colour::key(target));
    } else {
        config.displays.insert(colour::key(target), colour);
    }
    config.write(&shell.colour_path()).map_err(text)?;
    on_display(&app, display, &colour.script());
    Ok(())
}

/// Saves how large the controller is drawn on a display and applies it to what is showing there.
#[tauri::command]
pub(crate) fn set_size(app: AppHandle, shell: State<'_, Shell>, display: usize, size: f64) -> Result<(), String> {
    let size = colour::clamp_size(size);
    let displays = list_displays(&app).map_err(text)?;
    let target = displays.iter().find(|d| d.index == display).ok_or("that display is no longer connected")?;
    let mut config = ColourConfig::read(&shell.colour_path());
    if size == 1.0 {
        config.sizes.remove(&colour::key(target));
    } else {
        config.sizes.insert(colour::key(target), size);
    }
    config.write(&shell.colour_path()).map_err(text)?;
    on_display(&app, display, &colour::size_script(size));
    Ok(())
}

#[tauri::command]
pub(crate) fn save_preset(shell: State<'_, Shell>, name: String, colour: Colour) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Give the preset a name.".into());
    }
    if colour::built_in_presets().iter().any(|(built_in, _)| built_in.eq_ignore_ascii_case(&name)) {
        return Err(format!("'{name}' is a built-in preset. Choose another name."));
    }
    let mut config = ColourConfig::read(&shell.colour_path());
    config.presets.insert(name, colour.clamped());
    config.write(&shell.colour_path()).map_err(text)
}

#[tauri::command]
pub(crate) fn delete_preset(shell: State<'_, Shell>, name: String) -> Result<(), String> {
    let mut config = ColourConfig::read(&shell.colour_path());
    config.presets.remove(&name);
    config.write(&shell.colour_path()).map_err(text)
}

/// Shows or hides the colour test card on a display's surface.
#[tauri::command]
pub(crate) fn test_card(app: AppHandle, display: usize, on: bool) {
    on_display(&app, display, &format!("window.__mrsTestCard && window.__mrsTestCard({on});"));
}

/// Sets how strongly a layer of the running session is drawn, and remembers it for the site.
#[tauri::command]
pub(crate) async fn set_layer_intensity(shell: State<'_, Shell>, layer: String, intensity: f64) -> Result<(), String> {
    let site = shell.running.lock().as_ref().map(|r| r.site_id.clone()).ok_or("Start a session first.")?;
    let host = shell.host.lock().await;
    let hub = &host.as_ref().ok_or("Start a session first.")?.state.hub;
    // The shell acts with the TV's rights; the host clamps and broadcasts.
    hub.request(Role::Tv, 0, "layer.intensity", &json!({ "layer": layer, "intensity": intensity }))?;
    let mut config = ColourConfig::read(&shell.colour_path());
    let saved = config.layers.entry(site.clone()).or_default();
    if (intensity - 1.0).abs() < 1e-6 {
        saved.remove(&layer);
    } else {
        saved.insert(layer, intensity.clamp(0.0, 2.0));
    }
    if config.layers.get(&site).is_some_and(BTreeMap::is_empty) {
        config.layers.remove(&site);
    }
    config.write(&shell.colour_path()).map_err(text)
}

// Calibration: the tool itself lives on the table surface (docs/contracts/model.md).
// The shell only opens and closes it and shows what is saved.

#[derive(Serialize)]
pub(crate) struct CalibrationState {
    /// The running site's name; none when nothing runs.
    site: Option<String>,
    /// A window is showing the table (a table or dev surface), so the tool has somewhere to open.
    table: bool,
    /// The saved projector calibration, or null when the table is shown flat.
    projector: serde_json::Value,
}

/// The surface window that shows the table, if any.
pub(crate) fn table_window(app: &AppHandle) -> Option<WebviewWindow> {
    let surfaces = app.state::<Shell>().surfaces.lock().clone();
    let label = |role: &str| surfaces.iter().map(|(label, _)| label).find(|label| label.ends_with(role)).cloned();
    app.get_webview_window(&label("-table").or_else(|| label("-dev"))?)
}

#[tauri::command]
pub(crate) async fn calibration_state(app: AppHandle, shell: State<'_, Shell>) -> Result<CalibrationState, String> {
    let site = shell.running.lock().as_ref().map(|r| r.name.clone());
    let projector = match shell.host.lock().await.as_ref() {
        Some(host) => host.state.calibration.projector(),
        None => serde_json::Value::Null,
    };
    Ok(CalibrationState { site, table: table_window(&app).is_some(), projector })
}

/// Opens or closes the calibration tool on the table.
#[tauri::command]
pub(crate) async fn calibration_mode(app: AppHandle, shell: State<'_, Shell>, active: bool) -> Result<(), String> {
    let table = table_window(&app).ok_or("No window is showing the table. Give a display the table on the Setup tab and start.")?;
    let host = shell.host.lock().await;
    host.as_ref().ok_or("Start a session first.")?.state.calibration_request("calibration.mode", &json!({ "active": active }))?;
    if active {
        // The markers are moved with the mouse and the arrow keys in the table window.
        table.set_focus().map_err(text)?;
    }
    Ok(())
}

/// Forgets the saved calibration, so the table is shown flat again.
#[tauri::command]
pub(crate) async fn calibration_clear(shell: State<'_, Shell>) -> Result<(), String> {
    let host = shell.host.lock().await;
    host.as_ref().ok_or("Start a session first.")?.state.calibration_request("calibration.set", &json!({ "projector": null })).map(|_| ())
}

// Updates: what is new comes from the published releases (updates.rs); installing is the
// Tauri updater's job, from the signed files of the latest release.
