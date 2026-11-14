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
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    /// Whether the layer starts active.
    #[serde(default)]
    pub active: bool,
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
    #[serde(default)]
    pub basemap: Basemap,
    /// Named datasets for layers: name to site-relative path.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub data: BTreeMap<String, String>,
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
