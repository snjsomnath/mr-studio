//! Starter packs (#450): the table's basics as files to draw on in other programs, such as
//! QGIS, Illustrator, Photoshop and PowerPoint, so what is made there comes back in place.
//!
//! Everything is laid out on the table's own sheet: centimetres, x to the right and y down
//! from the model's top-left corner, as a visitor at the front sees it. The table canvas is
//! exactly the table's frame, which is what a picture slide, a plan drawing and the map's
//! extent cover, so a drawing on it comes back without lining up. The projection canvas adds
//! the projector's blank space around the model, for art that goes in the margins.
//!
//! The guides sit in one group named "MR Studio guides", which a plan drawing leaves out when
//! it is brought back (see `plan`), so they can stay in the file.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::{Projection, Ribbon, RibbonMode, Site, TableSide};

/// A thing a starter pack can show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Feature {
    /// The model's outline: the table's frame.
    Table,
    /// The square 3D-printed tiles the model is made of (`table.tile_cm`).
    Tiles,
    Buildings,
    Streets,
    /// Where the projector's image lands around the model.
    Projection,
    /// The at-a-glance ribbons in the projector's blank space (#78).
    Glance,
}

impl Feature {
    pub const ALL: [Feature; 6] = [Self::Table, Self::Tiles, Self::Buildings, Self::Streets, Self::Projection, Self::Glance];

    pub fn id(self) -> &'static str {
        match self {
            Self::Table => "table",
            Self::Tiles => "tiles",
            Self::Buildings => "buildings",
            Self::Streets => "streets",
            Self::Projection => "projection",
            Self::Glance => "glance",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Table => "Table outline",
            Self::Tiles => "Tile grid",
            Self::Buildings => "Building footprints",
            Self::Streets => "Street network",
            Self::Projection => "Projection area",
            Self::Glance => "At-a-glance boxes",
        }
    }

    /// File-name friendly: "building-footprints".
    fn slug(self) -> String {
        self.name().to_ascii_lowercase().replace(' ', "-")
    }

    /// Shown only on the model: data that runs on past the table's edge is cut there.
    fn on_model(self) -> bool {
        matches!(self, Self::Tiles | Self::Buildings | Self::Streets)
    }

    fn style(self) -> Style {
        match self {
            Self::Table => Style { fill: None, stroke: Some((0x22, 0x22, 0x22)), width_cm: 0.15, dash: false, alpha: 1.0 },
            Self::Tiles => Style { fill: None, stroke: Some((0x99, 0x99, 0x99)), width_cm: 0.05, dash: true, alpha: 1.0 },
            Self::Buildings => {
                Style { fill: Some((0xd9, 0xd4, 0xcc)), stroke: Some((0x8a, 0x82, 0x78)), width_cm: 0.03, dash: false, alpha: 1.0 }
            }
            Self::Streets => Style { fill: None, stroke: Some((0x6b, 0x8f, 0xb5)), width_cm: 0.12, dash: false, alpha: 1.0 },
            Self::Projection => Style { fill: None, stroke: Some((0xe8, 0x59, 0x0c)), width_cm: 0.12, dash: true, alpha: 1.0 },
            Self::Glance => {
                Style { fill: Some((0xf5, 0x9f, 0x00)), stroke: Some((0xe6, 0x77, 0x00)), width_cm: 0.08, dash: false, alpha: 0.18 }
            }
        }
    }
}

/// A program the pack prepares files for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum App {
    Qgis,
    Illustrator,
    Photoshop,
    Powerpoint,
}

impl App {
    pub const ALL: [App; 4] = [Self::Qgis, Self::Illustrator, Self::Photoshop, Self::Powerpoint];

    pub fn name(self) -> &'static str {
        match self {
            Self::Qgis => "QGIS",
            Self::Illustrator => "Illustrator",
            Self::Photoshop => "Photoshop",
            Self::Powerpoint => "PowerPoint",
        }
    }

    fn folder(self) -> &'static str {
        match self {
            Self::Qgis => "qgis",
            Self::Illustrator => "illustrator",
            Self::Photoshop => "photoshop",
            Self::Powerpoint => "powerpoint",
        }
    }
}

/// How big the drawing surface is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Canvas {
    /// Exactly the table's frame: comes back in place as a picture, a plan drawing or data.
    #[default]
    Table,
    /// The table and the projector's image around it, for art in the margins.
    Projection,
}

/// What to put in a pack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Options {
    pub features: Vec<Feature>,
    pub apps: Vec<App>,
    pub canvas: Canvas,
    /// Pixels per centimetre of table for the pictures.
    pub px_per_cm: f64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            features: vec![Feature::Table, Feature::Tiles, Feature::Buildings, Feature::Streets],
            apps: App::ALL.to_vec(),
            canvas: Canvas::Table,
            px_per_cm: 20.0,
        }
    }
}

/// The biggest picture side, in pixels. A finer resolution is lowered to fit.
pub const MAX_PX: f64 = 8000.0;

/// Where the projection area came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectionSource {
    /// The projector calibration of the 3D model (calibration.json `projector`).
    Projector,
    /// The flat table view (calibration.json `table`).
    Table,
    /// Not calibrated: the table and room for its ribbons.
    Estimate,
}

#[derive(Debug, Clone, Copy)]
struct Style {
    fill: Option<(u8, u8, u8)>,
    stroke: Option<(u8, u8, u8)>,
    width_cm: f64,
    dash: bool,
    alpha: f64,
}

type Pt = [f64; 2];

/// One shape on the sheet, in table centimetres.
#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    /// Rings, the first the outline and the rest holes.
    Area(Vec<Vec<Pt>>),
    Line(Vec<Pt>),
}

/// One feature on the sheet, with the GeoJSON properties each shape carries.
#[derive(Debug, Clone)]
pub struct Group {
    pub feature: Feature,
    pub shapes: Vec<(Shape, Value)>,
    /// Text drawn in the SVG (tile names): position and words.
    pub labels: Vec<(Pt, String)>,
    /// Line widths per shape in cm, for streets with a width.
    widths: Vec<Option<f64>>,
}

/// The table, laid out on its sheet.
#[derive(Debug, Clone)]
pub struct Sheet {
    pub name: String,
    pub table_cm: (f64, f64),
    /// The drawing surface: left, top, width, height in table cm.
    pub canvas: [f64; 4],
    pub groups: Vec<Group>,
    pub projection: ProjectionSource,
    /// Metres of ground per centimetre of table.
    pub m_per_cm: f64,
    /// Things the person should know, in words.
    pub notes: Vec<String>,
    frame: Frame,
}

/// Table centimetres to and from the site's local metres and WGS84.
#[derive(Debug, Clone, Copy)]
struct Frame {
    width_m: f64,
    height_m: f64,
    rotation: f64,
    width_cm: f64,
    height_cm: f64,
    projection: Projection,
}

impl Frame {
    fn on_sheet(self, east: f64, north: f64) -> Pt {
        let (s, c) = self.rotation.sin_cos();
        let right = east * c - north * s;
        let up = east * s + north * c;
        [(right / self.width_m + 0.5) * self.width_cm, (0.5 - up / self.height_m) * self.height_cm]
    }

    fn local_of(self, p: Pt) -> (f64, f64) {
        let right = (p[0] / self.width_cm - 0.5) * self.width_m;
        let up = (0.5 - p[1] / self.height_cm) * self.height_m;
        let (s, c) = self.rotation.sin_cos();
        (right * c + up * s, -right * s + up * c)
    }

