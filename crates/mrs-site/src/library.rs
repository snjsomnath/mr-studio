//! Everything a table has to show, in one list (#306): the datasets named in `site.json`
//! `data`, the pictures and video under `data/media/`, the sounds under `data/sounds/`, and
//! the 3D model. The editor's Media tab lists it, and every setting that names a file picks
//! from it instead of having the name typed.

use std::path::Path;

use crate::Site;

/// One thing in the table's folder.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Item {
    /// `map` (GeoJSON), `table` (CSV), `raster` (GeoTIFF, or a folder of them), `drawing` (SVG),
    /// `picture`, `video`, `sound`, `model` (the 3D model) or `data` (any other file, such as trips).
    pub kind: &'static str,
    /// The dataset name layers know it by, when it is one of `site.json` `data`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Relative to the site folder, served under `/site/`.
    pub path: String,
    /// The file's size; none for a folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// Named in `site.json` but not in the folder.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

/// What kind of thing a file is, by its name. A dataset's name helps for JSON that is not GeoJSON.
pub fn kind_of(path: &str, name: Option<&str>) -> &'static str {
    let extension = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "geojson" => "map",
        "json" if matches!(name, Some("trips" | "slideshow")) => "data",
        "json" => "map",
        "csv" | "tsv" => "table",
        "tif" | "tiff" => "raster",
        "svg" => "drawing",
        "png" | "jpg" | "jpeg" | "webp" | "gif" => "picture",
        "mp4" | "webm" | "mov" | "m4v" => "video",
        "mp3" | "wav" | "ogg" | "m4a" => "sound",
        "glb" | "gltf" | "obj" | "ply" | "stl" | "3dm" | "fbx" => "model",
        "" => "raster",
        _ => "data",
    }
}

fn item(dir: &Path, kind: &'static str, name: Option<String>, path: String) -> Item {
    let meta = std::fs::metadata(dir.join(&path)).ok();
    Item { kind, name, bytes: meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()), missing: meta.is_none(), path }
}

/// The table's media: datasets first, by name, then the files no dataset names, by path.
pub fn list(site: &Site) -> Vec<Item> {
    let dir = &site.dir;
    let mut out: Vec<Item> = Vec::new();
    // The scene's buildings, ground and trees count as datasets too, by these names.
    let scene = &site.manifest.scene;
    let mut named: Vec<(String, String)> = Vec::new();
    if let Some(b) = &scene.buildings {
        named.push(("buildings".into(), b.path.clone()));
    }
    if let Some(t) = &scene.terrain {
        named.push(("terrain".into(), t.path.clone()));
    }
    if let Some(t) = &scene.trees {
        named.push(("trees".into(), t.path.clone()));
    }
    if let Some(w) = &scene.water {
        named.push(("water".into(), w.path.clone()));
    }
    if let Some(c) = &scene.context {
        named.push(("context".into(), c.path.clone()));
    }
    for (name, path) in &site.manifest.data {
        if !named.iter().any(|(n, _)| n == name) {
            named.push((name.clone(), path.clone()));
        }
    }
    named.sort();
    for (name, path) in &named {
        let path = path.trim_start_matches("./").to_string();
        let kind =
            if dir.join(&path).is_dir() || name == "terrain" || (name == "water" && scene.water.as_ref().is_some_and(|w| w.is_geotiff())) {
                "raster"
            } else {
                kind_of(&path, Some(name))
            };
        out.push(item(dir, kind, Some(name.clone()), path));
    }
    let named: std::collections::HashSet<String> = out.iter().map(|i| i.path.clone()).collect();
    let mut files: Vec<Item> = crate::media::list(dir)
        .into_iter()
        .chain(crate::sound::list(dir))
        .filter(|p| !named.contains(p))
        .map(|p| item(dir, kind_of(&p, None), None, p))
        .collect();
    if let Some(mesh) = &site.manifest.scene.mesh {
        let path = mesh.path.trim_start_matches("./").to_string();
        if !named.contains(&path) {
            files.push(item(dir, "model", None, path));
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    out.extend(files);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_by_name() {
        assert_eq!(kind_of("data/buildings.geojson", Some("buildings")), "map");
        assert_eq!(kind_of("data/trips.json", Some("trips")), "data");
        assert_eq!(kind_of("data/plan.SVG", None), "drawing");
        assert_eq!(kind_of("data/media/aerial.jpg", None), "picture");
        assert_eq!(kind_of("data/media/walk.mp4", None), "video");
        assert_eq!(kind_of("data/sounds/birds.mp3", None), "sound");
        assert_eq!(kind_of("data/model.glb", None), "model");
        assert_eq!(kind_of("data/pet", Some("pet")), "raster");
    }
}
