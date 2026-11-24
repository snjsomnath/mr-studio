//! MR Studio site packages: `site.json`, validation and scene baking.
//! Contract in `docs/contracts/site.md`.

mod bake;
pub mod create;
mod crs;
pub mod elevation;
pub mod field;
mod geotiff;
pub mod history;
pub mod import;
pub mod library;
mod manifest;
pub mod media;
mod mesh;
pub mod migrate;
pub mod model;
pub mod osm;
pub mod package;
pub mod plan;
mod projection;
pub mod sound;
mod twin;
pub mod video;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use mrs_engine::{Grid, SceneData};
use serde::Serialize;
use thiserror::Error;

pub use bake::BakeStats;
pub use crs::Crs;
pub use manifest::*;
pub use projection::Projection;

/// The site format this build reads.
pub const FORMAT: u32 = 3;

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
    /// From `calibration.json`, when the site has one.
    pub calibration: Option<Calibration>,
}

/// Where a table is and how much ground it covers: what `Site::place` writes.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Place {
    /// A new name, or `None` to keep it.
    #[serde(default)]
    pub name: Option<String>,
    pub origin: LonLat,
    pub extent: Extent,
    /// The physical table's width in centimetres, or `None` to keep it. Its height follows the
    /// ground's shape; together with the extent it sets the model scale (1 : extent / table).
    #[serde(default)]
    pub table_width_cm: Option<f64>,
    /// The side of one square 3D-printed tile in centimetres: `None` keeps it, 0 means the
    /// table is not printed in tiles.
    #[serde(default)]
    pub tile_cm: Option<f64>,
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
    /// The calibrated table view, when the site has a `calibration.json`.
    pub calibration: Option<TableCalibration>,
    /// Datasets layers may read, by name, as site-relative paths served under `/site/`.
    /// Holds the scene's `buildings` and `trees` and everything in the manifest's `data`.
    pub data: BTreeMap<String, String>,
    /// The site's TV dashboard settings (theme, pages), as written. Validated on the TV by `@mrstudio/dashboard`.
    pub tv: Option<serde_json::Value>,
    /// How the table's surfaces render (#134), as written: `quality` is `draft`, `good` or `best`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<serde_json::Value>,
    /// The table's palette (#93), as written. Surfaces resolve it against the SDK's sets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette: Option<Palette>,
    /// The 3D model of the site (`scene.mesh`), for the editor to place it again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh: Option<MeshInfo>,
}

/// `scene.mesh` as written, and whether the footprints are still raised beside it.
#[derive(Debug, Clone, Serialize)]
pub struct MeshInfo {
    #[serde(flatten)]
    pub mesh: Mesh,
    pub extrude: bool,
}

