use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LonLat {
    pub lon: f64,
    pub lat: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Extent {
    pub width_m: f64,
    pub height_m: f64,
    /// Bearing of the table's "up" edge, clockwise from north.
    #[serde(default)]
    pub rotation_deg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Table {
    pub width_cm: f64,
    pub height_cm: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_cm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Buildings {
    pub path: String,
    #[serde(default = "default_height_property")]
    pub height_property: String,
    #[serde(default = "default_building_height")]
    pub default_height_m: f64,
    /// Whether the footprints are raised into the top surface. Turn off when a mesh
    /// provides the building shapes and the footprints are only drawn.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub extrude: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trees {
    pub path: String,
    #[serde(default = "default_height_property")]
    pub height_property: String,
    #[serde(default = "default_tree_height")]
    pub default_height_m: f64,
    #[serde(default = "default_crown_radius")]
    pub crown_radius_m: f64,
}

/// Ground elevation. Either a GeoTIFF (`.tif`, `.tiff`), placed by its own georeference,
/// or raw little-endian f32 elevations covering the extent, row 0 at the top, which
/// need `width` and `height`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Terrain {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// `EPSG:<code>` of a GeoTIFF that does not name its coordinate system itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crs: Option<String>,
}

impl Terrain {
    pub fn is_geotiff(&self) -> bool {
        let path = self.path.to_ascii_lowercase();
        path.ends_with(".tif") || path.ends_with(".tiff")
    }
}

/// A 3D model of the site's top surface (ground and buildings), Z up, rasterised into the dsm.
/// A mesh has no georeference of its own, so the manifest places it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mesh {
    /// An STL file, binary or ASCII.
    pub path: String,
    /// Where the mesh's own origin (0, 0) is.
    pub anchor: LonLat,
    /// Metres per mesh unit.
    #[serde(default = "one")]
    pub unit_m: f64,
    /// Compass bearing of the mesh's +Y axis, clockwise from north. +X is 90 degrees clockwise from +Y.
    #[serde(default)]
    pub bearing_deg: f64,
    /// Elevation of the mesh's z = 0, in the terrain's height datum.
    #[serde(default)]
    pub base_m: f64,
    /// The mesh's ground never matches the terrain exactly. Cells where the mesh is less
    /// than this above the terrain stay ground instead of becoming low obstacles.
    #[serde(default = "one")]
    pub ground_tolerance_m: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SceneSpec {
    pub cell_m: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buildings: Option<Buildings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terrain: Option<Terrain>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<Mesh>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trees: Option<Trees>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Basemap {
    #[serde(default = "default_background")]
    pub background: String,
    /// A MapLibre style URL, or null for no basemap.
    #[serde(default)]
    pub style: Option<String>,
}

impl Default for Basemap {
    fn default() -> Self {
        Self { background: default_background(), style: None }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Branding {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub logo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayerRef {
    /// A core layer id, or a relative path to a site-only layer package.
    pub r#use: String,
    /// Names this entry when the same layer is used more than once. Defaults to the layer's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Whether the layer starts active.
    #[serde(default)]
    pub active: bool,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    /// How the layer is offered on the controller. What is left out comes from the layer package.
    #[serde(default, skip_serializing_if = "LayerButton::is_empty")]
    pub button: LayerButton,
}

/// The button that opens a layer on the controller: the words and icon the site's
/// author chose for it, and the side of the controller it sits on.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayerButton {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// An icon name from the editor's set, such as `sun` or `route`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<ButtonSide>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ButtonSide {
    Left,
    Right,
}

impl LayerButton {
    pub const MAX_NAME: usize = 40;
    pub const MAX_DESCRIPTION: usize = 200;

    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// What is wrong with it, in the author's terms.
    pub fn problem(&self) -> Option<String> {
        let length = |text: &Option<String>| text.as_deref().map_or(0, |t| t.chars().count());
        if self.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
            return Some("a button name cannot be blank".into());
        }
        if length(&self.name) > Self::MAX_NAME {
            return Some(format!("a button name is at most {} characters", Self::MAX_NAME));
        }
        if length(&self.description) > Self::MAX_DESCRIPTION {
            return Some(format!("a button description is at most {} characters", Self::MAX_DESCRIPTION));
        }
        if self.icon.as_deref().is_some_and(|icon| !crate::is_instance_id(icon)) {
            return Some("a button icon is a name in lowercase letters, digits and dashes".into());
        }
        None
    }
}

impl LayerRef {
    /// The id this entry's state is keyed by, as far as the site file alone can tell:
    /// the explicit `id`, or the last segment of `use`.
    pub fn instance_hint(&self) -> &str {
        self.id.as_deref().unwrap_or_else(|| self.r#use.trim_end_matches('/').rsplit('/').next().unwrap_or(&self.r#use))
    }
}

/// Whether a string can be a layer instance id: lowercase letters, digits and dashes.
pub fn is_instance_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteManifest {
    pub format: u32,
    pub id: String,
    pub name: String,
    pub origin: LonLat,
    pub extent: Extent,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub table: Option<Table>,
    pub scene: SceneSpec,
    /// Named datasets for layers (`requires.data`), as site-relative paths.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub data: BTreeMap<String, String>,
    #[serde(default)]
    pub basemap: Basemap,
    #[serde(default)]
    pub layers: Vec<LayerRef>,
    #[serde(default)]
    pub tv: Option<Value>,
    #[serde(default)]
    pub branding: Branding,
}

/// `calibration.json`: how the table window shows the site on the physical table.
/// The host keeps the projector calibration of the model surface in the same file under
/// `projector`; that key, and any other, is left to its owner.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Calibration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<TableCalibration>,
}

/// The map view the projector needs for the image to land on the physical model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TableCalibration {
    pub center: LonLat,
    /// Web map zoom (512 px tiles) at the window size the table was calibrated at.
    pub zoom: f64,
    /// Compass bearing of the window's "up", clockwise from north.
    pub bearing: f64,
    /// The window size the zoom belongs to. With it, the view survives a change of resolution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowSize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowSize {
    pub width_px: f64,
    pub height_px: f64,
}

fn yes() -> bool {
    true
}
fn is_true(value: &bool) -> bool {
    *value
}
fn one() -> f64 {
    1.0
}
fn default_height_property() -> String {
    "height".into()
}
fn default_building_height() -> f64 {
    12.0
}
fn default_tree_height() -> f64 {
    8.0
}
fn default_crown_radius() -> f64 {
    3.0
}
fn default_background() -> String {
    "#0b0e14".into()
}
