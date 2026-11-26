//! Projector calibration: the camera that makes the rendered twin land on the physical model.
//! Kept per machine and site in `<site>/calibration.json` under the `projector` key; other keys
//! in that file are left alone. The surfaces solve and interpret it; the host stores and shares it.

use parking_lot::Mutex;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// An event to broadcast to every surface: its name and payload.
pub type Event = (&'static str, Value);

/// What a controller can ask of the table's calibration tool.
const COMMANDS: &[&str] = &["sync", "back", "next", "skip", "select", "nudge", "model", "save", "flat"];

pub struct Calibration {
    path: PathBuf,
    projector: Mutex<Value>,
}

impl Calibration {
    pub fn load(site_dir: &Path) -> Self {
        let path = site_dir.join("calibration.json");
        let projector = match read(&path) {
            Ok(mut file) => file.remove("projector").unwrap_or(Value::Null),
            Err(e) => {
                tracing::warn!("{}: {e}; starting without a projector calibration", path.display());
                Value::Null
            }
        };
        let projector = match check(&projector) {
            Ok(()) => projector,
            Err(e) => {
                tracing::warn!("{}: projector calibration ignored: {e}", path.display());
                Value::Null
            }
        };
        Self { path, projector: Mutex::new(projector) }
    }

    /// The current calibration, or null when the table is flat.
    pub fn projector(&self) -> Value {
        self.projector.lock().clone()
    }

    /// Replaces the calibration (null clears it) and writes the file.
    pub fn set_projector(&self, projector: &Value) -> Result<(), String> {
        check(projector)?;
        let mut current = self.projector.lock();
        let mut file = read(&self.path).unwrap_or_default();
        if projector.is_null() {
            file.remove("projector");
        } else {
            file.insert("projector".into(), projector.clone());
        }
        let text = serde_json::to_string_pretty(&Value::Object(file)).map_err(|e| e.to_string())? + "\n";
        // In one step (#515): a power cut during the write leaves the earlier calibration, not half of one.
        mrs_site::files::replace(&self.path, text).map_err(|e| format!("could not write {}: {e}", self.path.display()))?;
        *current = projector.clone();
        Ok(())
    }

    /// Handles the `calibration.*` requests. Returns the result and the event to broadcast, if any.
    pub fn request(&self, method: &str, p: &Value) -> Result<(Value, Option<Event>), String> {
        match method {
            "calibration.get" => Ok((json!({ "projector": self.projector() }), None)),
            "calibration.set" => {
                let projector = p.get("projector").ok_or("missing projector")?;
                self.set_projector(projector)?;
                Ok((json!({}), Some(("calibration", json!({ "projector": projector })))))
            }
            // Asks the table surface to open or close its calibration tool, from any controller.
            "calibration.mode" => {
                let active = p["active"].as_bool().ok_or("missing active")?;
                Ok((json!({}), Some(("calibration.mode", json!({ "active": active })))))
            }
            // The table's tool says where it is (which corner, the plan, the fit), so a controller
            // can show the panel the table no longer draws over the map (#594).
            "calibration.state" => {
                if !p.is_object() {
                    return Err("the calibration state must be an object".into());
                }
                Ok((json!({}), Some(("calibration.state", p.clone()))))
            }
            // A controller's press on that panel (next, back, skip, nudge, save...), for the table's tool.
            "calibration.command" => {
                let action = p.get("action").and_then(Value::as_str).ok_or("missing action")?;
                if !COMMANDS.contains(&action) {
                    return Err(format!("unknown calibration action '{action}'"));
                }
                Ok((json!({}), Some(("calibration.command", p.clone()))))
            }
            other => Err(format!("unknown method '{other}'")),
        }
    }
}

/// The file's top-level object, empty when the file does not exist.
fn read(path: &Path) -> Result<Map<String, Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err("expected a JSON object".into()),
            Err(e) => Err(e.to_string()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// A calibration is null, or an object whose `matrix` is the 3 x 4 projection, row by row.
fn check(projector: &Value) -> Result<(), String> {
    if projector.is_null() {
        return Ok(());
    }
    let matrix = projector.get("matrix").and_then(Value::as_array).ok_or("projector.matrix must be an array of 12 numbers")?;
    if matrix.len() != 12 || !matrix.iter().all(|v| v.as_f64().is_some_and(f64::is_finite)) {
        return Err("projector.matrix must be an array of 12 numbers".into());
    }
    let image = &projector["image"];
    let positive = |v: &Value| v.as_f64().is_some_and(|n| n > 0.0);
    if !positive(&image["width"]) || !positive(&image["height"]) {
        return Err("projector.image must give the width and height the matrix was solved for".into());
    }
    Ok(())
}