    fn on_sheet_lonlat(self, lon: f64, lat: f64) -> Pt {
        let (e, n) = self.projection.to_local(lon, lat);
        self.on_sheet(e, n)
    }

    fn lonlat_of(self, p: Pt) -> Pt {
        let (e, n) = self.local_of(p);
        let ll = self.projection.to_lonlat(e, n);
        [round(ll.lon, 1e7), round(ll.lat, 1e7)]
    }
}

fn round(v: f64, by: f64) -> f64 {
    (v * by).round() / by
}

/// The rules ribbons follow (`packages/runtime/src/ribbon-bands.ts`, present.md Ribbon).
const RIBBON_AUTO_CM: f64 = 9.0;
const RIBBON_MIN_CM: f64 = 4.0;
const RIBBON_GAP_CM: f64 = 0.5;

/// Lays the site out on its sheet.
pub fn sheet(site: &Site, options: &Options) -> Sheet {
    let m = &site.manifest;
    let (width_cm, height_cm) = match m.table {
        Some(t) if t.width_cm > 0.0 && t.height_cm > 0.0 => (t.width_cm, t.height_cm),
        _ => (100.0, 100.0 * m.extent.height_m / m.extent.width_m.max(1e-9)),
    };
    let frame = Frame {
        width_m: m.extent.width_m,
        height_m: m.extent.height_m,
        rotation: m.extent.rotation_deg.to_radians(),
        width_cm,
        height_cm,
        projection: site.projection(),
    };
    let mut notes = Vec::new();
    let wants = |f: Feature| options.features.contains(&f);
    let mut groups = Vec::new();

    if wants(Feature::Table) {
        let ring = rect(0.0, 0.0, width_cm, height_cm);
        let props = json!({ "name": m.name, "width_cm": width_cm, "height_cm": height_cm, "width_m": m.extent.width_m, "height_m": m.extent.height_m });
        groups.push(group(Feature::Table, vec![(Shape::Area(vec![ring]), props)]));
    }
    if wants(Feature::Tiles) {
        match m.table.and_then(|t| t.tile_cm).filter(|t| *t > 0.0) {
            Some(tile) => groups.push(tiles(width_cm, height_cm, tile)),
            None => notes.push("The table is not printed in tiles (Table settings, Tile size), so there is no tile grid.".into()),
        }
    }
    if wants(Feature::Buildings) {
        let path = m.scene.buildings.as_ref().map(|b| b.path.clone());
        match path.and_then(|p| read_geojson(site, &p)) {
            Some(fc) => groups.push(from_geojson(Feature::Buildings, &fc, &frame, width_cm / m.extent.width_m)),
            None => notes.push("The table has no building footprints yet (Insert, Data file or Open data).".into()),
        }
    }
    if wants(Feature::Streets) {
        match streets_path(site).and_then(|p| read_geojson(site, &p)) {
            Some(fc) => groups.push(from_geojson(Feature::Streets, &fc, &frame, width_cm / m.extent.width_m)),
            None => notes.push("The table has no street network yet (Insert, Open data, Streets).".into()),
        }
    }
    let (area, source) = projection_area(site, &frame);
    if source == ProjectionSource::Estimate && (wants(Feature::Projection) || options.canvas == Canvas::Projection) {
        notes.push("The projector is not calibrated on this computer, so the projection area is the table with room for its at-a-glance boxes. Calibrate (Display, Calibrate) for the real one.".into());
    }
    if wants(Feature::Projection) {
        let props = json!({ "name": "Projection area", "from": source });
        groups.push(group(Feature::Projection, vec![(Shape::Area(vec![area.clone()]), props)]));
    }
    if wants(Feature::Glance) {
        let bands = ribbon_bands(site, (width_cm, height_cm), &area, source == ProjectionSource::Estimate);
        if bands.is_empty() {
            notes.push("No at-a-glance box fits: every side is off or has too little room (Table settings, At a glance).".into());
        }
        let shapes = bands
            .into_iter()
            .map(|(side, cm, r, front)| {
                (
                    Shape::Area(vec![rect(r[0], r[1], r[2], r[3])]),
                    json!({ "name": format!("At a glance, {side}"), "side": side, "cm": cm, "front": front }),
                )
            })
            .collect();
        groups.push(group(Feature::Glance, shapes));
    }

    let canvas = match options.canvas {
        Canvas::Table => [0.0, 0.0, width_cm, height_cm],
        Canvas::Projection => {
            let mut b = [0.0, 0.0, width_cm, height_cm];
            let mut add = |p: &Pt| {
                b[0] = b[0].min(p[0]);
                b[1] = b[1].min(p[1]);
                b[2] = b[2].max(p[0]);
                b[3] = b[3].max(p[1]);
            };
            area.iter().for_each(&mut add);
            for g in groups.iter().filter(|g| g.feature == Feature::Glance) {
                for (shape, _) in &g.shapes {
                    if let Shape::Area(rings) = shape {
                        rings[0].iter().for_each(&mut add);
                    }
                }
            }
            let (l, t) = ((b[0] * 2.0).floor() / 2.0, (b[1] * 2.0).floor() / 2.0);
            [l, t, (b[2] * 2.0).ceil() / 2.0 - l, (b[3] * 2.0).ceil() / 2.0 - t]
        }
    };
    if options.features.iter().any(|f| matches!(f, Feature::Projection | Feature::Glance)) && options.canvas == Canvas::Table {
        notes.push(
            "The projection area and at-a-glance boxes lie outside the table canvas. Choose the projection canvas to draw them.".into(),
        );
    }
    Sheet {
        name: m.name.clone(),
        table_cm: (width_cm, height_cm),
        canvas,
        groups,
        projection: source,
        m_per_cm: m.extent.width_m / width_cm,
        notes,
        frame,
    }
}

fn group(feature: Feature, shapes: Vec<(Shape, Value)>) -> Group {
    let widths = vec![None; shapes.len()];
    Group { feature, shapes, labels: Vec::new(), widths }
}

fn rect(left: f64, top: f64, width: f64, height: f64) -> Vec<Pt> {
    vec![[left, top], [left + width, top], [left + width, top + height], [left, top + height], [left, top]]
}

/// Tiles named as a spreadsheet's cells: columns A, B, C from the left, rows 1, 2, 3 from the top.
fn tiles(width_cm: f64, height_cm: f64, tile: f64) -> Group {
    let cols = (width_cm / tile - 1e-6).ceil().max(1.0) as usize;
    let rows = (height_cm / tile - 1e-6).ceil().max(1.0) as usize;
    let mut g = group(Feature::Tiles, Vec::new());
    for row in 0..rows {
        for col in 0..cols {
            let (left, top) = (col as f64 * tile, row as f64 * tile);
            let (w, h) = ((width_cm - left).min(tile), (height_cm - top).min(tile));
            let name = format!("{}{}", column_name(col), row + 1);
            g.labels.push(([left + w / 2.0, top + h / 2.0], name.clone()));
            g.shapes.push((
                Shape::Area(vec![rect(left, top, w, h)]),
                json!({ "name": name, "row": row + 1, "column": col + 1, "tile_cm": tile }),
            ));
            g.widths.push(None);
        }
    }
    g
}

