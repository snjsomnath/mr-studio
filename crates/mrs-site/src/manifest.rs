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
    /// The edge of the projected image where visitors stand. At-a-glance info goes there first,
    /// because for a viewer at the front the model hides what is projected on the far side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub front: Option<TableSide>,
    /// What the projector's blank space around the model shows, per side (present.md, Ribbon).
    #[serde(default, skip_serializing_if = "Ribbons::is_empty")]
    pub ribbons: Ribbons,
}

/// A side of the projected image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableSide {
    Top,
    Bottom,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ribbons {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<Ribbon>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<Ribbon>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<Ribbon>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<Ribbon>,
}

impl Ribbons {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    pub fn sides(&self) -> [(&'static str, Option<Ribbon>); 4] {
        [("top", self.top), ("bottom", self.bottom), ("left", self.left), ("right", self.right)]
    }
}

/// One side's ribbon: `"off"`, `"auto"` (use the free band when there is one) or a size.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Ribbon {
    Mode(RibbonMode),
    Size(RibbonSize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RibbonMode {
    Off,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RibbonSize {
    pub cm: f64,
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

/// A 3D model of the site's top surface (ground and buildings), rasterised into the dsm.
/// A mesh has no georeference of its own, so the manifest places it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mesh {
    /// An STL (binary or ASCII), OBJ or GLB file.
    pub path: String,
    /// Which of the file's axes points up. CAD and 3D printing use Z, glTF and many modelling tools Y.
    #[serde(default, skip_serializing_if = "Up::is_z")]
    pub up: Up,
    /// Whether the model is a mirror image (its X axis is flipped), as some exports are.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mirror: bool,
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

/// The up axis of a mesh file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Up {
    #[default]
    Z,
    /// Y up, Z towards the viewer: read as (x, -z, y).
    Y,
}

impl Up {
    fn is_z(&self) -> bool {
        *self == Up::Z
    }
}

impl Mesh {
    /// A vertex of the file in the mesh's own Z-up frame, before scale, turn and anchor:
    /// the up axis made Z, then mirrored if asked.
    pub fn orient(&self, v: [f32; 3]) -> [f64; 3] {
        let [x, y, z] = v.map(f64::from);
        let [x, y, z] = match self.up {
            Up::Z => [x, y, z],
            Up::Y => [x, -z, y],
        };
        [if self.mirror { -x } else { x }, y, z]
    }
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
    /// The line under the title on the controller's home screen, for visitors (#73).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub welcome: Option<String>,
    /// The languages visitors can switch between (#80), the first the table starts in:
    /// `["en", "sv"]`. Empty or one language: no switch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub languages: Vec<String>,
    /// The site's own words in other languages, by language and then by the English text:
    /// `{ "sv": { "Sample district": "Exempelstadsdelen" } }`. Titles, the welcome line, button
    /// names, slide titles and the like. A layer's own words are in its package (`locales/`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub translations: BTreeMap<String, BTreeMap<String, String>>,
}

/// The languages MR Studio's visitor screens speak (#80).
pub const LANGUAGES: [&str; 2] = ["en", "sv"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayerRef {
    /// What the instance runs: a core layer id, a relative path to a site-only layer package,
    /// or `custom:<id>` for a custom layer saved in the site's `custom`.
    pub r#use: String,
    /// Names this instance. Unique in the whole scene, items included; steps and the session refer to it.
    pub id: String,
    /// Whether the layer starts active.
    #[serde(default)]
    pub active: bool,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    /// How the layer is offered on the controller. What is left out comes from the layer package.
    #[serde(default, skip_serializing_if = "LayerButton::is_empty")]
    pub button: LayerButton,
    /// Ids of the layer's controls that the controller and phones do not show. The editor still does.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hide: Vec<String>,
    /// Instances that belong to this layer: shown while it is open, gone when it closes.
    /// Drawn on top of it, in this order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<LayerItem>,
    /// How Next moves through the layer, and for a sequence (a slideshow) the steps themselves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<Steps>,
}

/// An instance owned by a layer (public transport inside a sun study, a data visual on a
/// slide). It has no button: it comes on and goes off with its layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayerItem {
    pub r#use: String,
    pub id: String,
    /// Whether it comes on when its layer opens.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub active: bool,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hide: Vec<String>,
}

/// How Next moves through a layer (`docs/contracts/present.md`, Steps).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Steps {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<StepMode>,
    /// After the last step, back to the first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<bool>,
    /// What Next does when a step's sub-steps (category reveals, staged builds) are done.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveal: Option<Reveal>,
    /// How a sequence goes from one step to the next, unless a step says otherwise (#43).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<StepTransition>,
    /// How long that transition takes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_s: Option<f64>,
    /// The steps of a sequence: other instances shown one after another. Only for layers
    /// whose layer.json says `"sequence": true`, such as the slideshow.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sequence: Vec<SequenceStep>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepMode {
    Manual,
    Timed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reveal {
    /// Next stops at the last sub-step; moving on needs Shift+Next (the Chalmers demo).
    Stop,
    /// Next moves on to the next step after the last sub-step.
    ThenNext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transition {
    Cut,
    Fade,
}

/// How a sequence goes from one step to the next (#43). `Fade` cross-fades the two layers;
/// `Dip` fades the old one out to the empty map, then the new one in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepTransition {
    Cut,
    Fade,
    Dip,
}

/// One step of a sequence. It shows another instance: a layer of the scene (which keeps its
/// own button) or one of the sequence's own items (which exist only inside it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SequenceStep {
    /// The instance id this step shows.
    pub layer: String,
    /// Params the instance takes for this step only, such as another hour of the day.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    /// How long the step stays in timed mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<StepTransition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_s: Option<f64>,
    /// Overrides the sequence's `reveal` for this step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<Reveal>,
    /// For the controller's info strip. The table never shows them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// What the guide says at this step (#98). Shown on the guide's phone and in the editor,
    /// never on the table or the visitors' controller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// The button that opens a layer on the controller: the words and icon the site's
/// author chose for it, and where on the controller it sits.
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
    /// The group of buttons it sits in on its rail, such as "Simulations".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Its place in the rail; lower first. Buttons without one follow the scene order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<f64>,
    /// Kept off the controller and phones without taking the layer out of the table (#58).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
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
        if self.group.as_deref().is_some_and(|g| g.trim().is_empty()) || length(&self.group) > Self::MAX_NAME {
            return Some(format!("a button group is a name of 1 to {} characters", Self::MAX_NAME));
        }
        if self.order.is_some_and(|o| !o.is_finite()) {
            return Some("a button order is a number".into());
        }
        None
    }
}

/// A custom layer: a recipe of blocks the layer editor saves (#38), run by the runtime
/// without code of its own. data, then look, motion and interaction, in that order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomLayer {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// `base`, `ambient`, `analysis` (the default) or `media`, as in layer.json.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// What it shows: datasets of the site, files in the site, or map services.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data: Vec<RecipeData>,
    /// How each dataset is drawn (2D only): points, lines, fills, rasters and their styles.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub look: Vec<RecipeBlock>,
    /// What moves: reveals, pulses, particles, attractors, time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub motion: Vec<RecipeBlock>,
    /// What a visitor can do: tap, step, pointer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interaction: Vec<RecipeBlock>,
    /// How the layer comes onto the table and leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enter: Option<Transition>,
    /// Controls, as in layer.json. A control's `bind` names the block prop it drives: `look.<block id>.<prop>`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub controls: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub legend: Vec<LegendItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attract: Option<Attract>,
}

