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

/// Raw little-endian f32 elevations covering the extent, row 0 at the top.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Terrain {
    pub path: String,
    pub width: u32,
    pub height: u32,
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