fn column_name(mut col: usize) -> String {
    let mut name = String::new();
    loop {
        name.insert(0, (b'A' + (col % 26) as u8) as char);
        if col < 26 {
            return name;
        }
        col = col / 26 - 1;
    }
}

/// The street network: the `roads` dataset, or another whose name says streets or roads.
fn streets_path(site: &Site) -> Option<String> {
    let data = &site.manifest.data;
    data.get("roads").cloned().or_else(|| {
        data.iter().find(|(k, _)| ["street", "road"].iter().any(|w| k.to_ascii_lowercase().contains(w))).map(|(_, v)| v.clone())
    })
}

fn read_geojson(site: &Site, relative: &str) -> Option<Value> {
    let path = site.resolve(relative)?;
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    (value["type"] == "FeatureCollection").then_some(value)
}

/// The features of a collection that touch the sheet around the table, on the sheet.
fn from_geojson(feature: Feature, fc: &Value, frame: &Frame, cm_per_m: f64) -> Group {
    let mut g = group(feature, Vec::new());
    let margin = 0.25;
    let (w, h) = (frame.width_cm, frame.height_cm);
    let near = |p: &Pt| p[0] > -w * margin && p[0] < w * (1.0 + margin) && p[1] > -h * margin && p[1] < h * (1.0 + margin);
    let ring = |coords: &Value| -> Vec<Pt> {
        coords
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| Some(frame.on_sheet_lonlat(c.get(0)?.as_f64()?, c.get(1)?.as_f64()?)))
            .collect()
    };
    for f in fc["features"].as_array().into_iter().flatten() {
        let props = f.get("properties").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
        let width = props.get("width").and_then(Value::as_f64).filter(|w| *w > 0.0).map(|w| w * cm_per_m);
        let geometry = &f["geometry"];
        let coords = &geometry["coordinates"];
        let shapes: Vec<Shape> = match geometry["type"].as_str() {
            Some("Polygon") => vec![Shape::Area(coords.as_array().into_iter().flatten().map(ring).collect())],
            Some("MultiPolygon") => coords
                .as_array()
                .into_iter()
                .flatten()
                .map(|poly| Shape::Area(poly.as_array().into_iter().flatten().map(ring).collect()))
                .collect(),
            Some("LineString") => vec![Shape::Line(ring(coords))],
            Some("MultiLineString") => coords.as_array().into_iter().flatten().map(|l| Shape::Line(ring(l))).collect(),
            _ => Vec::new(),
        };
        for shape in shapes {
            let points = match &shape {
                Shape::Area(rings) => rings.first().cloned().unwrap_or_default(),
                Shape::Line(line) => line.clone(),
            };
            if points.len() >= 2 && points.iter().any(near) {
                g.shapes.push((shape, props.clone()));
                g.widths.push(width);
            }
        }
    }
    g
}