/// One source of a custom layer. Exactly one of `dataset`, `path`, `wms` and `tiles`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecipeData {
    pub id: String,
    /// A named dataset of the site (`data`, or the scene's buildings, trees and terrain).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset: Option<String>,
    /// A file in the site folder: GeoJSON, GeoTIFF, CSV points, an image or a video.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wms: Option<Wms>,
    /// An XYZ tile URL template with `{z}`, `{x}` and `{y}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiles: Option<String>,
}

impl RecipeData {
    pub fn sources(&self) -> usize {
        [self.dataset.is_some(), self.path.is_some(), self.wms.is_some(), self.tiles.is_some()].iter().filter(|s| **s).count()
    }
}

/// A WMS map. Sign-in, when the service needs it, comes from the app's Sources manager by
/// `source`; nothing secret is in the site.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Wms {
    pub url: String,
    pub layers: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub styles: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// One block in a custom layer's recipe. The block names are the SDK's (docs/blocks.md).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecipeBlock {
    /// Names the block so controls and other blocks can refer to it.
    pub id: String,
    /// Which block: `points`, `lines`, `fill`, `raster`, `glow`, `pulse`, `particles`, `tap-info`…
    pub block: String,
    /// The data it draws or reads, by `data[].id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// For motion and interaction: the look block it acts on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub props: Map<String, Value>,
}

