//! Bringing a 3D model of the site into `scene.mesh`, and placing it again later.
//!
//! The editor reads the file itself to show it against the table while the author scales,
//! turns and moves it; this module checks the file, copies it into `data/` and writes the
//! placement into `site.json`. The host re-bakes afterwards.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::import::write_atomically;
use crate::mesh::{self, Format};
use crate::{LonLat, Site, SiteError, Up};

/// Where a model goes and how it is read: everything in `scene.mesh` but the path.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelPlacement {
    pub anchor: LonLat,
    pub unit_m: f64,
    #[serde(default)]
    pub bearing_deg: f64,
    #[serde(default)]
    pub base_m: f64,
    #[serde(default)]
    pub up: Up,
    #[serde(default)]
    pub mirror: bool,
    /// Set `scene.buildings.extrude`: false when the model, not the footprints, gives the buildings their shape.
    #[serde(default)]
    pub extrude: Option<bool>,
}

/// The file a model is saved as, relative to the site folder.
fn model_path(format: Format) -> String {
    format!("data/model.{}", format.extension())
}

/// Saves `file` (its name and bytes) as the site's model, or with `None` places the model
/// the site already has again. Answers with the site as it is now and the model's triangle count.
pub fn place(site: &Site, file: Option<(&str, &[u8])>, placement: &ModelPlacement) -> Result<(Site, usize), SiteError> {
    let invalid = |message: String| SiteError::Invalid(vec![message]);
    let p = placement;
    if !(p.unit_m > 0.0 && p.unit_m.is_finite()) || !p.bearing_deg.is_finite() || !p.base_m.is_finite() {
        return Err(invalid("the model's scale must be positive, its turn and height numbers".into()));
    }
    let io = |path: &std::path::Path| {
        let path = path.to_path_buf();
        move |source| SiteError::Io { path, source }
    };
    let previous = site.manifest.scene.mesh.as_ref();
    let (relative, triangles) = match file {
        Some((filename, bytes)) => {
            let format = Format::of(filename)
                .ok_or_else(|| invalid(format!("{filename} is not a 3D model MR Studio can read; use STL, OBJ or GLB")))?;
            let triangles = mesh::parse(format, bytes).map_err(|e| invalid(format!("{filename} can't be read: {e}")))?;
            let relative = model_path(format);
            let target = site.dir.join(&relative);
            std::fs::create_dir_all(target.parent().expect("inside data/")).map_err(io(&target))?;
            let temporary = target.with_extension("import.tmp");
            std::fs::write(&temporary, bytes).map_err(io(&temporary))?;
            std::fs::rename(&temporary, &target).map_err(io(&target))?;
            (relative, triangles.len())
        }
        None => {
            let previous = previous.ok_or_else(|| invalid("the table has no 3D model yet; choose a file".into()))?;
            let path = site.resolve(&previous.path).ok_or_else(|| invalid("the model's path leaves the site folder".into()))?;
            let triangles = mesh::read(&path).map_err(|e| invalid(format!("the model can't be read: {e}")))?;
            (previous.path.clone(), triangles.len())
        }
    };

    let manifest_path = site.dir.join("site.json");
    let before = std::fs::read_to_string(&manifest_path).map_err(io(&manifest_path))?;
    let parse = |e: serde_json::Error| SiteError::Parse { path: manifest_path.clone(), message: e.to_string() };
    let mut document: Value = serde_json::from_str(&before).map_err(parse)?;
    let mut entry = json!({
        "path": relative,
        "anchor": { "lon": round(p.anchor.lon, 1e9), "lat": round(p.anchor.lat, 1e9) },
        "unit_m": round(p.unit_m, 1e9),
        "bearing_deg": round(p.bearing_deg, 1e4),
    });
    if p.base_m != 0.0 {
        entry["base_m"] = json!(round(p.base_m, 1e3));
    }
    if p.up == Up::Y {
        entry["up"] = json!("y");
    }
    if p.mirror {
        entry["mirror"] = json!(true);
    }
    if let Some(tolerance) = previous.map(|m| m.ground_tolerance_m).filter(|t| *t != 1.0) {
        entry["ground_tolerance_m"] = json!(tolerance);
    }
    document["scene"]["mesh"] = entry;
    if let (Some(extrude), true) = (p.extrude, document["scene"]["buildings"].is_object()) {
        let buildings = document["scene"]["buildings"].as_object_mut().expect("object");
        if extrude {
            buildings.remove("extrude");
        } else {
            buildings.insert("extrude".into(), json!(false));
        }
    }
    write_atomically(&manifest_path, &(serde_json::to_string_pretty(&document).map_err(parse)? + "\n"))?;
    match Site::load(&site.dir) {
        Ok(updated) => {
            // A model of another format replaced this one: the old file goes.
            if let Some(old) = previous.filter(|m| m.path != relative && m.path.starts_with("data/model.")) {
                let _ = std::fs::remove_file(site.dir.join(&old.path));
            }
            Ok((updated, triangles))
        }
        Err(e) => {
            write_atomically(&manifest_path, &before)?;
            Err(e)
        }
    }
}

