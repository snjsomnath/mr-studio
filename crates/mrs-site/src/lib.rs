//! MR Studio site packages: `site.json`, validation and scene baking.
//! Contract in `docs/contracts/site.md`.

mod bake;
mod manifest;
mod projection;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use mrs_engine::{Grid, SceneData};
use serde::Serialize;
use thiserror::Error;

pub use bake::BakeStats;
pub use manifest::*;
pub use projection::Projection;

/// The site format this build reads.
pub const FORMAT: u32 = 1;

#[derive(Debug, Error)]
pub enum SiteError {
    #[error("{path}: {source}")]
    Io { path: PathBuf, source: std::io::Error },
    #[error("{path}: {message}")]
    Parse { path: PathBuf, message: String },
    #[error("site is not valid:\n  {}", .0.join("\n  "))]
    Invalid(Vec<String>),
}

/// A loaded site package.
#[derive(Debug, Clone)]
pub struct Site {
    pub dir: PathBuf,
    pub manifest: SiteManifest,
}

/// What surfaces need to know about the site.
#[derive(Debug, Clone, Serialize)]
pub struct SiteInfo {
    pub id: String,
    pub name: String,
    pub origin: LonLat,
    pub extent: Extent,
    pub grid: Grid,
    /// Extent corners in WGS84 `[lon, lat]`: top left, top right, bottom right, bottom left.
    pub corners: [[f64; 2]; 4],
    pub timezone: Option<String>,
    pub table: Option<Table>,
    pub basemap: Basemap,
    pub branding: Branding,
    /// Datasets layers may read, by name, as site-relative paths served under `/site/`.
    /// Holds the scene's `buildings` and `trees` and everything in the manifest's `data`.
    pub data: BTreeMap<String, String>,
}

impl Site {
    pub fn load(dir: impl AsRef<Path>) -> Result<Self, SiteError> {
        let dir = dir.as_ref().to_path_buf();
        let path = dir.join("site.json");
        let text = std::fs::read_to_string(&path).map_err(|source| SiteError::Io { path: path.clone(), source })?;
        let manifest: SiteManifest =
            serde_json::from_str(&text).map_err(|e| SiteError::Parse { path: path.clone(), message: e.to_string() })?;
        let site = Self { dir, manifest };
        let problems = site.problems();
        if problems.is_empty() {
            Ok(site)
        } else {
            Err(SiteError::Invalid(problems))
        }
    }

    /// Everything wrong with the manifest, in the user's terms. Empty when valid.
    pub fn problems(&self) -> Vec<String> {
        let m = &self.manifest;
        let mut out = Vec::new();
        if m.format != FORMAT {
            out.push(format!("format is {}, this app reads format {FORMAT}", m.format));
        }
        if m.id.is_empty() || !m.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            out.push("id must be lowercase letters, digits and dashes".into());
        }
        if !(-180.0..=180.0).contains(&m.origin.lon) || !(-85.0..=85.0).contains(&m.origin.lat) {
            out.push("origin must be a WGS84 lon/lat".into());
        }
        if !(m.extent.width_m > 0.0 && m.extent.height_m > 0.0) {
            out.push("extent width_m and height_m must be positive".into());
        }
        if !(m.scene.cell_m > 0.0) {
            out.push("scene.cell_m must be positive".into());
        } else {
            let cells = (m.extent.width_m / m.scene.cell_m) * (m.extent.height_m / m.scene.cell_m);
            if cells > 64e6 {
                out.push(format!("scene grid would have {:.0} million cells; raise scene.cell_m", cells / 1e6));
            }
        }
        if let Some(table) = &m.table {
            let (site_aspect, table_aspect) = (m.extent.width_m / m.extent.height_m, table.width_cm / table.height_cm);
            if (site_aspect / table_aspect - 1.0).abs() > 0.02 {
                out.push(format!("extent aspect {site_aspect:.3} does not match the table's {table_aspect:.3}"));
            }
        }
        let check = |out: &mut Vec<String>, label: &str, path: &str| match self.resolve(path) {
            None => out.push(format!("{label}: '{path}' must be a relative path inside the site folder")),
            Some(full) if !full.exists() => out.push(format!("{label}: '{path}' does not exist")),
            _ => {}
        };
        if let Some(b) = &m.scene.buildings {
            check(&mut out, "scene.buildings.path", &b.path);
        }
        if let Some(t) = &m.scene.trees {
            check(&mut out, "scene.trees.path", &t.path);
        }
        if let Some(t) = &m.scene.terrain {
            check(&mut out, "scene.terrain.path", &t.path);
            if let Some(full) = self.resolve(&t.path).filter(|p| p.exists()) {
                let expected = t.width as u64 * t.height as u64 * 4;
                let actual = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
                if actual != expected {
                    out.push(format!("scene.terrain: {} is {actual} bytes, {}x{} f32 needs {expected}", t.path, t.width, t.height));
                }
            }
        }
        for (name, path) in &m.data {
            check(&mut out, &format!("data.{name}"), path);
        }
        let mut seen = BTreeSet::new();
        for layer in &m.layers {
            if layer.r#use.starts_with('.') {
                check(&mut out, "layers[].use", &format!("{}/layer.json", layer.r#use));
            }
            if let Some(id) = layer.id.as_deref().filter(|id| !is_instance_id(id)) {
                out.push(format!("layers[].id '{id}' must be lowercase letters, digits and dashes"));
            }
            if !seen.insert(layer.instance_hint()) {
                out.push(format!("layer '{}' is listed twice; give one entry its own \"id\"", layer.instance_hint()));
            }
        }
        out
    }