/// The table's palette: one of the built-in sets the SDK knows (`night` when missing) and
/// the slots this table overrides, by slot name, as `#rrggbb`. Layers and custom layers
/// refer to slots (`@accent`, `@cat3`), so changing the palette recolours them all.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Palette {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub slots: BTreeMap<String, String>,
}

impl Palette {
    /// Whether a value is a colour a slot can hold: `#rrggbb`.
    pub fn is_colour(value: &str) -> bool {
        value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
    }
}

/// One row of a layer's legend on the controller (present.md, Stage).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegendItem {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
}

/// The effect behind a layer on the controller's attract loop (present.md, Button).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attract {
    pub effect: String,
}

impl LayerRef {
    /// The id this entry's state is keyed by.
    pub fn instance_hint(&self) -> &str {
        &self.id
    }

    /// The default id for an entry that uses `use`: the last segment of a path, or the custom layer's id.
    pub fn default_id(r#use: &str) -> &str {
        let name = r#use.strip_prefix(CUSTOM_PREFIX).unwrap_or(r#use);
        name.trim_end_matches('/').rsplit('/').next().unwrap_or(name)
    }
}

/// What `use` starts with for a custom layer saved in the site.
pub const CUSTOM_PREFIX: &str = "custom:";

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
    /// Custom layers saved in this site, by id. A scene uses one as `custom:<id>`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub custom: BTreeMap<String, CustomLayer>,
    /// The table's colours (#93): a built-in set and the slots this table changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<Palette>,
    #[serde(default)]
    pub tv: Option<Value>,
    /// Outside compute the table's layers reach through the host (#278): programs the host
    /// starts beside the table (a Python model in its own venv) or addresses it forwards to.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub services: Vec<Service>,
    /// How the table's surfaces render (#134): `{ "quality": "draft" | "good" | "best" }`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<Value>,
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

/// One outside service (#278). Exactly one of `run` and `url`. Contract in docs/contracts/site.md.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Service {
    /// What layers call it by: `requires.services` and `ctx.service(id)`.
    pub id: String,
    /// Its name for people, in the operator's view. Default: the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A program the host starts with the table and keeps running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<ServiceRun>,
    /// A service that runs elsewhere, such as `https://ecom.example.org`. The host forwards to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The path that answers 200 when the service is ready. Default `/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<String>,
}

/// How the host starts a service of this site.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceRun {
    /// Its folder, relative to the site, for example `services/ecom`.
    pub cwd: String,
    /// The program and its arguments. `{port}` is the port the host picked for it, and
    /// `{python}` the Python of `venv` (or of this computer when there is none).
    pub command: Vec<String>,
    /// A virtual environment, relative to `cwd`, for example `.venv`. The host makes it on the
    /// first start when it is missing, and installs `requirements` into it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venv: Option<String>,
    /// A requirements file, relative to `cwd`, installed when the venv is made or the file changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirements: Option<String>,
    /// Extra environment variables. `{port}` is filled in here too. Keys go in Sources and keys, never here.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Seconds the service may take to answer its health path after it starts. Default 60.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_s: Option<f64>,
}