/// The projector's image on the table's sheet, and where that came from.
fn projection_area(site: &Site, frame: &Frame) -> (Vec<Pt>, ProjectionSource) {
    let file: Option<Value> = std::fs::read_to_string(site.dir.join("calibration.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
    if let Some(area) = file.as_ref().and_then(|f| from_projector(&f["projector"], frame)) {
        return (area, ProjectionSource::Projector);
    }
    if let Some(area) = site.calibration.and_then(|c| c.table).and_then(|t| {
        let window = t.window?;
        let lat = t.center.lat.to_radians();
        let m_per_px = 40_075_016.686 * lat.cos() / (512.0 * 2f64.powf(t.zoom));
        let (hw, hh) = (window.width_px * m_per_px / 2.0, window.height_px * m_per_px / 2.0);
        let (ce, cn) = frame.projection.to_local(t.center.lon, t.center.lat);
        let (s, c) = t.bearing.to_radians().sin_cos();
        let corner = |dx: f64, dy: f64| frame.on_sheet(ce + dx * c + dy * s, cn - dx * s + dy * c);
        let ring = vec![corner(-hw, hh), corner(hw, hh), corner(hw, -hh), corner(-hw, -hh), corner(-hw, hh)];
        ring.iter().all(|p| p[0].is_finite() && p[1].is_finite()).then_some(ring)
    }) {
        return (area, ProjectionSource::Table);
    }
    // No calibration: the table and the room its ribbons take, at least 2 cm a side.
    let (w, h) = (frame.width_cm, frame.height_cm);
    let reserve = ribbon_settings(site).map(|(_, s)| match s {
        Ribbon::Mode(RibbonMode::Off) => 2.0,
        Ribbon::Mode(RibbonMode::Auto) => RIBBON_AUTO_CM + RIBBON_GAP_CM + 1.0,
        Ribbon::Size(size) => size.cm + RIBBON_GAP_CM + 1.0,
    });
    // reserve is in the order top, bottom, left, right.
    let [top, bottom, left, right] = reserve;
    (rect(-left, -top, w + left + right, h + top + bottom), ProjectionSource::Estimate)
}

/// The image corners on the ground (height 0) through the projector's 3 x 4 matrix.
fn from_projector(projector: &Value, frame: &Frame) -> Option<Vec<Pt>> {
    let m: Vec<f64> = projector["matrix"].as_array()?.iter().filter_map(Value::as_f64).collect();
    let (iw, ih) = (projector["image"]["width"].as_f64()?, projector["image"]["height"].as_f64()?);
    if m.len() != 12 || !(iw > 0.0 && ih > 0.0) {
        return None;
    }
    // On the ground plane the camera is the homography of columns x, y and the translation.
    let h = [[m[0], m[1], m[3]], [m[4], m[5], m[7]], [m[8], m[9], m[11]]];
    let inv = invert(h)?;
    let mut ring = Vec::new();
    for (u, v) in [(0.0, 0.0), (iw, 0.0), (iw, ih), (0.0, ih), (0.0, 0.0)] {
        let x = inv[0][0] * u + inv[0][1] * v + inv[0][2];
        let y = inv[1][0] * u + inv[1][1] * v + inv[1][2];
        let w = inv[2][0] * u + inv[2][1] * v + inv[2][2];
        if w.abs() < 1e-12 {
            return None;
        }
        let p = frame.on_sheet(x / w, y / w);
        // A corner far beyond the table means the image does not meet the ground there.
        if !(p[0].abs() < frame.width_cm * 10.0 && p[1].abs() < frame.height_cm * 10.0) {
            return None;
        }
        ring.push(p);
    }
    Some(ring)
}

fn invert(m: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-15 || !det.is_finite() {
        return None;
    }
    let d = 1.0 / det;
    Some([
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * d,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * d,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * d,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * d,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * d,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * d,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * d,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * d,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * d,
        ],
    ])
}

/// Each side's ribbon setting, top, bottom, left, right. Without `table.ribbons` the front is on auto.
fn ribbon_settings(site: &Site) -> [(&'static str, Ribbon); 4] {
    let table = site.manifest.table;
    let front = front(site);
    let set = table.map(|t| t.ribbons).filter(|r| !r.is_empty());
    let sides = crate::Ribbons::default().sides();
    sides.map(|(side, _)| {
        let setting = match &set {
            Some(r) => r.sides().into_iter().find(|(s, _)| *s == side).and_then(|(_, v)| v).unwrap_or(Ribbon::Mode(RibbonMode::Off)),
            None if side == front => Ribbon::Mode(RibbonMode::Auto),
            None => Ribbon::Mode(RibbonMode::Off),
        };
        (side, setting)
    })
}

fn front(site: &Site) -> &'static str {
    match site.manifest.table.and_then(|t| t.front) {
        Some(TableSide::Top) => "top",
        Some(TableSide::Left) => "left",
        Some(TableSide::Right) => "right",
        _ => "bottom",
    }
}

/// The ribbons that fit, as the table would draw them: side, size in cm, rect, front.
fn ribbon_bands(site: &Site, (w, h): (f64, f64), area: &[Pt], preview: bool) -> Vec<(&'static str, f64, [f64; 4], bool)> {
    let xs = area.iter().map(|p| p[0]);
    let ys = area.iter().map(|p| p[1]);
    let (min_x, max_x) = xs.fold((f64::MAX, f64::MIN), |(a, b), x| (a.min(x), b.max(x)));
    let (min_y, max_y) = ys.fold((f64::MAX, f64::MIN), |(a, b), y| (a.min(y), b.max(y)));
    let free = |side: &str| match side {
        "top" => -min_y,
        "bottom" => max_y - h,
        "left" => -min_x,
        _ => max_x - w,
    };
    let front = front(site);
    let opposite = match front {
        "top" => "bottom",
        "bottom" => "top",
        "left" => "right",
        _ => "left",
    };
    let mut order: Vec<&str> = vec![front];
    order.extend(["bottom", "top", "left", "right"].into_iter().filter(|s| *s != front && *s != opposite));
    order.push(opposite);
    let settings = ribbon_settings(site);
    let mut bands = Vec::new();
    for side in order {
        let setting = settings.iter().find(|(s, _)| *s == side).map(|(_, v)| *v).unwrap_or(Ribbon::Mode(RibbonMode::Off));
        let wanted = match setting {
            Ribbon::Mode(RibbonMode::Off) => continue,
            Ribbon::Mode(RibbonMode::Auto) => RIBBON_AUTO_CM,
            Ribbon::Size(s) => s.cm,
        };
        let room = if preview { wanted } else { (free(side) - RIBBON_GAP_CM).max(0.0) };
        if room < wanted.min(RIBBON_MIN_CM) {
            continue;
        }
        let cm = wanted.min(room);
        let g = RIBBON_GAP_CM;
        let r = match side {
            "bottom" => [0.0, h + g, w, cm],
            "top" => [0.0, -g - cm, w, cm],
            "left" => [-g - cm, 0.0, cm, h],
            _ => [w + g, 0.0, cm, h],
        };
        bands.push((side, cm, r, side == front));
    }
    bands
}

// ---- Writing ----

fn hex((r, g, b): (u8, u8, u8)) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

fn path_data(shape: &Shape) -> String {
    let mut d = String::new();
    let mut ring = |points: &[Pt], close: bool| {
        for (i, p) in points.iter().enumerate() {
            let _ = write!(d, "{}{:.3} {:.3}", if i == 0 { "M" } else { "L" }, p[0], p[1]);
        }
        if close {
            d.push('Z');
        }
    };
    match shape {
        Shape::Area(rings) => rings.iter().for_each(|r| ring(r, true)),
        Shape::Line(line) => ring(line, false),
    }
    d
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The layered drawing: an artboard at the table's real size, the guides in one group and an
/// empty layer to draw in. A plan drawing brought back leaves the guides out.
pub fn svg(sheet: &Sheet) -> String {
    let [l, t, w, h] = sheet.canvas;
    let mut out = String::new();
    let _ = writeln!(out, r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    let _ = writeln!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="{w}cm" height="{h}cm" viewBox="{l} {t} {w} {h}">"#
    );
    let _ = writeln!(out, "  <title>{} starter pack</title>", escape(&sheet.name));
    let (tw, th) = sheet.table_cm;
    let _ = writeln!(out, r#"  <defs><clipPath id="mrs-table"><rect x="0" y="0" width="{tw}" height="{th}"/></clipPath></defs>"#);
    let _ = writeln!(out, r#"  <g id="MR_Studio_guides" inkscape:label="MR Studio guides" inkscape:groupmode="layer">"#);
    for g in &sheet.groups {
        let style = g.feature.style();
        let id = g.feature.name().replace([' ', '-'], "_");
        let fill = style.fill.map(hex).unwrap_or_else(|| "none".into());
        let stroke = style.stroke.map(hex).unwrap_or_else(|| "none".into());
        let dash = if style.dash {
            format!(r#" stroke-dasharray="{:.2} {:.2}""#, style.width_cm * 6.0, style.width_cm * 4.0)
        } else {
            String::new()
        };
        let opacity = if style.alpha < 1.0 { format!(r#" fill-opacity="{}""#, style.alpha) } else { String::new() };
        let clip = if g.feature.on_model() { r#" clip-path="url(#mrs-table)""# } else { "" };
        let _ = writeln!(
            out,
            r#"    <g id="{id}" inkscape:label="{}" inkscape:groupmode="layer" fill="{fill}" stroke="{stroke}" stroke-width="{}" stroke-linejoin="round" stroke-linecap="round" fill-rule="evenodd"{dash}{opacity}{clip}>"#,
            g.feature.name(),
            style.width_cm
        );
        for (i, (shape, _)) in g.shapes.iter().enumerate() {
            let width = g.widths.get(i).copied().flatten().map(|w| format!(r#" stroke-width="{w:.3}""#)).unwrap_or_default();
            let fill = if matches!(shape, Shape::Line(_)) && style.fill.is_some() { r#" fill="none""# } else { "" };
            let _ = writeln!(out, r#"      <path d="{}"{width}{fill}/>"#, path_data(shape));
        }
        if !g.labels.is_empty() {
            let size = sheet.table_cm.0.min(sheet.table_cm.1) / 40.0;
            let _ = writeln!(
                out,
                r##"      <g fill="#999999" stroke="none" font-family="Arial, Helvetica, sans-serif" font-size="{size:.2}" text-anchor="middle" dominant-baseline="central">"##
            );
            for (p, text) in &g.labels {
                let _ = writeln!(out, r#"        <text x="{:.3}" y="{:.3}">{}</text>"#, p[0], p[1], escape(text));
            }
            let _ = writeln!(out, "      </g>");
        }
        let _ = writeln!(out, "    </g>");
    }
    let _ = writeln!(out, "  </g>");
    let _ = writeln!(out, r#"  <g id="Your_drawing" inkscape:label="Your drawing" inkscape:groupmode="layer"></g>"#);
    out.push_str("</svg>\n");
    out
}

/// The picture size for the sheet at the asked resolution, lowered to fit `MAX_PX`.
pub fn picture_size(sheet: &Sheet, px_per_cm: f64) -> (u32, u32, f64) {
    let [_, _, w, h] = sheet.canvas;
    let ppc = px_per_cm.clamp(2.0, 100.0).min(MAX_PX / w.max(h));
    ((w * ppc).round().max(1.0) as u32, (h * ppc).round().max(1.0) as u32, ppc)
}

/// The groups drawn into one transparent PNG.
fn raster(sheet: &Sheet, groups: &[&Group], (pw, ph, ppc): (u32, u32, f64), background: Option<(u8, u8, u8)>) -> Result<Vec<u8>, String> {
    use tiny_skia::{Color, FillRule, LineCap, LineJoin, Mask, Paint, PathBuilder, Pixmap, Rect, Stroke, StrokeDash, Transform};
    let mut pixmap = Pixmap::new(pw, ph).ok_or("the picture would be too big")?;
    if let Some((r, g, b)) = background {
        pixmap.fill(Color::from_rgba8(r, g, b, 255));
    }
    let [l, t, _, _] = sheet.canvas;
    let to = |p: &Pt| (((p[0] - l) * ppc) as f32, ((p[1] - t) * ppc) as f32);
    // The model's frame, for what is shown only on the model.
    let mut model = Mask::new(pw, ph).ok_or("the picture would be too big")?;
    let (x0, y0) = to(&[0.0, 0.0]);
    let (x1, y1) = to(&[sheet.table_cm.0, sheet.table_cm.1]);
    if let Some(r) = Rect::from_ltrb(x0, y0, x1, y1) {
        model.fill_path(&PathBuilder::from_rect(r), FillRule::Winding, false, Transform::identity());
    }
    for g in groups {
        let style = g.feature.style();
        let mask = g.feature.on_model().then_some(&model);
        for (i, (shape, _)) in g.shapes.iter().enumerate() {
            let mut pb = PathBuilder::new();
            let rings: Vec<&Vec<Pt>> = match shape {
                Shape::Area(rings) => rings.iter().collect(),
                Shape::Line(line) => vec![line],
            };
            for ring in &rings {
                for (k, p) in ring.iter().enumerate() {
                    let (x, y) = to(p);
                    if k == 0 {
                        pb.move_to(x, y);
                    } else {
                        pb.line_to(x, y);
                    }
                }
                if matches!(shape, Shape::Area(_)) {
                    pb.close();
                }
            }
            let Some(path) = pb.finish() else { continue };
            if let (Some((r, gr, b)), Shape::Area(_)) = (style.fill, shape) {
                let mut paint = Paint::default();
                paint.set_color_rgba8(r, gr, b, (style.alpha * 255.0) as u8);
                paint.anti_alias = true;
                pixmap.fill_path(&path, &paint, FillRule::EvenOdd, Transform::identity(), mask);
            }
            if let Some((r, gr, b)) = style.stroke {
                let mut paint = Paint::default();
                paint.set_color_rgba8(r, gr, b, 255);
                paint.anti_alias = true;
                let width_cm = g.widths.get(i).copied().flatten().unwrap_or(style.width_cm);
                let width = (width_cm * ppc).max(1.0) as f32;
                let dash = style.dash.then(|| StrokeDash::new(vec![width * 6.0, width * 4.0], 0.0)).flatten();
                let stroke = Stroke { width, line_cap: LineCap::Round, line_join: LineJoin::Round, dash, ..Stroke::default() };
                pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), mask);
            }
        }
    }
    encode_png(&pixmap, ppc)
}

/// PNG with the resolution written in, so Photoshop and PowerPoint size it in centimetres.
fn encode_png(pixmap: &tiny_skia::Pixmap, ppc: f64) -> Result<Vec<u8>, String> {
    // tiny-skia keeps premultiplied colour; PNG wants it straight.
    let mut data = Vec::with_capacity(pixmap.data().len());
    for px in pixmap.pixels() {
        let c = px.demultiply();
        data.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, pixmap.width(), pixmap.height());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let per_metre = (ppc * 100.0).round() as u32;
        encoder.set_pixel_dims(Some(png::PixelDimensions { xppu: per_metre, yppu: per_metre, unit: png::Unit::Meter }));
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&data).map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}

/// The guides as one picture, for the preview and the programs that take a background.
pub fn preview_png(sheet: &Sheet, px_per_cm: f64) -> Result<Vec<u8>, String> {
    let refs: Vec<&Group> = sheet.groups.iter().collect();
    raster(sheet, &refs, picture_size(sheet, px_per_cm), Some((255, 255, 255)))
}

/// One GeoJSON per feature, in WGS84, with the properties MR Studio's Add data reads.
fn geojson(sheet: &Sheet, g: &Group) -> String {
    let features: Vec<Value> = g
        .shapes
        .iter()
        .map(|(shape, props)| {
            let ll = |ring: &Vec<Pt>| ring.iter().map(|p| sheet.frame.lonlat_of(*p)).collect::<Vec<_>>();
            let geometry = match shape {
                Shape::Area(rings) => json!({ "type": "Polygon", "coordinates": rings.iter().map(ll).collect::<Vec<_>>() }),
                Shape::Line(line) => json!({ "type": "LineString", "coordinates": ll(line) }),
            };
            json!({ "type": "Feature", "properties": props, "geometry": geometry })
        })
        .collect();
    serde_json::to_string(&json!({ "type": "FeatureCollection", "name": g.feature.name(), "features": features })).unwrap_or_default()
}

const WEB_MERCATOR_WKT: &str = r#"PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"],AUTHORITY["EPSG","3857"]]"#;

fn web_mercator(p: Pt) -> Pt {
    const R: f64 = 6_378_137.0;
    let (lon, lat) = (p[0].to_radians(), p[1].to_radians());
    [R * lon, R * (std::f64::consts::FRAC_PI_4 + lat / 2.0).tan().ln()]
}

/// A world file that places the picture in Web Mercator (EPSG:3857), rotation included.
pub fn world_file(sheet: &Sheet, (pw, ph, ppc): (u32, u32, f64)) -> String {
    let [l, t, _, _] = sheet.canvas;
    let at = |col: f64, row: f64| {
        let ll = sheet.frame.lonlat_of([l + col / ppc, t + row / ppc]);
        web_mercator(ll)
    };
    let origin = at(0.5, 0.5);
    let (n_col, n_row) = (pw as f64, ph as f64);
    let right = at(0.5 + n_col, 0.5);
    let down = at(0.5, 0.5 + n_row);
    let a = (right[0] - origin[0]) / n_col;
    let d = (right[1] - origin[1]) / n_col;
    let b = (down[0] - origin[0]) / n_row;
    let e = (down[1] - origin[1]) / n_row;
    format!("{a:.10}\n{d:.10}\n{b:.10}\n{e:.10}\n{:.4}\n{:.4}\n", origin[0], origin[1])
}

/// What a pack wrote.
#[derive(Debug, Clone, Serialize)]
pub struct Written {
    pub files: Vec<String>,
    pub bytes: u64,
    pub picture: (u32, u32),
    pub px_per_cm: f64,
    pub projection: ProjectionSource,
    pub notes: Vec<String>,
}

/// Every file of the pack, by path inside it.
pub fn files(site: &Site, options: &Options) -> Result<(Vec<(String, Vec<u8>)>, Sheet, (u32, u32, f64)), String> {
    if options.apps.is_empty() {
        return Err("Choose at least one program to prepare files for.".into());
    }
    let sheet = sheet(site, options);
    if sheet.groups.iter().all(|g| g.shapes.is_empty()) {
        return Err("Nothing to put in the pack: choose at least one thing the table has.".into());
    }
    let size = picture_size(&sheet, options.px_per_cm);
    let all: Vec<&Group> = sheet.groups.iter().collect();
    let guides = raster(&sheet, &all, size, None)?;
    let preview = raster(&sheet, &all, size, Some((255, 255, 255)))?;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    files.push(("preview.png".into(), preview));
    let apps: std::collections::BTreeSet<App> = options.apps.iter().copied().collect();
    for app in &apps {
        let dir = app.folder();
        match app {
            App::Qgis => {
                for g in sheet.groups.iter().filter(|g| !g.shapes.is_empty()) {
                    files.push((format!("{dir}/{}.geojson", g.feature.slug()), geojson(&sheet, g).into_bytes()));
                }
                files.push((format!("{dir}/guides.png"), guides.clone()));
                files.push((format!("{dir}/guides.pgw"), world_file(&sheet, size).into_bytes()));
                files.push((format!("{dir}/guides.prj"), WEB_MERCATOR_WKT.as_bytes().to_vec()));
                files.push((
                    format!("{dir}/guides.png.aux.xml"),
                    format!("<PAMDataset>\n  <SRS>{WEB_MERCATOR_WKT}</SRS>\n</PAMDataset>\n").into_bytes(),
                ));
            }
            App::Illustrator => files.push((format!("{dir}/table.svg"), svg(&sheet).into_bytes())),
            App::Photoshop => {
                for (i, g) in sheet.groups.iter().filter(|g| !g.shapes.is_empty()).enumerate() {
                    files.push((format!("{dir}/layers/{:02}-{}.png", i + 1, g.feature.slug()), raster(&sheet, &[g], size, None)?));
                }
                files.push((format!("{dir}/guides.png"), guides.clone()));
            }
            App::Powerpoint => files.push((format!("{dir}/table.pptx"), pptx(&sheet, &guides)?)),
        }
    }
    files.push(("pack.json".into(), serde_json::to_vec_pretty(&about(site, &sheet, options, size)).unwrap_or_default()));
    files.push(("README.md".into(), readme(site, &sheet, &apps, size).into_bytes()));
    Ok((files, sheet, size))
}

/// The pack's facts, for scripts: the sheet, the canvas and how it maps to the ground.
fn about(site: &Site, sheet: &Sheet, options: &Options, (pw, ph, ppc): (u32, u32, f64)) -> Value {
    let m = &site.manifest;
    let [l, t, w, h] = sheet.canvas;
    let corners: Vec<Pt> = [[l, t], [l + w, t], [l + w, t + h], [l, t + h]].iter().map(|p| sheet.frame.lonlat_of(*p)).collect();
    json!({
        "format": 1,
        "made_by": "MR Studio starter pack (#450)",
        "table": { "id": m.id, "name": m.name, "width_cm": sheet.table_cm.0, "height_cm": sheet.table_cm.1, "tile_cm": m.table.and_then(|t| t.tile_cm) },
        "ground": { "origin": m.origin, "width_m": m.extent.width_m, "height_m": m.extent.height_m, "rotation_deg": m.extent.rotation_deg, "m_per_cm": sheet.m_per_cm, "scale": format!("1:{:.0}", sheet.m_per_cm * 100.0) },
        "canvas": { "kind": options.canvas, "left_cm": l, "top_cm": t, "width_cm": w, "height_cm": h, "corners_lonlat": corners },
        "picture": { "width_px": pw, "height_px": ph, "px_per_cm": ppc },
        "projection_area": sheet.projection,
        "features": sheet.groups.iter().map(|g| json!({ "id": g.feature.id(), "name": g.feature.name(), "count": g.shapes.len() })).collect::<Vec<_>>(),
    })
}

/// Writes the pack as a zip at `out`, with everything inside one folder named after the table.
pub fn write(site: &Site, options: &Options, out: &Path) -> Result<Written, String> {
    let (files, sheet, size) = files(site, options)?;
    let root = format!("{} starter pack", crate::package::folder_name(&sheet.name));
    let partial = out.with_extension("partial");
    let result = (|| -> Result<(), String> {
        let file = std::fs::File::create(&partial).map_err(|e| format!("could not write {}: {e}", partial.display()))?;
        let mut zip = ZipWriter::new(file);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (path, bytes) in &files {
            zip.start_file(format!("{root}/{path}"), deflated).map_err(|e| e.to_string())?;
            zip.write_all(bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
        std::fs::rename(&partial, out).map_err(|e| format!("could not write {}: {e}", out.display()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result?;
    let bytes = std::fs::metadata(out).map(|m| m.len()).unwrap_or_default();
    Ok(Written {
        files: files.into_iter().map(|(p, _)| p).collect(),
        bytes,
        picture: (size.0, size.1),
        px_per_cm: size.2,
        projection: sheet.projection,
        notes: sheet.notes,
    })
}

// ---- PowerPoint ----

/// 360 000 EMU to the centimetre.
const EMU_PER_CM: f64 = 360_000.0;
/// PowerPoint's largest slide side, 56 inches.
const MAX_SLIDE_CM: f64 = 142.24;

/// A one-slide presentation the shape of the canvas, at its real size when PowerPoint allows,
/// with the guides as a picture to hide before exporting the slide as a picture.
fn pptx(sheet: &Sheet, guides: &[u8]) -> Result<Vec<u8>, String> {
    let [_, _, w, h] = sheet.canvas;
    let scale = (MAX_SLIDE_CM / w.max(h)).min(1.0);
    let (cx, cy) = ((w * scale * EMU_PER_CM).round() as i64, (h * scale * EMU_PER_CM).round() as i64);
    let mut files: BTreeMap<&str, String> = BTreeMap::new();
    files.insert("[Content_Types].xml", PPTX_TYPES.into());
    files.insert("_rels/.rels", PPTX_RELS.into());
    files.insert("docProps/app.xml", PPTX_APP.into());
    files.insert("docProps/core.xml", PPTX_CORE.replace("{title}", &escape(&format!("{} starter pack", sheet.name))));
    files.insert("ppt/presentation.xml", PPTX_PRESENTATION.replace("{cx}", &cx.to_string()).replace("{cy}", &cy.to_string()));
    files.insert("ppt/_rels/presentation.xml.rels", PPTX_PRESENTATION_RELS.into());
    files.insert("ppt/presProps.xml", PPTX_PRES_PROPS.into());
    files.insert("ppt/viewProps.xml", PPTX_VIEW_PROPS.into());
    files.insert("ppt/tableStyles.xml", PPTX_TABLE_STYLES.into());
    files.insert("ppt/theme/theme1.xml", PPTX_THEME.into());
    files.insert("ppt/slideMasters/slideMaster1.xml", PPTX_MASTER.into());
    files.insert("ppt/slideMasters/_rels/slideMaster1.xml.rels", PPTX_MASTER_RELS.into());
    files.insert("ppt/slideLayouts/slideLayout1.xml", PPTX_LAYOUT.into());
    files.insert("ppt/slideLayouts/_rels/slideLayout1.xml.rels", PPTX_LAYOUT_RELS.into());
    files.insert("ppt/slides/slide1.xml", PPTX_SLIDE.replace("{cx}", &cx.to_string()).replace("{cy}", &cy.to_string()));
    files.insert("ppt/slides/_rels/slide1.xml.rels", PPTX_SLIDE_RELS.into());
    let mut bytes = Vec::new();
    {
        let mut zip = ZipWriter::new(std::io::Cursor::new(&mut bytes));
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        // The content types come first, as Office writes them.
        let types = files.remove("[Content_Types].xml").unwrap_or_default();
        zip.start_file("[Content_Types].xml", deflated).map_err(|e| e.to_string())?;
        zip.write_all(types.as_bytes()).map_err(|e| e.to_string())?;
        for (path, text) in &files {
            zip.start_file(*path, deflated).map_err(|e| e.to_string())?;
            zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        zip.start_file("ppt/media/guides.png", SimpleFileOptions::default().compression_method(CompressionMethod::Stored))
            .map_err(|e| e.to_string())?;
        zip.write_all(guides).map_err(|e| e.to_string())?;
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}

const PPTX_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>"#;

const PPTX_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>"#;

const PPTX_APP: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>MR Studio</Application><Slides>1</Slides></Properties>"#;

const PPTX_CORE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{title}</dc:title><dc:creator>MR Studio</dc:creator></cp:coreProperties>"#;

const PPTX_PRESENTATION: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="{cx}" cy="{cy}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>"#;

const PPTX_PRESENTATION_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/></Relationships>"#;

const PPTX_PRES_PROPS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>"#;

const PPTX_VIEW_PROPS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>"#;

const PPTX_TABLE_STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>"#;

const PPTX_THEME: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MR Studio"><a:themeElements><a:clrScheme name="MR Studio"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2328"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="E8590C"/></a:accent1><a:accent2><a:srgbClr val="1971C2"/></a:accent2><a:accent3><a:srgbClr val="2F9E44"/></a:accent3><a:accent4><a:srgbClr val="F59F00"/></a:accent4><a:accent5><a:srgbClr val="7048E8"/></a:accent5><a:accent6><a:srgbClr val="C2255C"/></a:accent6><a:hlink><a:srgbClr val="1971C2"/></a:hlink><a:folHlink><a:srgbClr val="7048E8"/></a:folHlink></a:clrScheme><a:fontScheme name="MR Studio"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="MR Studio"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"#;

const PPTX_MASTER: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>"#;

const PPTX_MASTER_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>"#;

const PPTX_LAYOUT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#;

const PPTX_LAYOUT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#;

const PPTX_SLIDE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:pic><p:nvPicPr><p:cNvPr id="2" name="MR Studio guides (hide before you export)" descr="The table's outline and features, from MR Studio"/><p:cNvPicPr><a:picLocks noGrp="1" noChangeAspect="1" noMove="1" noResize="1" noRot="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#;

const PPTX_SLIDE_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/guides.png"/></Relationships>"#;

// ---- Instructions ----

fn readme(site: &Site, sheet: &Sheet, apps: &std::collections::BTreeSet<App>, (pw, ph, ppc): (u32, u32, f64)) -> String {
    let m = &site.manifest;
    let [_, _, w, h] = sheet.canvas;
    let (tw, th) = sheet.table_cm;
    let table_canvas = sheet.canvas == [0.0, 0.0, tw, th];
    let mut out = String::new();
    let _ = writeln!(out, "# {} starter pack\n", sheet.name);
    let _ = writeln!(out, "Made by MR Studio to draw on the table in another program and bring the result back in place.\n");
    let _ = writeln!(
        out,
        "- Table: {tw:.1} x {th:.1} cm, showing {:.0} x {:.0} m of ground (1 cm on the table is {:.1} m, scale 1:{:.0}).",
        m.extent.width_m,
        m.extent.height_m,
        sheet.m_per_cm,
        sheet.m_per_cm * 100.0
    );
    if m.extent.rotation_deg.abs() > 1e-6 {
        let _ = writeln!(out, "- The table's top edge faces {:.1}° from north, so north is not straight up.", m.extent.rotation_deg);
    }
    let _ = writeln!(
        out,
        "- Canvas: {w:.1} x {h:.1} cm, {}. Pictures are {pw} x {ph} px ({ppc:.0} px per cm).",
        if table_canvas { "exactly the table's frame" } else { "the table and the projector's image around it" }
    );
    let _ = writeln!(
        out,
        "- Inside: {}.",
        sheet.groups.iter().filter(|g| !g.shapes.is_empty()).map(|g| g.feature.name().to_lowercase()).collect::<Vec<_>>().join(", ")
    );
    for note in &sheet.notes {
        let _ = writeln!(out, "- Note: {note}");
    }
    let _ = writeln!(out, "\n`preview.png` shows everything together. `pack.json` has the same facts for scripts.\n");
    if !table_canvas {
        let _ = writeln!(
            out,
            "**This canvas is bigger than the table.** It is for art in the projector's margins around the model. For a layer on the table itself, make the pack again with the table canvas, so the drawing lands in place when it comes back.\n"
        );
    }
    for app in apps {
        out.push_str(match app {
            App::Qgis => QGIS_HOW,
            App::Illustrator => ILLUSTRATOR_HOW,
            App::Photoshop => PHOTOSHOP_HOW,
            App::Powerpoint => POWERPOINT_HOW,
        });
        out.push('\n');
    }
    out.push_str(BACK_HOW);
    out
}

const QGIS_HOW: &str = "## QGIS (folder `qgis`)

1. Drag the `.geojson` files into QGIS. They are in WGS84 (EPSG:4326), with each feature's own properties, and QGIS places them by themselves.
2. Drag in `guides.png` too: it is placed in Web Mercator (EPSG:3857) by `guides.pgw`. If QGIS asks for its coordinate system, choose EPSG:3857.
3. `table-outline.geojson` is the exact ground the table shows. Draw or edit your own layers inside it, in any coordinate system.
4. To bring a layer back: right-click it, Export, Save Features As…, Format GeoJSON, coordinate system EPSG:4326. MR Studio also reads CSV with lon and lat, zipped Shapefiles and GeoTIFF terrain.
5. For a picture instead (a styled map): Project, New Print Layout, add a map whose extent is the table outline (with the map rotated by the table's angle when it has one), and export it as PNG at the canvas size above. It then comes back as a picture.
";

const ILLUSTRATOR_HOW: &str = "## Illustrator (folder `illustrator`)

1. Open `table.svg` with File, Open. The artboard is the canvas at its real size in centimetres.
2. The guides are in the group **MR Studio guides** (table outline, tiles, buildings, streets…). Lock it in the Layers panel so you draw over it without moving it.
3. Draw in **Your drawing**. Each group or layer you make there becomes one step MR Studio can reveal in turn, such as a project's phases.
4. Save with File, Export, Export As…, SVG, Styling: Presentation Attributes, Object IDs: Layer Names. Keep the artboard as it is: MR Studio stretches the drawing over the table.
5. You can leave the guides in: MR Studio drops the group named MR Studio guides when the drawing comes back. Inkscape and Affinity Designer open the same file.
";

const PHOTOSHOP_HOW: &str = "## Photoshop (folder `photoshop`)

1. File, Scripts, Load Files into Stack…, Browse, and pick every PNG in `layers`. Each becomes its own layer, all lined up, on transparent ground. (Or open `guides.png` for all of them in one layer.)
2. Add your own layers above them. The picture's resolution is set, so Image, Image Size shows the table's real size in centimetres.
3. Hide the guide layers, then File, Export, Export As…, PNG (or JPEG). Do not crop or resize: MR Studio stretches the picture over the table, so the canvas must stay this shape. GIMP and Affinity Photo open the same files as layers too.
";

const POWERPOINT_HOW: &str = "## PowerPoint (folder `powerpoint`)

1. Open `table.pptx`. Its one slide has the canvas's shape (its real size, or scaled down when the table is wider than PowerPoint's 142 cm), with the guides as a locked picture.
2. Draw on the slide: shapes, text, pictures, icons. Keep everything inside the slide.
3. Before you export, hide the guides: Home, Arrange, Selection Pane, and click the eye beside **MR Studio guides**. Pick a background in Design, Format Background, or leave it white.
4. File, Export, Change File Type, PNG, and choose Just this one. For a sharper picture, Keynote and Google Slides can also export the slide as a PNG at a set size.
";

const BACK_HOW: &str = "## Bringing it back into MR Studio

Open the table in MR Studio's editor.

- **A picture** (PNG or JPEG from Photoshop, PowerPoint or a QGIS print layout): Insert, Picture, then show it with the Picture or video layer or as a slideshow step. With Fit set to Stretch it covers the table exactly.
- **A drawing** (SVG from Illustrator or Inkscape): Insert, Data file, or View, Media library, Add media, then Show on the table: it becomes a Masterplan, and each group of Your drawing is a step.
- **GIS data** (GeoJSON, CSV, Shapefile from QGIS): Insert, Data file. MR Studio shows where it lies against the table before it comes in, then style it as a Map data or custom layer.
- Art made on the projection canvas is for the margins and the at-a-glance boxes; ask for it in the project's issues if you need it shown there.
";

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read as _;

    fn sample() -> Site {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sites/sample");
        Site::load(dir).expect("the sample site loads")
    }

    #[test]
    fn the_sheet_maps_the_extent_onto_the_table() {
        let site = sample();
        let s = sheet(&site, &Options::default());
        let (w, h) = s.table_cm;
        let f = s.frame;
        let centre = f.on_sheet(0.0, 0.0);
        assert!((centre[0] - w / 2.0).abs() < 1e-9 && (centre[1] - h / 2.0).abs() < 1e-9);
        for p in [[0.0, 0.0], [w, 0.0], [w, h], [3.0, 7.5]] {
            let (e, n) = f.local_of(p);
            let back = f.on_sheet(e, n);
            assert!((back[0] - p[0]).abs() < 1e-9 && (back[1] - p[1]).abs() < 1e-9);
        }
        // The table's top-left corner is the site's top-left corner.
        let info = site.info();
        let tl = f.lonlat_of([0.0, 0.0]);
        assert!((tl[0] - info.corners[0][0]).abs() < 1e-5 && (tl[1] - info.corners[0][1]).abs() < 1e-5, "{tl:?} {:?}", info.corners[0]);
    }

    #[test]
    fn tiles_are_named_like_cells() {
        let g = tiles(50.0, 30.0, 20.0);
        assert_eq!(g.shapes.len(), 3 * 2);
        assert_eq!(g.labels[0].1, "A1");
        assert_eq!(g.labels[5].1, "C2");
        assert_eq!(column_name(26), "AA");
        // The last column is the part tile that is left.
        let Shape::Area(rings) = &g.shapes[2].0 else { panic!() };
        assert!((rings[0][1][0] - 50.0).abs() < 1e-9);
    }

    #[test]
    fn ribbons_follow_the_runtime_rules() {
        let mut site = sample();
        site.manifest.table =
            Some(crate::Table { width_cm: 100.0, height_cm: 60.0, tile_cm: None, front: None, ribbons: Default::default(), glow: None });
        let area = rect(-5.0, -5.0, 110.0, 80.0);
        // Only the front (bottom) is auto; 15 cm free below, so it gets the full 9 cm.
        let bands = ribbon_bands(&site, (100.0, 60.0), &area, false);
        assert_eq!(bands.len(), 1);
        assert_eq!(bands[0].0, "bottom");
        assert!((bands[0].1 - 9.0).abs() < 1e-9);
        assert!((bands[0].2[1] - 60.5).abs() < 1e-9);
        // With 3 cm free it does not fit at all.
        let tight = rect(-5.0, -5.0, 110.0, 68.0);
        assert!(ribbon_bands(&site, (100.0, 60.0), &tight, false).is_empty());
    }

    #[test]
    fn a_projector_calibration_gives_the_image_on_the_ground() {
        let site = sample();
        let s = sheet(&site, &Options::default());
        // A straight-down camera: 10 px per metre, image 2000 x 1000 centred on the origin.
        let m = json!({ "matrix": [10.0, 0.0, 0.0, 1000.0, 0.0, -10.0, 0.0, 500.0, 0.0, 0.0, 0.0, 1.0], "image": { "width": 2000, "height": 1000 } });
        let ring = from_projector(&m, &s.frame).expect("an area");
        let (e, n) = s.frame.local_of(ring[0]);
        assert!((e + 100.0).abs() < 1e-6 && (n - 50.0).abs() < 1e-6, "{e} {n}");
    }

    #[test]
    fn the_world_file_puts_the_picture_on_the_ground() {
        let site = sample();
        let s = sheet(&site, &Options::default());
        let size = picture_size(&s, 10.0);
        let text = world_file(&s, size);
        let v: Vec<f64> = text.lines().map(|l| l.parse().unwrap()).collect();
        // The far corner, through the world file, lands on the table's bottom-right corner.
        let (col, row) = (size.0 as f64 - 1.0, size.1 as f64 - 1.0);
        let x = v[0] * col + v[2] * row + v[4];
        let y = v[1] * col + v[3] * row + v[5];
        let want = web_mercator(s.frame.lonlat_of([s.table_cm.0 - 0.5 / size.2, s.table_cm.1 - 0.5 / size.2]));
        assert!((x - want[0]).abs() < 0.5 && (y - want[1]).abs() < 0.5, "{x} {y} {want:?}");
    }

    #[test]
    fn a_pack_has_files_for_each_program_and_its_guides_come_back_out_of_a_plan() {
        let site = sample();
        let options = Options { features: Feature::ALL.to_vec(), ..Options::default() };
        let out = std::env::temp_dir().join(format!("mrs-starter-{}.zip", std::process::id()));
        let written = write(&site, &options, &out).unwrap();
        for want in [
            "README.md",
            "pack.json",
            "preview.png",
            "qgis/table-outline.geojson",
            "qgis/guides.pgw",
            "illustrator/table.svg",
            "photoshop/guides.png",
            "powerpoint/table.pptx",
        ] {
            assert!(written.files.iter().any(|f| f == want), "{want} missing from {:?}", written.files);
        }
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let root = format!("{} starter pack", crate::package::folder_name(&site.manifest.name));
        let mut text = String::new();
        zip.by_name(&format!("{root}/illustrator/table.svg")).unwrap().read_to_string(&mut text).unwrap();
        // The drawing as it comes back: the guides are dropped, Your drawing stays.
        let with_art = text.replace(
            "<g id=\"Your_drawing\" inkscape:label=\"Your drawing\" inkscape:groupmode=\"layer\"></g>",
            "<g id=\"Your_drawing\"><g id=\"Phase_1\"><rect width=\"5\" height=\"5\"/></g></g>",
        );
        let plan = crate::plan::read(&with_art).unwrap();
        assert_eq!(plan.phases.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Phase 1"]);
        assert!(!plan.svg.contains("Building_footprints"));
        let mut pptx = Vec::new();
        zip.by_name(&format!("{root}/powerpoint/table.pptx")).unwrap().read_to_end(&mut pptx).unwrap();
        let mut deck = zip::ZipArchive::new(std::io::Cursor::new(pptx)).unwrap();
        assert!(deck.by_name("ppt/media/guides.png").is_ok());
        let _ = std::fs::remove_file(&out);
    }
}