impl Site {
    pub fn load(dir: impl AsRef<Path>) -> Result<Self, SiteError> {
        let dir = dir.as_ref().to_path_buf();
        let path = dir.join("site.json");
        let text = std::fs::read_to_string(&path).map_err(|source| SiteError::Io { path: path.clone(), source })?;
        // A site written for an older format is upgraded as it is read; see `migrate`.
        let parse = |message: String| SiteError::Parse { path: path.clone(), message };
        let mut document: serde_json::Value = serde_json::from_str(&text).map_err(|e| parse(e.to_string()))?;
        migrate::upgrade(&mut document).map_err(parse)?;
        let manifest: SiteManifest = serde_json::from_value(document).map_err(|e| parse(e.to_string()))?;
        let path = dir.join("calibration.json");
        let calibration = match std::fs::read_to_string(&path) {
            Ok(text) => Some(serde_json::from_str(&text).map_err(|e| SiteError::Parse { path: path.clone(), message: e.to_string() })?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(source) => return Err(SiteError::Io { path, source }),
        };
        let site = Self { dir, manifest, calibration };
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
            if t.is_geotiff() {
                if t.width.is_some() || t.height.is_some() {
                    out.push("scene.terrain: width and height are for raw .f32 terrain; a GeoTIFF carries its own".into());
                }
                if let Some(crs) = t.crs.as_deref().filter(|crs| Crs::parse(crs).is_none()) {
                    out.push(format!("scene.terrain.crs: '{crs}' is not supported; use one of {}", Crs::SUPPORTED));
                }
            } else {
                match (t.width, t.height) {
                    (Some(width), Some(height)) if width > 0 && height > 0 => {
                        if let Some(full) = self.resolve(&t.path).filter(|p| p.exists()) {
                            let expected = width as u64 * height as u64 * 4;
                            let actual = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
                            if actual != expected {
                                out.push(format!("scene.terrain: {} is {actual} bytes, {width}x{height} f32 needs {expected}", t.path));
                            }
                        }
                    }
                    _ => out.push("scene.terrain: raw .f32 terrain needs a positive width and height".into()),
                }
                if t.crs.is_some() {
                    out.push("scene.terrain.crs is for GeoTIFF terrain; raw .f32 terrain covers the extent".into());
                }
            }
        }
        if let Some(mesh) = &m.scene.mesh {
            check(&mut out, "scene.mesh.path", &mesh.path);
            if mesh::Format::of(&mesh.path).is_none() {
                out.push("scene.mesh.path: a mesh is an STL, OBJ or GLB file".into());
            }
            if !(mesh.unit_m > 0.0) || !mesh.unit_m.is_finite() {
                out.push("scene.mesh.unit_m must be positive".into());
            }
            if !(-180.0..=180.0).contains(&mesh.anchor.lon) || !(-85.0..=85.0).contains(&mesh.anchor.lat) {
                out.push("scene.mesh.anchor must be a WGS84 lon/lat".into());
            }
            if !mesh.bearing_deg.is_finite() || !mesh.base_m.is_finite() || !(mesh.ground_tolerance_m >= 0.0) {
                out.push("scene.mesh: bearing_deg and base_m must be numbers, ground_tolerance_m zero or more".into());
            }
        }
        if let Some(c) = self.calibration.and_then(|c| c.table) {
            let window_ok = c.window.is_none_or(|w| w.width_px > 0.0 && w.height_px > 0.0);
            if !(-180.0..=180.0).contains(&c.center.lon)
                || !(-85.0..=85.0).contains(&c.center.lat)
                || !(0.0..=24.0).contains(&c.zoom)
                || !c.bearing.is_finite()
                || !window_ok
            {
                out.push("calibration.json: needs a WGS84 center, a zoom from 0 to 24, a bearing and a positive window size".into());
            }
        }
        for (name, path) in &m.data {
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
                out.push(format!("data: name '{name}' must be lowercase letters, digits, dashes and underscores"));
            }
            check(&mut out, &format!("data.{name}"), path);
        }
        out.extend(self.scene_problems());
        if let Some(table) = &m.table {
            for (side, ribbon) in table.ribbons.sides() {
                if let Some(Ribbon::Size(RibbonSize { cm })) = ribbon {
                    if !(cm.is_finite() && cm > 0.0) {
                        out.push(format!("table.ribbons.{side}: cm must be a positive number of centimetres"));
                    }
                }
            }
        }
        if let Some(palette) = &m.palette {
            if palette.set.as_deref().is_some_and(|set| !is_instance_id(set)) {
                out.push("palette.set: a palette set is a name in lowercase letters, digits and dashes".into());
            }
            for (slot, colour) in &palette.slots {
                if !is_instance_id(slot) || !Palette::is_colour(colour) {
                    out.push(format!(
                        "palette.slots.{slot}: a slot is a name in lowercase letters, digits and dashes holding a colour as #rrggbb"
                    ));
                }
            }
        }
        out.extend(self.custom_problems());
        out.extend(self.service_problems());
        out
    }

    /// The outside services under `services` (#278).
    fn service_problems(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        for service in &self.manifest.services {
            let at = format!("services.{}", service.id);
            if !is_instance_id(&service.id) {
                out.push(format!("{at}: an id is lowercase letters, digits and dashes"));
            }
            if !seen.insert(service.id.as_str()) {
                out.push(format!("{at}: another service has this id"));
            }
            match (&service.run, &service.url) {
                (Some(_), Some(_)) | (None, None) => out.push(format!("{at}: give either run or url")),
                (None, Some(url)) => {
                    if !(url.starts_with("http://") || url.starts_with("https://")) {
                        out.push(format!("{at}.url: an address starts with http:// or https://"));
                    }
                }
                (Some(run), None) => {
                    match self.resolve(&run.cwd) {
                        Some(dir) if dir.is_dir() => {}
                        Some(_) => out.push(format!("{at}.run.cwd: '{}' does not exist", run.cwd)),
                        None => out.push(format!("{at}.run.cwd: '{}' leaves the site folder", run.cwd)),
                    }
                    if run.command.is_empty() {
                        out.push(format!("{at}.run.command: name the program to start"));
                    }
                    for (name, path) in [("venv", &run.venv), ("requirements", &run.requirements)] {
                        if path
                            .as_deref()
                            .is_some_and(|p| Path::new(p).components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)))
                        {
                            out.push(format!("{at}.run.{name}: stays inside the service's folder"));
                        }
                    }
                }
            }
            if service.health.as_deref().is_some_and(|h| !h.starts_with('/')) {
                out.push(format!("{at}.health: a path starts with /"));
            }
        }
        out
    }

    /// Every instance of the scene, top to bottom of the file: each layer, then its items.
    /// Gives the instance's `use`, its id and the id of the layer that owns it.
    pub fn instances(&self) -> Vec<(&str, &str, Option<&str>)> {
        let mut out = Vec::new();
        for layer in &self.manifest.layers {
            out.push((layer.r#use.as_str(), layer.id.as_str(), None));
            for item in &layer.items {
                out.push((item.r#use.as_str(), item.id.as_str(), Some(layer.id.as_str())));
            }
        }
        out
    }

    /// Ids, uses, buttons, items and steps of the scene.
    fn scene_problems(&self) -> Vec<String> {
        let m = &self.manifest;
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        for (used, id, parent) in self.instances() {
            let at = match parent {
                Some(parent) => format!("layer '{parent}', item '{id}'"),
                None => format!("layer '{id}'"),
            };
            if !is_instance_id(id) {
                out.push(format!("{at}: an id is lowercase letters, digits and dashes, up to 40"));
            }
            if !seen.insert(id) {
                out.push(format!("'{id}' names two entries of the scene; every layer and item needs its own id"));
            }
            if let Some(custom) = used.strip_prefix(CUSTOM_PREFIX) {
                if !m.custom.contains_key(custom) {
                    out.push(format!("{at}: uses the custom layer '{custom}', which is not under \"custom\""));
                }
            } else if used.starts_with('.') {
                let label = format!("{at}: use");
                match self.resolve(&format!("{used}/layer.json")) {
                    None => out.push(format!("{label}: '{used}' must be a relative path inside the site folder")),
                    Some(full) if !full.exists() => out.push(format!("{label}: '{used}' has no layer.json")),
                    _ => {}
                }
            }
        }
        let top: BTreeSet<&str> = m.layers.iter().map(|l| l.id.as_str()).collect();
        let sequences: BTreeSet<&str> =
            m.layers.iter().filter(|l| l.steps.as_ref().is_some_and(|s| !s.sequence.is_empty())).map(|l| l.id.as_str()).collect();
        for layer in &m.layers {
            let id = &layer.id;
            if let Some(problem) = layer.button.problem() {
                out.push(format!("layer '{id}': {problem}"));
            }
            let Some(steps) = &layer.steps else { continue };
            if steps.transition_s.is_some_and(|d| !(d.is_finite() && (0.0..=10.0).contains(&d))) {
                out.push(format!("layer '{id}': steps.transition_s must be 0 to 10 seconds"));
            }
            for (n, step) in steps.sequence.iter().enumerate() {
                let at = format!("layer '{id}', step {}", n + 1);
                let own = layer.items.iter().any(|i| i.id == step.layer);
                if step.layer == *id {
                    out.push(format!("{at}: a sequence cannot show itself"));
                } else if sequences.contains(step.layer.as_str()) {
                    out.push(format!("{at}: '{}' is a sequence too; a step shows one layer, not another sequence", step.layer));
                } else if !own && !top.contains(step.layer.as_str()) {
                    out.push(format!("{at}: shows '{}', which is neither a layer of the scene nor an item of this one", step.layer));
                }
                if step.duration_s.is_some_and(|d| !(d.is_finite() && d > 0.0)) {
                    out.push(format!("{at}: duration_s must be a positive number of seconds"));
                }
                if step.transition_s.is_some_and(|d| !(d.is_finite() && (0.0..=10.0).contains(&d))) {
                    out.push(format!("{at}: transition_s must be 0 to 10 seconds"));
                }
                let long = |text: &Option<String>, most: usize| text.as_deref().is_some_and(|t| t.chars().count() > most);
                if long(&step.title, 80) || long(&step.description, 300) || long(&step.source, 200) {
                    out.push(format!("{at}: a step's title is at most 80 characters, its description 300 and its source 200"));
                }
            }
        }
        out
    }

    /// The recipes under `custom`.
    fn custom_problems(&self) -> Vec<String> {
        let mut out = Vec::new();
        let datasets = self.data();
        for (id, recipe) in &self.manifest.custom {
            let at = format!("custom layer '{id}'");
            if !is_instance_id(id) {
                out.push(format!("{at}: an id is lowercase letters, digits and dashes, up to 40"));
            }
            let name = recipe.name.trim().chars().count();
            if name == 0 || name > LayerButton::MAX_NAME {
                out.push(format!("{at}: a name is 1 to {} characters", LayerButton::MAX_NAME));
            }
            if recipe.category.as_deref().is_some_and(|c| !["base", "ambient", "analysis", "media"].contains(&c)) {
                out.push(format!("{at}: category is base, ambient, analysis or media"));
            }
            if recipe.icon.as_deref().is_some_and(|icon| !is_instance_id(icon)) {
                out.push(format!("{at}: an icon is a name in lowercase letters, digits and dashes"));
            }
            let mut sources = BTreeSet::new();
            for data in &recipe.data {
                let at = format!("{at}, data '{}'", data.id);
                if !is_instance_id(&data.id) || !sources.insert(data.id.as_str()) {
                    out.push(format!("{at}: each data entry needs its own id in lowercase letters, digits and dashes"));
                }
                if data.sources() != 1 {
                    out.push(format!("{at}: give exactly one of dataset, path, wms and tiles"));
                }
                if let Some(name) = data.dataset.as_deref().filter(|name| !datasets.contains_key(*name)) {
                    out.push(format!("{at}: the site has no dataset '{name}'"));
                }
                if let Some(path) = &data.path {
                    match self.resolve(path) {
                        None => out.push(format!("{at}: '{path}' must be a relative path inside the site folder")),
                        Some(full) if !full.exists() => out.push(format!("{at}: '{path}' does not exist")),
                        _ => {}
                    }
                }
                let web = |url: &str| url.starts_with("https://") || url.starts_with("http://");
                if data.wms.as_ref().is_some_and(|w| !web(&w.url) || w.layers.trim().is_empty()) {
                    out.push(format!("{at}: a WMS needs an http(s) url and the names of its layers"));
                }
                if data.tiles.as_deref().is_some_and(|t| !web(t) || !["{z}", "{x}", "{y}"].iter().all(|p| t.contains(p))) {
                    out.push(format!("{at}: tiles is an http(s) URL with {{z}}, {{x}} and {{y}}"));
                }
            }
            let look: BTreeSet<&str> = recipe.look.iter().map(|b| b.id.as_str()).collect();
            let mut blocks = BTreeSet::new();
            for (stage, list) in [("look", &recipe.look), ("motion", &recipe.motion), ("interaction", &recipe.interaction)] {
                for block in list {
                    let at = format!("{at}, {stage} '{}'", block.id);
                    if !is_instance_id(&block.id) || !blocks.insert(block.id.as_str()) {
                        out.push(format!("{at}: each block needs its own id in lowercase letters, digits and dashes"));
                    }
                    if !is_instance_id(&block.block) {
                        out.push(format!("{at}: block is a block name such as lines or glow"));
                    }
                    if let Some(data) = block.data.as_deref().filter(|d| !sources.contains(d)) {
                        out.push(format!("{at}: reads data '{data}', which the layer does not have"));
                    }
                    if let Some(on) = block.on.as_deref().filter(|on| !look.contains(on)) {
                        out.push(format!("{at}: acts on '{on}', which is not one of its look blocks"));
                    }
                }
            }
            if recipe.controls.iter().any(|c| !c["id"].is_string() || !c["type"].is_string()) {
                out.push(format!("{at}: every control needs an id and a type, as in layer.json"));
            }
            let mut legend = BTreeSet::new();
            if recipe.legend.iter().any(|item| !legend.insert(item.id.as_str()) || item.label.trim().is_empty()) {
                out.push(format!("{at}: every legend row needs its own id and a label"));
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
            calibration: self.calibration.and_then(|c| c.table),
            data: self.data(),
            tv: m.tv.clone(),
            display: m.display.clone(),
            palette: m.palette.clone(),
            mesh: m.scene.mesh.clone().map(|mesh| MeshInfo { mesh, extrude: m.scene.buildings.as_ref().is_none_or(|b| b.extrude) }),
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
        if let Some(t) = &m.scene.terrain {
            data.insert("terrain".to_string(), t.path.clone());
        }
        data.extend(m.data.clone());
        data
    }

    /// Rewrites the `layers` list of `site.json` and leaves every other key as it was written.
    /// The file is replaced in one step, so a crash cannot leave half a manifest behind.
    pub fn save_layers(&self, layers: &[LayerRef]) -> Result<(), SiteError> {
        let layers = serde_json::to_value(layers).map_err(|e| self.parse_error(e))?;
        self.save_key("layers", Some(layers))
    }

    /// Rewrites the `tv` settings of `site.json` (theme, rail style, About page…) and leaves every
    /// other key as it was written. `null` removes them. The TV checks what is inside.
    pub fn save_tv(&self, tv: serde_json::Value) -> Result<(), SiteError> {
        self.save_key("tv", (!tv.is_null()).then_some(tv))
    }

    /// Rewrites the `display` settings of `site.json` (#134) and leaves every other key as it was written.
    /// `null` removes them.
    pub fn save_display(&self, display: serde_json::Value) -> Result<(), SiteError> {
        self.save_key("display", (!display.is_null()).then_some(display))
    }

    /// Saves the custom layers under `custom` (none removes the key), leaving everything else as written.
    pub fn save_custom(&self, custom: &BTreeMap<String, CustomLayer>) -> Result<(), SiteError> {
        let value = (!custom.is_empty()).then(|| serde_json::to_value(custom)).transpose().map_err(|e| self.parse_error(e))?;
        self.save_key("custom", value)
    }

    /// Saves the table's palette (none removes it), leaving everything else as written.
    pub fn save_palette(&self, palette: Option<&Palette>) -> Result<(), SiteError> {
        let value = palette.map(serde_json::to_value).transpose().map_err(|e| self.parse_error(e))?;
        self.save_key("palette", value)
    }

    /// Saves the table settings (#73) that are not the place: `name`, `timezone` and `branding`,
    /// leaving everything else as written. Each is checked by the caller.
    pub fn save_settings(&self, name: &str, timezone: Option<&str>, branding: &Branding) -> Result<(), SiteError> {
        let branding = serde_json::to_value(branding).map_err(|e| self.parse_error(e))?;
        self.save_keys(&[
            ("name", Some(serde_json::json!(name))),
            ("timezone", timezone.map(|t| serde_json::json!(t))),
            ("branding", Some(branding)),
        ])
    }

    /// Saves the physical table (`table` in site.json): its size, tiles, front edge and ribbons.
    pub fn save_table(&self, table: &Table) -> Result<(), SiteError> {
        let value = serde_json::to_value(table).map_err(|e| self.parse_error(e))?;
        self.save_key("table", Some(value))
    }

    /// Takes a dataset out of site.json's `data` (#52). The file stays in the site folder, so an
    /// undo brings it back. False when site.json has no such dataset.
    pub fn forget_data(&self, name: &str) -> Result<bool, SiteError> {
        let document = self.read_document()?;
        let mut data = document.get("data").and_then(serde_json::Value::as_object).cloned().unwrap_or_default();
        if data.remove(name).is_none() {
            return Ok(false);
        }
        self.save_key("data", (!data.is_empty()).then(|| serde_json::Value::Object(data)))?;
        Ok(true)
    }

    /// The custom layers as site.json now has them on disk.
    pub fn saved_custom(&self) -> Result<BTreeMap<String, CustomLayer>, SiteError> {
        let value = self.read_document()?;
        serde_json::from_value(value.get("custom").cloned().unwrap_or_else(|| serde_json::json!({}))).map_err(|e| self.parse_error(e))
    }

    fn parse_error(&self, e: serde_json::Error) -> SiteError {
        SiteError::Parse { path: self.dir.join("site.json"), message: e.to_string() }
    }

    fn read_document(&self) -> Result<serde_json::Value, SiteError> {
        let path = self.dir.join("site.json");
        let text = std::fs::read_to_string(&path).map_err(|source| SiteError::Io { path: path.clone(), source })?;
        serde_json::from_str(&text).map_err(|e| self.parse_error(e))
    }

    /// Rewrites one top-level key of site.json (`None` removes it), checking that the
    /// result still loads, and replaces the file in one step.
    fn save_key(&self, key: &str, replacement: Option<serde_json::Value>) -> Result<(), SiteError> {
        self.save_keys(&[(key, replacement)])
    }

    /// Rewrites several top-level keys of site.json as one change.
    fn save_keys(&self, changes: &[(&str, Option<serde_json::Value>)]) -> Result<(), SiteError> {
        let path = self.dir.join("site.json");
        let io = |source| SiteError::Io { path: path.clone(), source };
        let mut value = self.read_document()?;
        let object =
            value.as_object_mut().ok_or_else(|| SiteError::Parse { path: path.clone(), message: "site.json is not an object".into() })?;
        for (key, replacement) in changes {
            match replacement {
                Some(replacement) => {
                    object.insert(key.to_string(), replacement.clone());
                }
                None => {
                    object.remove(*key);
                }
            }
        }
        // What is written must load again.
        let manifest: SiteManifest = serde_json::from_value(value.clone()).map_err(|e| self.parse_error(e))?;
        let problems = Site { dir: self.dir.clone(), manifest, calibration: self.calibration }.problems();
        if !problems.is_empty() {
            return Err(SiteError::Invalid(problems));
        }
        let text = serde_json::to_string_pretty(&value).map_err(|e| self.parse_error(e))? + "\n";
        let temporary = self.dir.join("site.json.tmp");
        std::fs::write(&temporary, text).map_err(io)?;
        std::fs::rename(&temporary, &path).map_err(io)
    }

    /// Renames the table, moves it, resizes or turns it: rewrites `name`, `origin` and `extent`
    /// of `site.json` (and the table's height, so its shape follows) and returns the site as
    /// it now loads. Data in WGS84 or on a national grid stays where it is in the world, so the
    /// next bake shows whatever the new extent covers. A raw height grid is tied to the old
    /// extent, so a table with one cannot move or change size.
    pub fn place(&self, place: &Place) -> Result<Site, SiteError> {
        let invalid = |message: &str| SiteError::Invalid(vec![message.to_string()]);
        let name = place.name.as_deref().map(str::trim);
        if name.is_some_and(|n| n.is_empty() || n.chars().count() > 60) {
            return Err(invalid("the name needs between 1 and 60 characters"));
        }
        let LonLat { lon, lat } = place.origin;
        if !(lon.is_finite() && lat.is_finite() && (-180.0..=180.0).contains(&lon) && (-85.0..=85.0).contains(&lat)) {
            return Err(invalid("the place needs a latitude between -85 and 85 and a longitude between -180 and 180"));
        }
        let Extent { width_m, height_m, rotation_deg } = place.extent;
        if !(width_m.is_finite() && height_m.is_finite() && (10.0..=50_000.0).contains(&width_m) && (10.0..=50_000.0).contains(&height_m)) {
            return Err(invalid("the width and the height must each be between 10 m and 50 km"));
        }
        if !rotation_deg.is_finite() {
            return Err(invalid("the rotation must be a number of degrees"));
        }
        if place.table_width_cm.is_some_and(|w| !(w.is_finite() && (10.0..=2000.0).contains(&w))) {
            return Err(invalid("the table must be between 10 cm and 20 m wide"));
        }
        if place.tile_cm.is_some_and(|t| !(t.is_finite() && (0.0..=2000.0).contains(&t))) {
            return Err(invalid("a tile must be between 0 and 20 m on a side"));
        }
        let rotation_deg = rotation_deg.rem_euclid(360.0);
        let m = &self.manifest;
        let moved = m.origin != place.origin
            || m.extent.width_m != width_m
            || m.extent.height_m != height_m
            || m.extent.rotation_deg != rotation_deg;
        let raw_terrain = m.scene.terrain.as_ref().is_some_and(|t| {
            let path = t.path.to_ascii_lowercase();
            !(path.ends_with(".tif") || path.ends_with(".tiff"))
        });
        if moved && raw_terrain {
            return Err(invalid(
                "the ground of this table is a height grid made for its current place and size, so the table cannot move; bring in the ground as a GeoTIFF first",
            ));
        }

        let path = self.dir.join("site.json");
        let io = |source| SiteError::Io { path: path.clone(), source };
        let parse = |message: String| SiteError::Parse { path: path.clone(), message };
        let text = std::fs::read_to_string(&path).map_err(io)?;
        let mut value: serde_json::Value = serde_json::from_str(&text).map_err(|e| parse(e.to_string()))?;
        migrate::upgrade(&mut value).map_err(parse)?;
        if let Some(name) = name {
            value["name"] = name.into();
        }
        value["origin"] = serde_json::json!({ "lon": lon, "lat": lat });
        value["extent"] = serde_json::json!({ "width_m": width_m, "height_m": height_m, "rotation_deg": rotation_deg });
        // The physical table keeps its width unless a new one is given; its height follows the ground's shape.
        if let Some(width_cm) = place.table_width_cm {
            if !value["table"].is_object() {
                value["table"] = serde_json::json!({});
            }
            value["table"]["width_cm"] = width_cm.into();
        }
        if let Some(width_cm) = value["table"]["width_cm"].as_f64() {
            value["table"]["height_cm"] = ((width_cm * height_m / width_m * 100.0).round() / 100.0).into();
        }
        if let (Some(tile_cm), Some(table)) = (place.tile_cm, value["table"].as_object_mut()) {
            if tile_cm > 0.0 {
                table.insert("tile_cm".into(), tile_cm.into());
            } else {
                table.remove("tile_cm");
            }
        }
        let manifest: SiteManifest = serde_json::from_value(value.clone()).map_err(|e| parse(e.to_string()))?;
        let problems = Site { dir: self.dir.clone(), manifest, calibration: self.calibration }.problems();
        if !problems.is_empty() {
            return Err(SiteError::Invalid(problems));
        }
        let text = serde_json::to_string_pretty(&value).map_err(|e| parse(e.to_string()))? + "\n";
        let temporary = self.dir.join("site.json.tmp");
        std::fs::write(&temporary, text).map_err(io)?;
        std::fs::rename(&temporary, &path).map_err(io)?;
        Site::load(&self.dir)
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

    fn layer(name: &str, id: &str) -> LayerRef {
        LayerRef {
            r#use: name.into(),
            id: id.into(),
            active: true,
            params: Default::default(),
            button: Default::default(),
            hide: Vec::new(),
            items: Vec::new(),
            steps: None,
        }
    }

    fn item(name: &str, id: &str) -> LayerItem {
        LayerItem { r#use: name.into(), id: id.into(), active: true, params: Default::default(), hide: Vec::new() }
    }

    fn problems_with(site: &Site, needle: &str) -> bool {
        site.problems().iter().any(|p| p.contains(needle))
    }

    #[test]
    fn every_layer_and_item_has_its_own_id() {
        let mut site = sample();
        site.manifest.layers = vec![layer("cars", "cars"), layer("cars", "cars")];
        assert!(problems_with(&site, "names two entries"), "{:?}", site.problems());
        site.manifest.layers = vec![layer("cars", "cars"), layer("cars", "rush-hour")];
        assert!(site.problems().is_empty(), "{:?}", site.problems());
        site.manifest.layers = vec![layer("cars", "Rush Hour")];
        assert!(problems_with(&site, "lowercase"));
        // An item shares the id space with the layers.
        let mut sun = layer("sunlight", "sun");
        sun.items = vec![item("transit", "cars")];
        site.manifest.layers = vec![layer("cars", "cars"), sun];
        assert!(problems_with(&site, "'cars' names two entries"), "{:?}", site.problems());
        site.manifest.layers[1].items[0].id = "sun-transit".into();
        assert!(site.problems().is_empty(), "{:?}", site.problems());
        // The id a format 2 entry had without one.
        assert_eq!(LayerRef::default_id("./layers/artwork"), "artwork");
        assert_eq!(LayerRef::default_id("custom:heat-walk"), "heat-walk");
    }

    #[test]
    fn a_sequence_shows_layers_of_the_scene_or_its_own_items() {
        let mut site = sample();
        let step = |layer: &str| SequenceStep {
            layer: layer.into(),
            params: Default::default(),
            duration_s: Some(8.0),
            transition: Some(StepTransition::Fade),
            transition_s: None,
            next: None,
            title: None,
            description: None,
            source: None,
            notes: None,
        };
        let mut tour = layer("slideshow", "tour");
        tour.items = vec![item("trees", "tour-trees")];
        tour.steps = Some(Steps { sequence: vec![step("sun"), step("tour-trees")], ..Default::default() });
        site.manifest.layers = vec![layer("sunlight", "sun"), tour.clone()];
        assert!(site.problems().is_empty(), "{:?}", site.problems());

        tour.steps.as_mut().unwrap().sequence.push(step("nowhere"));
        tour.steps.as_mut().unwrap().sequence.push(step("tour"));
        tour.steps.as_mut().unwrap().sequence[0].duration_s = Some(0.0);
        site.manifest.layers = vec![layer("sunlight", "sun"), tour.clone()];
        assert!(problems_with(&site, "step 3: shows 'nowhere'"), "{:?}", site.problems());
        assert!(problems_with(&site, "step 4: a sequence cannot show itself"));
        assert!(problems_with(&site, "step 1: duration_s"));

        // Another layer's item is not this sequence's to show, and sequences do not nest.
        let mut sun = layer("sunlight", "sun");
        sun.items = vec![item("transit", "sun-transit")];
        let mut other = layer("slideshow", "other");
        other.steps = Some(Steps { sequence: vec![step("sun-transit"), step("tour")], ..Default::default() });
        tour.steps = Some(Steps { sequence: vec![step("sun")], ..Default::default() });
        site.manifest.layers = vec![sun, tour, other];
        assert!(problems_with(&site, "shows 'sun-transit', which is neither"), "{:?}", site.problems());
        assert!(problems_with(&site, "'tour' is a sequence too"));
    }

    #[test]
    fn a_custom_layer_is_a_checked_recipe() {
        let mut site = sample();
        let recipe: CustomLayer = serde_json::from_value(serde_json::json!({
            "name": "Heat walk", "icon": "route", "category": "analysis",
            "data": [
                { "id": "paths", "dataset": "walkways" },
                { "id": "photo", "wms": { "url": "https://example.org/wms", "layers": "ortho" } }
            ],
            "look": [{ "id": "lines", "block": "lines", "data": "paths", "props": { "color": "#ff8800", "width": 3 } }],
            "motion": [{ "id": "glow", "block": "glow", "on": "lines" }],
            "interaction": [{ "id": "tap", "block": "tap-info", "data": "paths" }],
            "enter": "fade",
            "controls": [{ "id": "width", "type": "range", "label": "Width", "min": 1, "max": 8, "step": 1, "default": 3, "bind": "look.lines.width" }],
            "legend": [{ "id": "hot", "label": "Hot", "color": "#ff4400", "shape": "line" }],
            "attract": { "effect": "particles" }
        }))
        .unwrap();
        site.manifest.custom.insert("heat-walk".into(), recipe.clone());
        site.manifest.layers.push(layer("custom:heat-walk", "heat-walk"));
        assert!(site.problems().is_empty(), "{:?}", site.problems());

        site.manifest.layers.push(layer("custom:nothing", "nothing"));
        assert!(problems_with(&site, "uses the custom layer 'nothing'"));
        site.manifest.layers.pop();

        let mut bad = recipe;
        bad.data[0].path = Some("../outside.geojson".into());
        bad.data[1].wms.as_mut().unwrap().url = "ftp://x".into();
        bad.motion[0].on = Some("paths".into());
        bad.look[0].data = Some("nope".into());
        site.manifest.custom.insert("heat-walk".into(), bad);
        assert!(problems_with(&site, "data 'paths': give exactly one"), "{:?}", site.problems());
        assert!(problems_with(&site, "a WMS needs"));
        assert!(problems_with(&site, "acts on 'paths'"));
        assert!(problems_with(&site, "reads data 'nope'"));
    }

    #[test]
    fn buttons_and_ribbons_are_checked() {
        let mut site = sample();
        site.manifest.layers[1].button.group = Some(" ".into());
        assert!(problems_with(&site, "a button group"));
        site.manifest.layers[1].button.group = Some("Simulations".into());
        site.manifest.layers[1].button.order = Some(2.0);
        assert!(site.problems().is_empty(), "{:?}", site.problems());
        let table: Table = serde_json::from_value(serde_json::json!({
            "width_cm": 100, "height_cm": 60, "front": "left", "ribbons": { "bottom": { "cm": 9 }, "top": "auto", "left": "off" }
        }))
        .unwrap();
        assert_eq!(table.front, Some(TableSide::Left));
        assert!(serde_json::from_value::<Table>(serde_json::json!({ "width_cm": 1, "height_cm": 1, "front": "near" })).is_err());
        assert_eq!(table.ribbons.bottom, Some(Ribbon::Size(RibbonSize { cm: 9.0 })));
        assert_eq!(table.ribbons.top, Some(Ribbon::Mode(RibbonMode::Auto)));
        assert!(
            serde_json::from_value::<Table>(serde_json::json!({ "width_cm": 1, "height_cm": 1, "ribbons": { "top": "wide" } })).is_err()
        );
        site.manifest.table =
            Some(Table { ribbons: Ribbons { bottom: Some(Ribbon::Size(RibbonSize { cm: -1.0 })), ..table.ribbons }, ..table });
        assert!(problems_with(&site, "table.ribbons.bottom"));
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

    fn site(data: &str) -> Site {
        let text = format!(
            r#"{{ "format": 3, "id": "t", "name": "T", "origin": {{ "lon": 12, "lat": 57 }},
                 "extent": {{ "width_m": 100, "height_m": 100 }}, "scene": {{ "cell_m": 1 }}, "data": {data} }}"#
        );
        // The crate's own folder stands in for a site folder: Cargo.toml exists in it.
        Site { dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")), manifest: serde_json::from_str(&text).unwrap(), calibration: None }
    }

    #[test]
    fn datasets_are_named_files_inside_the_site() {
        let good = site(r#"{ "walkways": "Cargo.toml" }"#);
        assert_eq!(good.problems(), Vec::<String>::new());
        assert_eq!(good.info().data["walkways"], "Cargo.toml");

        let problems = site(r#"{ "walkways": "missing.geojson", "trips": "../outside.json", "Bad Name": "Cargo.toml" }"#).problems();
        assert_eq!(problems.len(), 3, "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("data.walkways") && p.contains("does not exist")));
        assert!(problems.iter().any(|p| p.contains("data.trips") && p.contains("inside the site folder")));
        assert!(problems.iter().any(|p| p.contains("'Bad Name'")));
    }

    #[test]
    fn calibration_file_may_hold_only_a_projector() {
        // The host writes the model surface's projector calibration into the same file.
        let only_projector: Calibration = serde_json::from_str(r#"{ "projector": { "version": 1 } }"#).unwrap();
        assert_eq!(only_projector.table, None);
        let both: Calibration =
            serde_json::from_str(r#"{ "table": { "center": { "lon": 12, "lat": 57 }, "zoom": 16, "bearing": 0 }, "projector": null }"#)
                .unwrap();
        assert_eq!(both.table.map(|t| t.zoom), Some(16.0));
    }
}
