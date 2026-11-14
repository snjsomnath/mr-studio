//! Making a new, empty site package.

use std::path::Path;

use serde_json::{json, Value};

use crate::{Site, SiteError, FORMAT};

/// A folder name and site id for a site called `name`: lowercase letters, digits and dashes.
pub fn id_from(name: &str) -> String {
    let mut id = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            id.push(c);
        } else if !id.is_empty() && !id.ends_with('-') {
            id.push('-');
        }
    }
    id.trim_end_matches('-').to_string()
}

/// The `site.json` of a site with nothing in it yet but a base map and sunlight.
pub fn manifest(id: &str, name: &str, lon: f64, lat: f64, width_m: f64, height_m: f64, rotation_deg: f64) -> Value {
    json!({
        "format": FORMAT,
        "id": id,
        "name": name,
        "origin": { "lon": lon, "lat": lat },
        "extent": { "width_m": width_m, "height_m": height_m, "rotation_deg": rotation_deg },
        "timezone": "Europe/Stockholm",
        "table": { "width_cm": 100, "height_cm": (100.0 * height_m / width_m * 100.0).round() / 100.0 },
        "scene": { "cell_m": 1 },
        "basemap": { "background": "#0b0e14", "style": null },
        "layers": [{ "use": "basemap", "active": true }, { "use": "sunlight", "active": true }],
        "branding": { "title": "MR Studio" }
    })
}

/// Creates the site folder `dir`, named after its last part, and checks that it loads.
/// A folder that turns out not to be a valid site is removed again.
pub fn create(dir: &Path, name: &str, lon: f64, lat: f64, width_m: f64, height_m: f64, rotation_deg: f64) -> Result<(), SiteError> {
    let invalid = |message: String| SiteError::Invalid(vec![message]);
    if dir.exists() {
        return Err(invalid(format!("{} already exists", dir.display())));
    }
    let id = dir.file_name().and_then(|n| n.to_str()).map(id_from).filter(|id| !id.is_empty());
    let id = id.ok_or_else(|| invalid("the site folder needs a name with a letter or digit".into()))?;
    if !(lon.is_finite() && lat.is_finite() && (-180.0..=180.0).contains(&lon) && (-90.0..=90.0).contains(&lat)) {
        return Err(invalid("the place needs a latitude between -90 and 90 and a longitude between -180 and 180".into()));
    }
    if !(width_m.is_finite() && height_m.is_finite() && width_m > 0.0 && height_m > 0.0) {
        return Err(invalid("the width and the height must be more than 0 metres".into()));
    }
    let io = |source| SiteError::Io { path: dir.to_path_buf(), source };
    std::fs::create_dir_all(dir.join("data")).map_err(io)?;
    let text = serde_json::to_string_pretty(&manifest(&id, name, lon, lat, width_m, height_m, rotation_deg)).expect("json") + "\n";
    let made = std::fs::write(dir.join("site.json"), text).map_err(io).and_then(|()| Site::load(dir).map(|_| ()));
    if made.is_err() {
        let _ = std::fs::remove_dir_all(dir);
    }
    made
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_ids() {
        assert_eq!(id_from("  Lindholmen Science Park! "), "lindholmen-science-park");
        assert_eq!(id_from("Göteborg_2"), "g-teborg-2");
        assert_eq!(id_from("---"), "");
    }

    #[test]
    fn a_new_site_loads_and_a_bad_one_leaves_nothing_behind() {
        let base = std::env::temp_dir().join(format!("mrs-create-{}", std::process::id()));
        let dir = base.join("new-place");
        create(&dir, "New place", 11.97, 57.69, 1000.0, 600.0, 0.0).unwrap();
        let site = Site::load(&dir).unwrap();
        assert_eq!((site.manifest.id.as_str(), site.manifest.name.as_str()), ("new-place", "New place"));
        assert!(create(&dir, "New place", 11.97, 57.69, 1000.0, 600.0, 0.0).is_err(), "never overwrites");

        let bad = base.join("bad");
        assert!(create(&bad, "Bad", 11.97, 157.0, 1000.0, 600.0, 0.0).is_err());
        assert!(create(&bad, "Bad", 11.97, 57.0, 0.0, 600.0, 0.0).is_err());
        assert!(!bad.exists());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