    /// Resolves a site-relative path, refusing anything that leaves the site folder.
    pub fn resolve(&self, relative: &str) -> Option<PathBuf> {
        let path = Path::new(relative);
        let inside = path.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
        inside.then(|| self.dir.join(path))
    }

    pub fn grid(&self) -> Grid {
        let m = &self.manifest;
        Grid {
            width: ((m.extent.width_m / m.scene.cell_m).round() as u32).max(1),
            height: ((m.extent.height_m / m.scene.cell_m).round() as u32).max(1),
            cell_m: m.scene.cell_m as f32,
            rotation_deg: m.extent.rotation_deg as f32,
        }
    }

    pub fn projection(&self) -> Projection {
        Projection::new(self.manifest.origin)
    }

    pub fn info(&self) -> SiteInfo {
        let m = &self.manifest;
        let grid = self.grid();
        let projection = self.projection();
        let (w, h) = (grid.width as f64, grid.height as f64);
        let corners = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)].map(|(col, row)| {
            let (east, north) = grid.cell_to_local(col, row);
            let p = projection.to_lonlat(east, north);
            [p.lon, p.lat]
        });
        SiteInfo {
            id: m.id.clone(),
            name: m.name.clone(),
            origin: m.origin,
            extent: m.extent,
            grid,
            corners,
            timezone: m.timezone.clone(),
            table: m.table,
            basemap: m.basemap.clone(),
            branding: m.branding.clone(),
            data: self.data(),
        }
    }

    /// The datasets layers may read: the scene's vector sources plus the manifest's `data`.
    pub fn data(&self) -> BTreeMap<String, String> {
        let m = &self.manifest;
        let mut data = BTreeMap::new();
        if let Some(b) = &m.scene.buildings {
            data.insert("buildings".to_string(), b.path.clone());
        }
        if let Some(t) = &m.scene.trees {
            data.insert("trees".to_string(), t.path.clone());
        }
        data.extend(m.data.clone());
        data
    }

    /// Rewrites the `layers` list of `site.json` and leaves every other key as it was written.
    /// The file is replaced in one step, so a crash cannot leave half a manifest behind.
    pub fn save_layers(&self, layers: &[LayerRef]) -> Result<(), SiteError> {
        let path = self.dir.join("site.json");
        let io = |source| SiteError::Io { path: path.clone(), source };
        let parse = |e: serde_json::Error| SiteError::Parse { path: path.clone(), message: e.to_string() };
        let text = std::fs::read_to_string(&path).map_err(io)?;
        let mut value: serde_json::Value = serde_json::from_str(&text).map_err(parse)?;
        value["layers"] = serde_json::to_value(layers).map_err(parse)?;
        // What is written must load again.
        let manifest: SiteManifest = serde_json::from_value(value.clone()).map_err(parse)?;
        let problems = Site { dir: self.dir.clone(), manifest }.problems();
        if !problems.is_empty() {
            return Err(SiteError::Invalid(problems));
        }
        let text = serde_json::to_string_pretty(&value).map_err(parse)? + "\n";
        let temporary = self.dir.join("site.json.tmp");
        std::fs::write(&temporary, text).map_err(io)?;
        std::fs::rename(&temporary, &path).map_err(io)
    }

    /// Builds the engine scene from the site's sources.
    pub fn bake(&self) -> Result<(SceneData, BakeStats), SiteError> {
        bake::bake(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Site {
        Site::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sites/sample")).unwrap()
    }

    fn layer(name: &str, id: Option<&str>) -> LayerRef {
        LayerRef { r#use: name.into(), id: id.map(String::from), active: true, params: Default::default() }
    }

    #[test]
    fn the_same_layer_twice_needs_an_id() {
        let mut site = sample();
        site.manifest.layers = vec![layer("cars", None), layer("cars", None)];
        assert!(site.problems().iter().any(|p| p.contains("listed twice")), "{:?}", site.problems());
        site.manifest.layers = vec![layer("cars", None), layer("cars", Some("rush-hour"))];
        assert!(site.problems().is_empty(), "{:?}", site.problems());
        site.manifest.layers = vec![layer("cars", Some("Rush Hour"))];
        assert!(site.problems().iter().any(|p| p.contains("lowercase")));
        // A site-only layer is known by its folder name.
        assert_eq!(layer("./layers/artwork", None).instance_hint(), "artwork");
    }

    #[test]
    fn datasets_are_named_and_checked() {
        let mut site = sample();
        let data = site.info().data;
        assert_eq!(data["buildings"], "data/buildings.geojson");
        assert_eq!(data["trees"], "data/trees.geojson");
        assert_eq!(data["roads"], "data/roads.geojson");
        site.manifest.data.insert("roads".into(), "../elsewhere.geojson".into());
        assert!(site.problems().iter().any(|p| p.starts_with("data.roads")));
    }
}
