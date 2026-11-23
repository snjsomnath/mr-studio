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
        // The table rests on its base map; sunlight is there to open, as a first layer to try.
        "layers": [{ "use": "basemap", "id": "basemap", "active": true }, { "use": "sunlight", "id": "sunlight", "active": false }],
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

    #[test]
    fn a_table_can_be_renamed_moved_resized_and_turned() {
        let base = std::env::temp_dir().join(format!("mrs-place-{}", std::process::id()));
        let dir = base.join("harbour");
        create(&dir, "Harbour", 11.97, 57.69, 1000.0, 600.0, 0.0).unwrap();
        let site = Site::load(&dir).unwrap();
        let place = |name: Option<&str>, lon, lat, w, h, r| crate::Place {
            name: name.map(String::from),
            origin: crate::LonLat { lon, lat },
            extent: crate::Extent { width_m: w, height_m: h, rotation_deg: r },
            table_width_cm: None,
            tile_cm: None,
        };
        let moved = site.place(&place(Some(" Old harbour "), 11.95, 57.70, 1600.0, 1000.0, -30.0)).unwrap();
        assert_eq!(moved.manifest.name, "Old harbour");
        assert_eq!(moved.manifest.origin, crate::LonLat { lon: 11.95, lat: 57.70 });
        assert_eq!(moved.manifest.extent, crate::Extent { width_m: 1600.0, height_m: 1000.0, rotation_deg: 330.0 });
        assert_eq!(moved.manifest.table.unwrap().height_cm, 62.5, "the table keeps its width and takes the new shape");
        assert_eq!(moved.manifest.layers.len(), 2, "everything else is kept");
        let kept = moved.place(&place(None, 11.95, 57.70, 1600.0, 1000.0, 330.0)).unwrap();
        assert_eq!(kept.manifest.name, "Old harbour", "no name keeps the name");
        // A new table width sets the model scale: 1600 m on a 160 cm table is 1 : 1000.
        let wider = kept.place(&crate::Place { table_width_cm: Some(160.0), ..place(None, 11.95, 57.70, 1600.0, 1000.0, 330.0) }).unwrap();
        let table = wider.manifest.table.unwrap();
        assert_eq!((table.width_cm, table.height_cm), (160.0, 100.0));
        assert!(kept.place(&crate::Place { table_width_cm: Some(1.0), ..place(None, 11.95, 57.70, 1600.0, 1000.0, 330.0) }).is_err());
        wider.place(&crate::Place { table_width_cm: Some(100.0), ..place(None, 11.95, 57.70, 1600.0, 1000.0, 330.0) }).unwrap();
        // 1000 × 600 m at 1 : 1250 is an 80 × 48 cm table, printed in 16 cm tiles; 0 drops the tiles.
        let printed = wider
            .place(&crate::Place { table_width_cm: Some(80.0), tile_cm: Some(16.0), ..place(None, 11.95, 57.70, 1000.0, 600.0, 330.0) })
            .unwrap();
        let table = printed.manifest.table.unwrap();
        assert_eq!((table.width_cm, table.height_cm, table.tile_cm), (80.0, 48.0, Some(16.0)));
        let kept_tiles = printed.place(&place(None, 11.95, 57.70, 1000.0, 600.0, 330.0)).unwrap();
        assert_eq!(kept_tiles.manifest.table.unwrap().tile_cm, Some(16.0), "no tile size keeps the tiles");
        let plain = kept_tiles.place(&crate::Place { tile_cm: Some(0.0), ..place(None, 11.95, 57.70, 1000.0, 600.0, 330.0) }).unwrap();
        assert_eq!(plain.manifest.table.unwrap().tile_cm, None);
        plain.place(&crate::Place { table_width_cm: Some(100.0), ..place(None, 11.95, 57.70, 1600.0, 1000.0, 330.0) }).unwrap();

        assert!(site.place(&place(Some(""), 11.95, 57.70, 1000.0, 600.0, 0.0)).is_err());
        assert!(site.place(&place(None, 11.95, 97.0, 1000.0, 600.0, 0.0)).is_err());
        assert!(site.place(&place(None, 11.95, 57.70, 0.0, 600.0, 0.0)).is_err());
        assert_eq!(Site::load(&dir).unwrap().manifest.name, "Old harbour", "a refused change writes nothing");

        // A raw height grid is made for one extent, so the table stays where it is.
        let mut text: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("site.json")).unwrap()).unwrap();
        text["scene"]["terrain"] = serde_json::json!({ "path": "data/terrain.f32", "width": 2, "height": 2 });
        std::fs::write(dir.join("data/terrain.f32"), [0u8; 16]).unwrap();
        std::fs::write(dir.join("site.json"), text.to_string()).unwrap();
        let grid = Site::load(&dir).unwrap();
        let refused = grid.place(&place(None, 11.0, 57.0, 1600.0, 1000.0, 330.0)).unwrap_err().to_string();
        assert!(refused.contains("GeoTIFF"), "{refused}");
        assert!(grid.place(&place(Some("Renamed"), 11.95, 57.70, 1600.0, 1000.0, 330.0)).is_ok(), "renaming alone is fine");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