/// Takes the model out of the scene. Footprints are raised again, since nothing else gives the buildings their shape.
pub fn remove(site: &Site) -> Result<Site, SiteError> {
    let manifest_path = site.dir.join("site.json");
    let io = |source| SiteError::Io { path: manifest_path.clone(), source };
    let before = std::fs::read_to_string(&manifest_path).map_err(io)?;
    let parse = |e: serde_json::Error| SiteError::Parse { path: manifest_path.clone(), message: e.to_string() };
    let mut document: Value = serde_json::from_str(&before).map_err(parse)?;
    if let Some(scene) = document["scene"].as_object_mut() {
        scene.remove("mesh");
        if let Some(buildings) = scene.get_mut("buildings").and_then(Value::as_object_mut) {
            buildings.remove("extrude");
        }
    }
    write_atomically(&manifest_path, &(serde_json::to_string_pretty(&document).map_err(parse)? + "\n"))?;
    match Site::load(&site.dir) {
        Ok(updated) => Ok(updated),
        Err(e) => {
            write_atomically(&manifest_path, &before)?;
            Err(e)
        }
    }
}

fn round(value: f64, precision: f64) -> f64 {
    (value * precision).round() / precision
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site_with_buildings(name: &str) -> (std::path::PathBuf, Site) {
        let dir = std::env::temp_dir().join(format!("mrs-model-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("data/buildings.geojson"), r#"{"type":"FeatureCollection","features":[]}"#).unwrap();
        let manifest = json!({
            "format": 3, "id": "t", "name": "T",
            "origin": { "lon": 11.97, "lat": 57.69 },
            "extent": { "width_m": 100, "height_m": 60, "rotation_deg": 0 },
            "table": { "width_cm": 100, "height_cm": 60 },
            "scene": { "cell_m": 1, "buildings": { "path": "data/buildings.geojson" } },
            "layers": []
        });
        std::fs::write(dir.join("site.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
        let site = Site::load(&dir).unwrap();
        (dir, site)
    }

    const BOX: &str = "solid b\n facet normal 0 0 1\n outer loop\n vertex 0 0 0.02\n vertex 0.1 0 0.02\n vertex 0.1 0.1 0.02\n endloop\n endfacet\n facet normal 0 0 1\n outer loop\n vertex 0 0 0.02\n vertex 0.1 0.1 0.02\n vertex 0 0.1 0.02\n endloop\n endfacet\nendsolid b\n";

    fn placement() -> ModelPlacement {
        ModelPlacement {
            anchor: LonLat { lon: 11.97, lat: 57.69 },
            unit_m: 100.0,
            bearing_deg: 0.0,
            base_m: 0.0,
            up: Up::Z,
            mirror: false,
            extrude: Some(false),
        }
    }

    #[test]
    fn brings_in_places_again_and_removes() {
        let (dir, site) = site_with_buildings("place");
        let (site, triangles) = place(&site, Some(("Table model.STL", BOX.as_bytes())), &placement()).unwrap();
        assert_eq!(triangles, 2);
        assert!(dir.join("data/model.stl").exists());
        let mesh = site.manifest.scene.mesh.clone().unwrap();
        assert_eq!((mesh.path.as_str(), mesh.unit_m), ("data/model.stl", 100.0));
        assert!(!site.manifest.scene.buildings.as_ref().unwrap().extrude);
        let (_, stats) = site.bake().unwrap();
        assert_eq!(stats.mesh_triangles, 2);
        assert!(stats.mesh_coverage > 0.0);

        // Placed again without a file: turned, Y up and mirrored.
        let again = ModelPlacement { bearing_deg: 90.0, up: Up::Y, mirror: true, extrude: None, ..placement() };
        let (site, _) = place(&site, None, &again).unwrap();
        let mesh = site.manifest.scene.mesh.clone().unwrap();
        assert_eq!((mesh.bearing_deg, mesh.up, mesh.mirror), (90.0, Up::Y, true));
        assert!(!site.manifest.scene.buildings.as_ref().unwrap().extrude, "left as it was");

        let site = remove(&site).unwrap();
        assert!(site.manifest.scene.mesh.is_none());
        assert!(site.manifest.scene.buildings.as_ref().unwrap().extrude);
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        let (_dir, site) = site_with_buildings("refuse");
        assert!(place(&site, Some(("model.fbx", b"x")), &placement()).is_err());
        assert!(place(&site, Some(("model.stl", b"not a mesh")), &placement()).is_err());
        assert!(place(&site, None, &placement()).is_err(), "nothing to place yet");
        assert!(place(&site, Some(("m.stl", BOX.as_bytes())), &ModelPlacement { unit_m: 0.0, ..placement() }).is_err());
    }

    #[test]
    fn orients_y_up_and_mirrored_files() {
        let mesh = crate::Mesh {
            path: "m.glb".into(),
            up: Up::Y,
            mirror: true,
            anchor: LonLat { lon: 0.0, lat: 0.0 },
            unit_m: 1.0,
            bearing_deg: 0.0,
            base_m: 0.0,
            ground_tolerance_m: 1.0,
        };
        // Y up, Z towards the viewer (south): a point 3 up and 2 towards the viewer.
        assert_eq!(mesh.orient([1.0, 3.0, 2.0]), [-1.0, -2.0, 3.0]);
    }
}
