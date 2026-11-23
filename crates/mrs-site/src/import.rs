//! Bringing a file into a site: buildings, trees, walkways, trips or any named dataset.
//!
//! `inspect` reads a file, works out what it is and where it lands, and reports in the
//! author's terms without writing anything. `apply` writes what `inspect` prepared into
//! the site's `data/` folder and points `site.json` at it. The host re-bakes afterwards.
//!
//! Every problem is an [`Issue`]: a stable code, a severity and one plain sentence. Only
//! a blocker stops an import; warnings and notes travel with the report.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::geotiff::GeoRaster;
use crate::osm;
use crate::{Crs, Projection, Site, SiteError};

/// The most features a report's preview carries. The import itself keeps them all.
pub const PREVIEW_LIMIT: usize = 5000;
/// Features further than this share of the extent outside it are dropped by `crop`.
const CROP_MARGIN: f64 = 0.1;
/// Used when a building has a number of storeys but no height.
const METRES_PER_STOREY: f64 = 3.0;

/// Where an imported file goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// Footprint polygons, raised into the scene: `scene.buildings`.
    Buildings,
    /// Tree points: `scene.trees`.
    Trees,
    /// Paths people walk: the `walkways` dataset (cool paths).
    Walkways,
    /// The mobility layer's `trips.json`: the `trips` dataset.
    Trips,
    /// Ground elevation as a GeoTIFF: `scene.terrain`.
    Terrain,
    /// Any other GeoJSON dataset, by name.
    Data(String),
}

impl Target {
    /// `buildings`, `trees`, `walkways`, `trips`, or `data:<name>`.
    pub fn parse(text: &str) -> Result<Self, String> {
        Ok(match text {
            "buildings" => Self::Buildings,
            "trees" => Self::Trees,
            "walkways" => Self::Walkways,
            "trips" => Self::Trips,
            "terrain" => Self::Terrain,
            other => {
                let name = other.strip_prefix("data:").ok_or_else(|| {
                    format!("'{other}' is not something a table can take; use buildings, trees, walkways, trips, terrain or data:<name>")
                })?;
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
                    return Err("a dataset name is lowercase letters, digits, dashes and underscores".into());
                }
                match name {
                    "buildings" => Self::Buildings,
                    "trees" => Self::Trees,
                    "walkways" => Self::Walkways,
                    "trips" => Self::Trips,
                    "terrain" => Self::Terrain,
                    _ => Self::Data(name.to_string()),
                }
            }
        })
    }

    /// The dataset name layers know it by.
    pub fn name(&self) -> &str {
        match self {
            Self::Buildings => "buildings",
            Self::Trees => "trees",
            Self::Walkways => "walkways",
            Self::Trips => "trips",
            Self::Terrain => "terrain",
            Self::Data(name) => name,
        }
    }

    /// The file it is saved as, relative to the site folder.
    pub fn path(&self) -> String {
        match self {
            Self::Trips => "data/trips.json".into(),
            Self::Terrain => "data/terrain.tif".into(),
            other => format!("data/{}.geojson", other.name()),
        }
    }

    /// Words for one item, singular and plural.
    fn noun(&self) -> (&'static str, &'static str) {
        match self {
            Self::Buildings => ("building", "buildings"),
            Self::Trees => ("tree", "trees"),
            Self::Walkways => ("path", "paths"),
            Self::Trips => ("trip", "trips"),
            Self::Terrain => ("terrain", "terrain"),
            Self::Data(_) => ("feature", "features"),
        }
    }

    /// The geometry kind it needs, if any.
    fn shape(&self) -> Option<Shape> {
        match self {
            Self::Buildings => Some(Shape::Area),
            Self::Trees => Some(Shape::Point),
            Self::Walkways => Some(Shape::Line),
            Self::Trips | Self::Terrain | Self::Data(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    Point,
    Line,
    Area,
}

impl Shape {
    fn of(geometry_type: &str) -> Option<Self> {
        match geometry_type {
            "Point" | "MultiPoint" => Some(Self::Point),
            "LineString" | "MultiLineString" => Some(Self::Line),
            "Polygon" | "MultiPolygon" => Some(Self::Area),
            _ => None,
        }
    }

    fn words(self) -> &'static str {
        match self {
            Self::Point => "points",
            Self::Line => "lines",
            Self::Area => "areas",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Blocker,
    Warning,
    Note,
}

#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    /// Stable, for tests and assistants: `coords.swapped`.
    pub code: &'static str,
    pub severity: Severity,
    /// One plain sentence for a person.
    pub message: String,
    /// The option that applies the recommended fix, when there is one: `swap`, `crop`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<&'static str>,
}

impl Issue {
    fn new(code: &'static str, severity: Severity, message: impl Into<String>) -> Self {
        Self { code, severity, message: message.into(), fix: None }
    }

    fn fix(mut self, option: &'static str) -> Self {
        self.fix = Some(option);
        self
    }
}

/// Which coordinate system the file was read in.
#[derive(Debug, Clone, Serialize)]
pub struct CrsReport {
    /// `EPSG:4326`, `EPSG:3006`, ...
    pub code: String,
    /// True when the file did not say, and the system was chosen because it puts the data on the table.
    pub guessed: bool,
}

/// What `inspect` found, and after `apply`, what was written.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// False when a blocker stops the import.
    pub ok: bool,
    pub target: String,
    /// One sentence: "788 buildings, 702 with a height".
    pub summary: String,
    /// Items read from the file.
    pub count: usize,
    /// Items on the table.
    pub inside: usize,
    /// Items off the table.
    pub outside: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crs: Option<CrsReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height_property: Option<String>,
    pub issues: Vec<Issue>,
    /// What will be written, in WGS84, at most `PREVIEW_LIMIT` features. Not for trips.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<Value>,
    /// Where it was saved, after `apply`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl Report {
    /// Adds a note, such as the credit for data fetched on the author's behalf.
    pub fn note(&mut self, code: &'static str, message: impl Into<String>) {
        self.issues.push(Issue::new(code, Severity::Note, message));
    }

    /// A report that stops before reading anything: one blocker, nothing counted.
    pub fn refused(target: &Target, code: &'static str, message: impl Into<String>, summary: impl Into<String>) -> Self {
        Self {
            ok: false,
            target: target.name().to_string(),
            summary: summary.into(),
            count: 0,
            inside: 0,
            outside: 0,
            crs: None,
            height_property: None,
            issues: vec![Issue::new(code, Severity::Blocker, message)],
            preview: None,
            path: None,
        }
    }
}

/// Choices the author made after a first look.
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Leave out what lies well outside the table.
    pub crop: bool,
    /// Read the first coordinate as latitude.
    pub swap: bool,
    /// The EPSG code of a terrain GeoTIFF that does not name its coordinate system.
    pub crs: Option<u32>,
}

/// A file read and checked, ready for `apply`.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub target: Target,
    pub report: Report,
    /// The file to write, when the report is ok.
    content: Option<Vec<u8>>,
    /// For terrain: the coordinate system the author named, written beside the path.
    terrain_crs: Option<String>,
    /// Where it is saved, when not where the target usually goes: a table without positions is a CSV.
    file: Option<String>,
}

/// Reads and checks `bytes` (a file called `filename`) as `target` for `site`. Writes nothing.
pub fn inspect(site: &Site, target: &Target, filename: &str, bytes: &[u8], options: Options) -> Prepared {
    let mut issues = Vec::new();
    let (singular, plural) = target.noun();
    let refuse = |issues: Vec<Issue>, summary: String| Prepared {
        target: target.clone(),
        report: Report {
            ok: false,
            target: target.name().to_string(),
            summary,
            count: 0,
            inside: 0,
            outside: 0,
            crs: None,
            height_property: None,
            issues,
            preview: None,
            path: None,
        },
        content: None,
        terrain_crs: None,
        file: None,
    };

    if *target == Target::Terrain {
        return terrain(site, bytes, options.crs);
    }

    let text = match decode(bytes) {
        Ok((text, recoded)) => {
            if recoded {
                issues.push(Issue::new(
                    "read.encoding",
                    Severity::Note,
                    "Letters like å and ö were not in UTF-8, so the file was read as Windows-1252.",
                ));
            }
            text
        }
        Err(kind) => {
            let message = format!("This file can't be read as data. It looks like {kind}. Use GeoJSON or CSV.");
            return refuse(vec![Issue::new("read.unknown", Severity::Blocker, message)], "Not a file MR Studio can read.".into());
        }
    };

    if *target == Target::Trips {
        return trips(site, target, &text, issues);
    }

    // Features in the file's own coordinates.
    let (mut features, declared) = match read_features(&text, filename, &mut issues) {
        Ok(read) => read,
        // A named dataset may be a plain table (activity, flows, links for place motions, #160).
        Err(issue) if issue.code == "pos.none" && matches!(target, Target::Data(_)) => return table(site, target, &text, issues),
        Err(issue) => return refuse(vec![issue], "Not a file MR Studio can read.".into()),
    };
    if features.is_empty() {
        issues.push(Issue::new("read.empty", Severity::Blocker, "The file holds no places, lines or areas."));
        return refuse(issues, format!("No {plural} in the file."));
    }

    // The geometry the target needs.
    if let Some(shape) = target.shape() {
        let before = features.len();
        let mut others: BTreeMap<&'static str, usize> = BTreeMap::new();
        features.retain(|f| {
            let kind = f["geometry"]["type"].as_str().and_then(Shape::of);
            if kind == Some(shape) {
                return true;
            }
            *others.entry(kind.map_or("other shapes", Shape::words)).or_default() += 1;
            false
        });
        if features.is_empty() {
            let found = others.iter().map(|(k, n)| format!("{n} {k}")).collect::<Vec<_>>().join(" and ");
            let message = format!("{} need {}, and this file has {found}.", capital(plural), shape.words());
            issues.push(Issue::new("geom.wrong", Severity::Blocker, message));
            return refuse(issues, format!("No {plural} in the file."));
        }
        if features.len() < before {
            let left = others.iter().map(|(k, n)| format!("{n} {k}")).collect::<Vec<_>>().join(" and ");
            issues.push(Issue::new("geom.mixed", Severity::Warning, format!("The file also has {left}, which were left out.")));
        }
    }

    // Coordinates: the file's own system, else the one that puts it on the table.
    let crs = match choose_crs(site, &features, declared.as_deref(), options.swap) {
        Ok(choice) => choice,
        Err(issue) => {
            issues.push(issue);
            return refuse(issues, format!("{} {plural} that don't land on this table.", features.len()));
        }
    };
    if crs.guessed && crs.crs != Crs::Geographic {
        issues.push(Issue::new(
            "coords.projected",
            Severity::Note,
            format!("Coordinates are metres on a national grid. Read as {}, they land on your table.", crs.code),
        ));
    }
    if options.swap {
        issues.push(Issue::new("coords.swapped", Severity::Note, "Latitude and longitude were swapped, as asked."));
    }
    for feature in &mut features {
        let geometry = &mut feature["geometry"];
        map_positions(&mut geometry["coordinates"], &|x, y| {
            let (x, y) = if options.swap { (y, x) } else { (x, y) };
            let (lon, lat) = crs.crs.inverse(x, y);
            (round7(lon), round7(lat))
        });
    }

    // Where it lands. The preview is taken before any crop, so the editor can draw
    // what lies off the table against the table's outline.
    let preview = preview_of(&features);
    let frame = Frame::new(site);
    let inside = features.iter().filter(|f| frame.touches(&f["geometry"], 0.0)).count();
    let count = features.len();
    let outside = count - inside;
    if inside == 0 {
        let away = frame.distance_words(&features);
        let message = format!("None of the {count} {plural} are on your table. They are {away}.");
        issues.push(Issue::new("extent.outside_all", Severity::Blocker, message));
        let mut refused = refuse(issues, format!("{count} {plural}, none on the table."));
        (refused.report.count, refused.report.outside) = (count, count);
        refused.report.crs = Some(CrsReport { code: crs.code, guessed: crs.guessed });
        refused.report.preview = Some(preview);
        return refused;
    }
    if options.crop {
        let before = features.len();
        features.retain(|f| frame.touches(&f["geometry"], CROP_MARGIN));
        let dropped = before - features.len();
        if dropped > 0 {
            issues.push(Issue::new("extent.cropped", Severity::Note, format!("{dropped} {plural} well outside the table were left out.")));
        }
    } else if outside > 0 {
        let message = format!("{outside} of {count} {plural} are outside the table.");
        issues.push(Issue::new("extent.outside_some", Severity::Warning, message).fix("crop"));
    }

    // Heights, for what the scene raises.
    let mut height_property = None;
    let mut summary = format!("{} {}", count, if count == 1 { singular } else { plural });
    match target {
        Target::Buildings => {
            let (property, known, estimated) = building_heights(&mut features);
            if estimated > 0 {
                issues.push(Issue::new(
                    "height.estimated",
                    Severity::Note,
                    format!("{estimated} {plural} had storeys but no height; each storey counts as {METRES_PER_STOREY} m."),
                ));
            }
            let unknown = features.len() - known - estimated;
            if unknown > 0 {
                let default = site.manifest.scene.buildings.as_ref().map_or(12.0, |b| b.default_height_m);
                issues.push(Issue::new(
                    "height.missing",
                    Severity::Note,
                    format!("{unknown} {plural} have no height and will stand {default} m tall."),
                ));
            }
            summary = format!("{summary}, {} with a height", known + estimated);
            height_property = Some(property);
        }
        Target::Trees => {
            let names = property_names(&features, &["height", "height_m", "höjd", "hojd", "höjd_m", "hojd_m", "trädhöjd", "tradhojd", "h"]);
            let property = names.iter().find(|p| features.iter().any(|f| number(&f["properties"][p.as_str()]).is_some_and(|h| h > 0.0)));
            let known =
                property.map_or(0, |p| features.iter().filter(|f| number(&f["properties"][p.as_str()]).is_some_and(|h| h > 0.0)).count());
            if known < features.len() {
                let default = site.manifest.scene.trees.as_ref().map_or(8.0, |t| t.default_height_m);
                let message = format!("{} {plural} have no height and will stand {default} m tall.", features.len() - known);
                issues.push(Issue::new("height.missing", Severity::Note, message));
            }
            summary = format!("{summary}, {known} with a height");
            height_property = Some(property.cloned().unwrap_or_else(|| "height".to_string()));
        }
        _ => {}
    }
    if outside > 0 {
        summary = format!("{summary}; {inside} on the table");
    }
    if let Some(existing) = site.data().get(target.name()) {
        issues.push(Issue::new("data.replaces", Severity::Note, format!("This replaces the table's {} ({existing}).", target.name())));
    }

    let mut collection = json!({ "type": "FeatureCollection", "features": features });
    if let Some(source) = source_of(&text) {
        if source["name"] == "OpenStreetMap" {
            let message = format!("From OpenStreetMap ({}, ODbL). Show this credit wherever the table is shown.", osm::ATTRIBUTION);
            issues.push(Issue::new("source.osm", Severity::Note, message));
        }
        collection["source"] = source;
    }
    let content = json_file(&collection);
    Prepared {
        target: target.clone(),
        report: Report {
            ok: !issues.iter().any(|i| i.severity == Severity::Blocker),
            target: target.name().to_string(),
            summary,
            count,
            inside,
            outside,
            crs: Some(CrsReport { code: crs.code, guessed: crs.guessed }),
            height_property,
            issues,
            preview: Some(preview),
            path: None,
        },
        content: Some(content),
        terrain_crs: None,
        file: None,
    }
}

/// The first features, in file order, for the editor to draw.
fn preview_of(features: &[Value]) -> Value {
    json!({ "type": "FeatureCollection", "features": features.iter().take(PREVIEW_LIMIT).cloned().collect::<Vec<_>>() })
}

/// A GeoJSON file's top-level `source` member (where the data came from), kept on import.
fn source_of(text: &str) -> Option<Value> {
    if !text.contains("\"source\"") {
        return None;
    }
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    value.get("source").filter(|s| s.is_object()).cloned()
}

/// Compact JSON with a final newline.
fn json_file(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).expect("json");
    bytes.push(b'\n');
    bytes
}

/// Writes a prepared import into the site and returns the site as it now loads.
/// The data file and `site.json` are each replaced in one step; if the new manifest
/// does not load, the old one is put back.
pub fn apply(site: &Site, mut prepared: Prepared) -> Result<(Site, Report), SiteError> {
    let content = match (&prepared.content, prepared.report.ok) {
        (Some(content), true) => content,
        _ => return Err(SiteError::Invalid(prepared.report.issues.iter().map(|i| i.message.clone()).collect())),
    };
    let relative = prepared.file.clone().unwrap_or_else(|| prepared.target.path());
    let file = site.dir.join(&relative);
    let io = |path: &Path| {
        let path = path.to_path_buf();
        move |source| SiteError::Io { path, source }
    };
    std::fs::create_dir_all(file.parent().expect("inside data/")).map_err(io(&file))?;
    let temporary = file.with_extension("import.tmp");
    std::fs::write(&temporary, content).map_err(io(&temporary))?;
    std::fs::rename(&temporary, &file).map_err(io(&file))?;

    let manifest_path = site.dir.join("site.json");
    let before = std::fs::read_to_string(&manifest_path).map_err(io(&manifest_path))?;
    let parse = |e: serde_json::Error| SiteError::Parse { path: manifest_path.clone(), message: e.to_string() };
    let mut document: Value = serde_json::from_str(&before).map_err(parse)?;
    point_at(&mut document, &prepared.target, &relative, prepared.report.height_property.as_deref(), prepared.terrain_crs.as_deref());
    write_atomically(&manifest_path, &(serde_json::to_string_pretty(&document).map_err(parse)? + "\n"))?;
    match Site::load(&site.dir) {
        Ok(updated) => {
            prepared.report.path = Some(relative);
            Ok((updated, prepared.report))
        }
        Err(e) => {
            write_atomically(&manifest_path, &before)?;
            Err(e)
        }
    }
}

pub(crate) fn write_atomically(path: &PathBuf, text: &str) -> Result<(), SiteError> {
    let temporary = path.with_extension("json.tmp");
    let io = |source| SiteError::Io { path: path.clone(), source };
    std::fs::write(&temporary, text).map_err(io)?;
    std::fs::rename(&temporary, path).map_err(io)
}

/// Points the manifest at the imported file, keeping any settings already there.
fn point_at(document: &mut Value, target: &Target, path: &str, height_property: Option<&str>, terrain_crs: Option<&str>) {
    let scene_entry = |document: &mut Value, key: &str| {
        let scene = &mut document["scene"];
        if !scene[key].is_object() {
            scene[key] = json!({});
        }
        let entry = scene[key].as_object_mut().expect("object");
        entry.insert("path".into(), json!(path));
        if let Some(property) = height_property {
            entry.insert("height_property".into(), json!(property));
        }
    };
    match target {
        Target::Buildings => scene_entry(document, "buildings"),
        Target::Trees => scene_entry(document, "trees"),
        Target::Terrain => {
            // A GeoTIFF carries its own size and place, so the raw format's keys and the old
            // file's `crs` go; `crs` is written only when the author had to name it.
            document["scene"]["terrain"] = json!({ "path": path });
            if let Some(code) = terrain_crs {
                document["scene"]["terrain"]["crs"] = json!(code);
            }
        }
        other => {
            if !document["data"].is_object() {
                document["data"] = json!({});
            }
            document["data"][other.name()] = json!(path);
        }
    }
}

// ---- Reading -----------------------------------------------------------------

/// The file as text. Not UTF-8 is read as Windows-1252, which Swedish exports often are.
/// Binary files are named, so the refusal can say what they look like.
fn decode(bytes: &[u8]) -> Result<(String, bool), &'static str> {
    let kind = match bytes {
        [0x50, 0x4b, 0x03, 0x04, ..] => Some("a zip archive (a shapefile or an Excel workbook?)"),
        [0x25, 0x50, 0x44, 0x46, ..] => Some("a PDF"),
        [0x49, 0x49, 0x2a, 0x00, ..] | [0x4d, 0x4d, 0x00, 0x2a, ..] => Some("a TIFF image"),
        [0x89, 0x50, 0x4e, 0x47, ..] => Some("a PNG image"),
        [0xff, 0xd8, 0xff, ..] => Some("a JPEG image"),
        [0xd0, 0xcf, 0x11, 0xe0, ..] => Some("an old Office document"),
        b"SQLite format 3\0" => Some("a GeoPackage or SQLite database"),
        _ if bytes.starts_with(b"SQLite format 3") => Some("a GeoPackage or SQLite database"),
        _ => None,
    };
    if let Some(kind) = kind {
        return Err(kind);
    }
    if bytes.iter().take(4096).filter(|&&b| b == 0).count() > 0 {
        return Err("a binary file");
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok((text.to_string(), false)),
        Err(_) => Ok((bytes.iter().map(|&b| windows_1252(b)).collect(), true)),
    }
}

fn windows_1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•',
        '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    match b {
        0x80..=0x9f => HIGH[(b - 0x80) as usize],
        _ => b as char,
    }
}

/// Features as GeoJSON objects in the file's own coordinates, and the system the file names.
fn read_features(text: &str, filename: &str, issues: &mut Vec<Issue>) -> Result<(Vec<Value>, Option<String>), Issue> {
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let value: Value = serde_json::from_str(text).map_err(|e| {
            Issue::new("read.json", Severity::Blocker, format!("The file starts like JSON but breaks off at line {}: {e}.", e.line()))
        })?;
        let declared = value["crs"]["properties"]["name"].as_str().map(String::from);
        let features = match value["type"].as_str() {
            Some("FeatureCollection") => value["features"].as_array().cloned().unwrap_or_default(),
            Some("Feature") => vec![value],
            Some(t) if Shape::of(t).is_some() || t == "GeometryCollection" => {
                vec![json!({ "type": "Feature", "properties": {}, "geometry": value })]
            }
            _ if value.is_array() => {
                return Err(Issue::new(
                    "read.records",
                    Severity::Blocker,
                    "This is a JSON list without map positions. Save it as CSV with latitude and longitude columns, or as GeoJSON.",
                ))
            }
            _ => {
                return Err(Issue::new(
                    "read.json_not_geojson",
                    Severity::Blocker,
                    "This JSON is not GeoJSON: it has no \"type\": \"FeatureCollection\".",
                ))
            }
        };
        let total = features.len();
        let features: Vec<Value> = features
            .into_iter()
            .filter(|f| f["geometry"]["type"].is_string() && f["geometry"]["coordinates"].is_array())
            .map(|mut f| {
                if !f["properties"].is_object() {
                    f["properties"] = json!({});
                }
                json!({ "type": "Feature", "properties": f["properties"].take(), "geometry": f["geometry"].take() })
            })
            .collect();
        if features.len() < total {
            let message = format!("{} entries had no geometry and were left out.", total - features.len());
            issues.push(Issue::new("geom.none", Severity::Warning, message));
        }
        return Ok((features, declared));
    }
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".kml") || lower.ends_with(".gpx") || trimmed.starts_with('<') {
        return Err(Issue::new("read.xml", Severity::Blocker, "KML, GPX and other XML files can't be read yet. Export GeoJSON instead."));
    }
    read_csv(text, issues).map(|f| (f, None))
}

/// A CSV with position columns, as point features.
fn read_csv(text: &str, issues: &mut Vec<Issue>) -> Result<Vec<Value>, Issue> {
    let first = text.lines().next().unwrap_or("");
    let separator = [',', ';', '\t', '|'].into_iter().max_by_key(|s| first.matches(*s).count()).unwrap_or(',');
    if first.matches(separator).count() == 0 {
        return Err(Issue::new(
            "read.unknown",
            Severity::Blocker,
            "This file is neither GeoJSON nor a table with columns. Use GeoJSON or CSV.",
        ));
    }
    let mut rows = parse_csv(text, separator).into_iter();
    let header: Vec<String> = rows.next().unwrap_or_default().into_iter().map(|h| h.trim().to_string()).collect();
    let find = |names: &[&str]| header.iter().position(|h| names.contains(&h.to_lowercase().as_str()));
    let lat = find(&["lat", "latitude", "latitud", "y", "northing", "n", "north", "y_coord", "ycoord"]);
    let lon = find(&["lon", "lng", "long", "longitude", "longitud", "x", "easting", "e", "east", "x_coord", "xcoord"]);
    let (Some(lat), Some(lon)) = (lat, lon) else {
        let columns = header.iter().take(8).map(|h| format!("'{h}'")).collect::<Vec<_>>().join(", ");
        return Err(Issue::new(
            "pos.none",
            Severity::Blocker,
            format!("No position columns were found among {columns}. Name them lat and lon (or x and y)."),
        ));
    };
    let decimal_comma = separator != ',';
    let mut comma_used = false;
    let mut skipped = 0;
    let mut features = Vec::new();
    for row in rows {
        let cell = |i: usize| row.get(i).map(|s| s.trim()).unwrap_or("");
        let parse = |s: &str, comma_used: &mut bool| -> Option<f64> {
            if decimal_comma && s.contains(',') && !s.contains('.') {
                *comma_used = true;
                s.replace(',', ".").parse().ok()
            } else {
                s.parse().ok()
            }
        };
        let (Some(y), Some(x)) = (parse(cell(lat), &mut comma_used), parse(cell(lon), &mut comma_used)) else {
            skipped += 1;
            continue;
        };
        let mut properties = Map::new();
        for (i, name) in header.iter().enumerate() {
            if i == lat || i == lon || name.is_empty() {
                continue;
            }
            let raw = cell(i);
            let value = match parse(raw, &mut comma_used) {
                Some(n) if n.is_finite() => json!(n),
                _ if raw.is_empty() => continue,
                _ => json!(raw),
            };
            properties.insert(name.clone(), value);
        }
        features.push(json!({ "type": "Feature", "properties": properties, "geometry": { "type": "Point", "coordinates": [x, y] } }));
    }
    if comma_used {
        issues.push(Issue::new("read.decimal_comma", Severity::Note, "Numbers use a comma for decimals (12,5), and were read that way."));
    }
    if skipped > 0 {
        issues.push(Issue::new("pos.missing", Severity::Warning, format!("{skipped} rows had no usable position and were left out.")));
    }
    Ok(features)
}

/// Rows of fields. Handles quotes, doubled quotes and both line endings.
fn parse_csv(text: &str, separator: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let (mut row, mut cell, mut quoted) = (Vec::new(), String::new(), false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    cell.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => cell.push(c),
            }
        } else if c == '"' {
            quoted = true;
        } else if c == separator {
            row.push(std::mem::take(&mut cell));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut cell));
            if row.iter().any(|v| !v.is_empty()) {
                rows.push(std::mem::take(&mut row));
            }
            row.clear();
        } else {
            cell.push(c);
        }
    }
    row.push(cell);
    if row.iter().any(|v| !v.is_empty()) {
        rows.push(row);
    }
    rows
}

// ---- Trips -------------------------------------------------------------------

fn trips(site: &Site, target: &Target, text: &str, mut issues: Vec<Issue>) -> Prepared {
    let mut report = Report {
        ok: false,
        target: target.name().to_string(),
        summary: String::new(),
        count: 0,
        inside: 0,
        outside: 0,
        crs: None,
        height_property: None,
        issues: Vec::new(),
        preview: None,
        path: None,
    };
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(e) => {
            issues.push(Issue::new(
                "read.json",
                Severity::Blocker,
                format!("Trips are a JSON file, and this one breaks off at line {}.", e.line()),
            ));
            report.summary = "Not a trips file.".into();
            report.issues = issues;
            return Prepared { target: target.clone(), report, content: None, terrain_crs: None, file: None };
        }
    };
    let Some(list) = value["trips"].as_array() else {
        issues.push(Issue::new(
            "trips.format",
            Severity::Blocker,
            "A trips file has a \"trips\" list; see the mobility layer's README for the format.",
        ));
        report.summary = "Not a trips file.".into();
        report.issues = issues;
        return Prepared { target: target.clone(), report, content: None, terrain_crs: None, file: None };
    };
    let frame = Frame::new(site);
    let mut broken = 0;
    for trip in list {
        let legs = trip["legs"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let good = !legs.is_empty()
            && legs.iter().all(|leg| {
                number(&leg["start"]).is_some()
                    && number(&leg["duration"]).is_some_and(|d| d >= 0.0)
                    && leg["coordinates"].as_array().is_some_and(|c| c.len() >= 2)
            });
        if !good {
            broken += 1;
            continue;
        }
        let on_table = legs.iter().any(|leg| frame.touches(&json!({ "type": "LineString", "coordinates": leg["coordinates"] }), 0.0));
        if on_table {
            report.inside += 1;
        } else {
            report.outside += 1;
        }
    }
    report.count = list.len();
    if broken > 0 {
        let message = format!("{broken} trips have no legs, or legs without a start, a duration and two positions.");
        issues.push(Issue::new("trips.legs", if broken == list.len() { Severity::Blocker } else { Severity::Warning }, message));
    }
    if list.len() > broken && report.inside == 0 {
        issues.push(Issue::new(
            "extent.outside_all",
            Severity::Blocker,
            "None of the trips cross your table. Positions are [longitude, latitude].",
        ));
    } else if report.outside > 0 {
        issues.push(Issue::new("extent.outside_some", Severity::Warning, format!("{} trips never cross the table.", report.outside)));
    }
    if list.is_empty() {
        issues.push(Issue::new("read.empty", Severity::Blocker, "The trips list is empty."));
    }
    if let Some(existing) = site.data().get("trips") {
        issues.push(Issue::new("data.replaces", Severity::Note, format!("This replaces the table's trips ({existing}).")));
    }
    let groups: std::collections::BTreeSet<&str> = list.iter().filter_map(|t| t["group"].as_str()).collect();
    report.summary = format!("{} trips in {} groups", list.len(), groups.len().max(1));
    report.crs = Some(CrsReport { code: "EPSG:4326".into(), guessed: false });
    report.ok = !issues.iter().any(|i| i.severity == Severity::Blocker);
    report.issues = issues;
    let content = report.ok.then(|| json_file(&value));
    Prepared { target: target.clone(), report, content, terrain_crs: None, file: None }
}

// ---- Tables -------------------------------------------------------------------

/// A CSV without map positions, kept as a table: place motions join it to places by name
/// or id (activity through the day, flows and links between places). Saved as a comma CSV in
/// UTF-8, with decimal commas read as points, so every reader sees the same numbers.
fn table(site: &Site, target: &Target, text: &str, mut issues: Vec<Issue>) -> Prepared {
    let text = text.trim_start_matches('\u{feff}');
    let first = text.lines().next().unwrap_or("");
    let separator = [',', ';', '\t', '|'].into_iter().max_by_key(|s| first.matches(*s).count()).unwrap_or(',');
    let mut rows = parse_csv(text, separator);
    rows.retain(|row| row.iter().any(|cell| !cell.trim().is_empty()));
    let header: Vec<String> = if rows.is_empty() { Vec::new() } else { rows.remove(0).into_iter().map(|h| h.trim().to_string()).collect() };
    let decimal_comma = separator != ',';
    let mut comma_used = false;
    let cell = |raw: &str, comma_used: &mut bool| -> String {
        let raw = raw.trim();
        if decimal_comma && raw.contains(',') && !raw.contains('.') {
            let swapped = raw.replace(',', ".");
            if swapped.parse::<f64>().is_ok() {
                *comma_used = true;
                return swapped;
            }
        }
        raw.to_string()
    };
    let quote = |value: &str| {
        if value.contains([',', '"', '\n', '\r']) {
            format!("\"{}\"", value.replace('"', "\"\""))
        } else {
            value.to_string()
        }
    };
    let mut out = header.iter().map(|h| quote(h)).collect::<Vec<_>>().join(",");
    out.push('\n');
    for row in &rows {
        let line = (0..header.len()).map(|i| quote(&cell(row.get(i).map(String::as_str).unwrap_or(""), &mut comma_used))).collect::<Vec<_>>().join(",");
        out.push_str(&line);
        out.push('\n');
    }
    let shown = header.iter().take(6).map(|h| h.as_str()).collect::<Vec<_>>().join(", ");
    let more = if header.len() > 6 { format!(" and {} more", header.len() - 6) } else { String::new() };
    issues.push(Issue::new(
        "table.no_positions",
        Severity::Note,
        "It has no map positions, so it is kept as a table. Place motions use tables like this for activity through the day, and for flows and links between places, by place name or id.",
    ));
    if comma_used {
        issues.push(Issue::new("read.decimal_comma", Severity::Note, "Numbers use a comma for decimals (12,5), and were read that way."));
    }
    if rows.is_empty() {
        issues.push(Issue::new("read.empty", Severity::Blocker, "The table has column names but no rows."));
    }
    if let Some(existing) = site.data().get(target.name()) {
        issues.push(Issue::new("data.replaces", Severity::Note, format!("This replaces the table's {} ({existing}).", target.name())));
    }
    let ok = !issues.iter().any(|i| i.severity == Severity::Blocker);
    let report = Report {
        ok,
        target: target.name().to_string(),
        summary: format!("A table of {} rows: {shown}{more}", rows.len()),
        count: rows.len(),
        inside: 0,
        outside: 0,
        crs: None,
        height_property: None,
        issues,
        preview: None,
        path: None,
    };
    let content = ok.then(|| out.into_bytes());
    Prepared { target: target.clone(), report, content, terrain_crs: None, file: Some(format!("data/{}.csv", target.name())) }
}

// ---- Terrain -----------------------------------------------------------------

/// A GeoTIFF of ground heights: read it as the bake would, and say how much of the table it covers.
fn terrain(site: &Site, bytes: &[u8], crs: Option<u32>) -> Prepared {
    let mut issues = Vec::new();
    let mut report = Report {
        ok: false,
        target: "terrain".into(),
        summary: String::new(),
        count: 0,
        inside: 0,
        outside: 0,
        crs: None,
        height_property: None,
        issues: Vec::new(),
        preview: None,
        path: None,
    };
    let done = |mut report: Report, issues: Vec<Issue>, content: Option<Vec<u8>>, terrain_crs: Option<String>| {
        report.ok = content.is_some() && !issues.iter().any(|i| i.severity == Severity::Blocker);
        report.issues = issues;
        Prepared { target: Target::Terrain, report, content, terrain_crs, file: None }
    };
    if !matches!(bytes, [0x49, 0x49, 0x2a, 0x00, ..] | [0x4d, 0x4d, 0x00, 0x2a, ..]) {
        issues.push(Issue::new("read.unknown", Severity::Blocker, "Terrain is a GeoTIFF of ground heights, and this file is not a TIFF."));
        report.summary = "Not a GeoTIFF.".into();
        return done(report, issues, None, None);
    }
    let named = match crs.map(|code| (code, Crs::from_epsg(code))) {
        Some((code, None)) => {
            let message = format!("EPSG:{code} can't be converted yet; use one of {}.", Crs::SUPPORTED);
            issues.push(Issue::new("coords.unsupported", Severity::Blocker, message));
            report.summary = "Unsupported coordinate system.".into();
            return done(report, issues, None, None);
        }
        Some((_, crs)) => crs,
        None => None,
    };
    // The reader works on a file; a scratch copy in the system's temporary folder.
    let scratch = std::env::temp_dir().join(format!("mrs-terrain-{}-{:p}.tif", std::process::id(), bytes.as_ptr()));
    if let Err(e) = std::fs::write(&scratch, bytes) {
        issues.push(Issue::new("read.io", Severity::Blocker, format!("The file could not be read: {e}.")));
        return done(report, issues, None, None);
    }
    let mut read = GeoRaster::read(&scratch, named).map(|raster| (raster, crs, false));
    // A file that only cites its system: try the ones a site's terrain comes in, and keep
    // the first that lands on the table.
    if matches!(&read, Err(e) if e.contains("coordinate system")) && named.is_none() {
        let utm_zone = ((site.manifest.origin.lon + 180.0) / 6.0).floor() as u32 + 1;
        let candidates = [3006].into_iter().chain(3007..=3018).chain([32600 + utm_zone, 25800 + utm_zone, 4326]);
        for code in candidates {
            if let Ok(raster) = GeoRaster::read(&scratch, Crs::from_epsg(code)) {
                if coverage(site, &raster).0 > 0 {
                    read = Ok((raster, Some(code), true));
                    break;
                }
            }
        }
    }
    let _ = std::fs::remove_file(&scratch);
    let (raster, crs, guessed) = match read {
        Ok(read) => read,
        Err(e) => {
            let (code, message) = if e.contains("coordinate system") {
                ("coords.unknown", "The GeoTIFF does not say which coordinate system it is in, and none that MR Studio knows puts it on your table. Choose its coordinate system.".to_string())
            } else {
                ("read.geotiff", format!("The GeoTIFF can't be read as ground heights: {e}."))
            };
            issues.push(Issue::new(code, Severity::Blocker, message));
            report.summary = "A GeoTIFF that can't be placed.".into();
            return done(report, issues, None, None);
        }
    };
    if guessed {
        let code = crs.expect("guessed");
        issues.push(Issue::new(
            "coords.projected",
            Severity::Note,
            format!("The file does not name its coordinate system. Read as EPSG:{code}, it lands on your table."),
        ));
    }
    let (covered, total, low, high) = coverage(site, &raster);
    report.count = 1;
    report.crs = Some(CrsReport { code: crs.map_or_else(|| "from the file".into(), |c| format!("EPSG:{c}")), guessed });
    if covered == 0 {
        issues.push(Issue::new(
            "extent.outside_all",
            Severity::Blocker,
            "The GeoTIFF does not cover any of your table. Check that it is the right area and coordinate system.",
        ));
        report.outside = 1;
        report.summary = format!("A {} x {} raster that misses the table.", raster.width, raster.height);
        return done(report, issues, None, None);
    }
    report.inside = 1;
    let share = covered as f64 / total as f64;
    if share < 0.99 {
        let message = format!("It covers about {:.0}% of the table; the rest is set to its lowest ground, {low:.0} m.", share * 100.0);
        issues.push(Issue::new("extent.partial", Severity::Warning, message));
    }
    if let Some(existing) = site.manifest.scene.terrain.as_ref() {
        issues.push(Issue::new("data.replaces", Severity::Note, format!("This replaces the table's terrain ({}).", existing.path)));
    }
    report.summary = format!("Ground from {low:.0} to {high:.0} m, covering {:.0}% of the table", (share * 100.0).min(100.0));
    let terrain_crs = crs.map(|c| format!("EPSG:{c}"));
    done(report, issues, Some(bytes.to_vec()), terrain_crs)
}

/// Samples the table on a coarse grid, as the bake will at full resolution: how many
/// samples the raster covers, of how many, and the lowest and highest ground among them.
fn coverage(site: &Site, raster: &GeoRaster) -> (usize, usize, f32, f32) {
    let (projection, grid) = (site.projection(), site.grid());
    let (columns, rows) = (48, 30);
    let (mut low, mut high, mut covered) = (f32::INFINITY, f32::NEG_INFINITY, 0);
    for r in 0..rows {
        for c in 0..columns {
            let col = (c as f64 + 0.5) / columns as f64 * grid.width as f64;
            let row = (r as f64 + 0.5) / rows as f64 * grid.height as f64;
            let (east, north) = grid.cell_to_local(col, row);
            let p = projection.to_lonlat(east, north);
            if let Some(z) = raster.sample(p.lon, p.lat) {
                covered += 1;
                low = low.min(z);
                high = high.max(z);
            }
        }
    }
    (covered, columns * rows, low, high)
}

// ---- Coordinates -------------------------------------------------------------

struct Choice {
    crs: Crs,
    code: String,
    guessed: bool,
}

/// The file's own coordinate system when it names one we know, else the first of WGS84,
/// SWEREF99 TM, the SWEREF99 local zones and the site's UTM zone that puts most of the
/// data on or near the table.
fn choose_crs(site: &Site, features: &[Value], declared: Option<&str>, swap: bool) -> Result<Choice, Issue> {
    let mut sample = Vec::new();
    for feature in features {
        collect_positions(&feature["geometry"]["coordinates"], &mut sample, 400);
        if sample.len() >= 400 {
            break;
        }
    }
    let sample: Vec<(f64, f64)> = sample.into_iter().map(|(x, y)| if swap { (y, x) } else { (x, y) }).collect();
    if let Some(name) = declared {
        let code = name.rsplit(['/', ':']).next().unwrap_or("");
        let code = if name.contains("CRS84") { "4326" } else { code };
        match code.parse::<u32>().ok().and_then(Crs::from_epsg) {
            Some(crs) => return Ok(Choice { crs, code: format!("EPSG:{code}"), guessed: false }),
            None => {
                return Err(Issue::new(
                    "coords.unsupported",
                    Severity::Blocker,
                    format!("The file is in {name}, which MR Studio can't convert yet. Export it as WGS84 (EPSG:4326) or SWEREF99 TM."),
                ))
            }
        }
    }
    let frame = Frame::new(site);
    let near = |crs: &Crs| -> f64 {
        let close = sample.iter().filter(|&&(x, y)| {
            let (lon, lat) = crs.inverse(x, y);
            lon.is_finite() && lat.is_finite() && frame.within(lon, lat, 20.0)
        });
        close.count() as f64 / sample.len().max(1) as f64
    };
    let geographic = sample.iter().all(|&(x, y)| x.abs() <= 180.0 && y.abs() <= 90.0);
    let utm_zone = ((site.manifest.origin.lon + 180.0) / 6.0).floor() as u32 + 1;
    let mut candidates = vec![4326, 3006];
    candidates.extend(3007..=3018);
    candidates.extend([32600 + utm_zone, 25800 + utm_zone]);
    for code in candidates {
        let crs = Crs::from_epsg(code).expect("known");
        if (crs == Crs::Geographic) != geographic {
            continue;
        }
        if near(&crs) >= 0.5 {
            return Ok(Choice { crs, code: format!("EPSG:{code}"), guessed: code != 4326 });
        }
    }
    if geographic {
        let swapped = sample.iter().filter(|&&(x, y)| frame.within(y, x, 20.0)).count();
        if !swap && swapped * 2 >= sample.len() {
            return Err(Issue::new(
                "coords.swapped",
                Severity::Blocker,
                "These positions land far from your table, but they would land on it with latitude and longitude swapped.",
            )
            .fix("swap"));
        }
        // On the map, but not near the table: say where, from the features themselves.
        return Ok(Choice { crs: Crs::Geographic, code: "EPSG:4326".into(), guessed: false });
    }
    Err(Issue::new(
        "coords.unknown",
        Severity::Blocker,
        "The coordinates are metres on a grid MR Studio could not place near your table. Export the file as WGS84 (EPSG:4326).",
    ))
}

fn collect_positions(value: &Value, out: &mut Vec<(f64, f64)>, limit: usize) {
    let Some(list) = value.as_array() else { return };
    if let (Some(x), Some(y)) = (list.first().and_then(Value::as_f64), list.get(1).and_then(Value::as_f64)) {
        if out.len() < limit {
            out.push((x, y));
        }
        return;
    }
    for item in list {
        if out.len() >= limit {
            return;
        }
        collect_positions(item, out, limit);
    }
}

/// Rewrites every position in a GeoJSON coordinates array.
fn map_positions(value: &mut Value, f: &dyn Fn(f64, f64) -> (f64, f64)) {
    let Some(list) = value.as_array_mut() else { return };
    if let (Some(x), Some(y)) = (list.first().and_then(Value::as_f64), list.get(1).and_then(Value::as_f64)) {
        let (x, y) = f(x, y);
        list.truncate(2);
        list[0] = json!(x);
        list[1] = json!(y);
        return;
    }
    for item in list {
        map_positions(item, f);
    }
}

/// The table's rectangle, for asking whether WGS84 positions land on it.
struct Frame {
    projection: Projection,
    grid: mrs_engine::Grid,
    origin: (f64, f64),
}

impl Frame {
    fn new(site: &Site) -> Self {
        Self { projection: site.projection(), grid: site.grid(), origin: (site.manifest.origin.lon, site.manifest.origin.lat) }
    }

    /// Within `margin` extents of the table: 0 is on it, 1 is up to one table size around it.
    fn within(&self, lon: f64, lat: f64, margin: f64) -> bool {
        let (east, north) = self.projection.to_local(lon, lat);
        let (col, row) = self.grid.local_to_cell(east, north);
        let (w, h) = (self.grid.width as f64, self.grid.height as f64);
        col >= -margin * w && col <= w * (1.0 + margin) && row >= -margin * h && row <= h * (1.0 + margin)
    }

    /// Whether any position of a geometry is within `margin` of the table, or, for an area
    /// that covers the whole table, whether the table's centre is inside it.
    fn touches(&self, geometry: &Value, margin: f64) -> bool {
        let mut positions = Vec::new();
        collect_positions(&geometry["coordinates"], &mut positions, usize::MAX);
        positions.iter().any(|&(lon, lat)| self.within(lon, lat, margin))
            || (Shape::of(geometry["type"].as_str().unwrap_or("")) == Some(Shape::Area) && self.covers_centre(&positions))
    }

    fn covers_centre(&self, ring: &[(f64, f64)]) -> bool {
        let (x, y) = self.origin;
        let mut inside = false;
        for (i, &(x1, y1)) in ring.iter().enumerate() {
            let (x2, y2) = ring[(i + 1) % ring.len()];
            if (y1 > y) != (y2 > y) && x < x1 + (y - y1) / (y2 - y1) * (x2 - x1) {
                inside = !inside;
            }
        }
        inside
    }

    /// "about 12 km north-east": how far the data's middle is from the table.
    fn distance_words(&self, features: &[Value]) -> String {
        let mut positions = Vec::new();
        for f in features {
            collect_positions(&f["geometry"]["coordinates"], &mut positions, 2000);
        }
        let n = positions.len().max(1) as f64;
        let (lon, lat) = positions.iter().fold((0.0, 0.0), |(a, b), &(x, y)| (a + x / n, b + y / n));
        let (east, north) = self.projection.to_local(lon, lat);
        let km = (east * east + north * north).sqrt() / 1000.0;
        let bearing = east.atan2(north).to_degrees().rem_euclid(360.0);
        let direction = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
            [((bearing + 22.5) / 45.0) as usize % 8];
        if km >= 1000.0 {
            format!("about {:.0} km {direction}, so the file may be in another coordinate system", km)
        } else if km >= 10.0 {
            format!("about {km:.0} km {direction}")
        } else {
            format!("about {km:.1} km {direction}")
        }
    }
}

// ---- Heights -----------------------------------------------------------------

/// The properties of `features` that go by one of `names`, whatever their case
/// ("Höjd" for "höjd"), as they are spelled in the file and in the order of `names`.
fn property_names(features: &[Value], names: &[&str]) -> Vec<String> {
    let mut keys = std::collections::BTreeSet::new();
    for feature in features {
        if let Some(properties) = feature["properties"].as_object() {
            keys.extend(properties.keys().cloned());
        }
    }
    names.iter().flat_map(|name| keys.iter().filter(|k| k.to_lowercase() == *name).cloned().collect::<Vec<_>>()).collect()
}

/// Finds the property that holds building heights; fills in `height` from storeys where
/// only those are known. Returns the property, how many had a height and how many were estimated.
fn building_heights(features: &mut [Value]) -> (String, usize, usize) {
    let has = |f: &Value, p: &str| number(&f["properties"][p]).is_some_and(|h| h > 0.0);
    let heights = property_names(features, &["height", "height_m", "building:height", "höjd", "hojd", "höjd_m", "hojd_m"]);
    let property =
        heights.iter().max_by_key(|p| features.iter().filter(|f| has(f, p)).count()).filter(|p| features.iter().any(|f| has(f, p)));
    let property = property.cloned().unwrap_or_else(|| "height".to_string());
    let storeys = property_names(
        features,
        &["building:levels", "levels", "floors", "storeys", "vaningar", "våningar", "antal_vaningar", "antal_våningar"],
    );
    let known = features.iter().filter(|f| has(f, &property)).count();
    let mut estimated = 0;
    for feature in features.iter_mut() {
        if has(feature, &property) {
            continue;
        }
        if let Some(levels) = storeys.iter().find_map(|p| number(&feature["properties"][p.as_str()]).filter(|l| *l > 0.0)) {
            feature["properties"][&property] = json!(levels * METRES_PER_STOREY);
            estimated += 1;
        }
    }
    (property, known, estimated)
}

/// A number, or a string that holds one (OSM keeps heights as text: "12 m", "12,5").
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('m').trim().replace(',', ".").parse().ok(),
        _ => None,
    }
    .filter(|n: &f64| n.is_finite())
}

fn round7(v: f64) -> f64 {
    (v * 1e7).round() / 1e7
}

fn capital(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A copy of the sample site in a fresh temporary folder.
    fn scratch(name: &str) -> Site {
        scratch_of("sample", name)
    }

    /// A copy of one of the repository's sites in a fresh temporary folder.
    fn scratch_of(site: &str, name: &str) -> Site {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sites").join(site);
        let dir = std::env::temp_dir().join(format!("mrs-import-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        copy(&source, &dir);
        Site::load(&dir).unwrap()
    }

    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    fn codes(report: &Report) -> Vec<&'static str> {
        report.issues.iter().map(|i| i.code).collect()
    }

    /// A small square footprint at a WGS84 position.
    fn footprint(lon: f64, lat: f64, properties: Value) -> Value {
        let d = 0.0001;
        json!({ "type": "Feature", "properties": properties, "geometry": { "type": "Polygon",
            "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] } })
    }

    fn collection(features: Vec<Value>) -> Vec<u8> {
        serde_json::to_vec(&json!({ "type": "FeatureCollection", "features": features })).unwrap()
    }

    #[test]
    fn targets_parse() {
        assert_eq!(Target::parse("buildings").unwrap(), Target::Buildings);
        assert_eq!(Target::parse("data:trees").unwrap(), Target::Trees);
        assert_eq!(Target::parse("data:bike_counts").unwrap(), Target::Data("bike_counts".into()));
        assert!(Target::parse("data:Bike Counts").is_err());
        assert!(Target::parse("slideshow").is_err());
        assert_eq!(Target::Trips.path(), "data/trips.json");
    }

    #[test]
    fn buildings_are_written_and_heights_found_or_estimated() {
        let site = scratch("buildings");
        let file = collection(vec![
            footprint(11.970, 57.700, json!({ "height": "15 m" })),
            footprint(11.971, 57.700, json!({ "building:levels": "4" })),
            footprint(11.972, 57.700, json!({ "name": "Kiosk" })),
            json!({ "type": "Feature", "properties": {}, "geometry": { "type": "Point", "coordinates": [11.97, 57.70] } }),
        ]);
        let prepared = inspect(&site, &Target::Buildings, "b.geojson", &file, Options::default());
        let r = &prepared.report;
        assert!(r.ok, "{:?}", r.issues);
        assert_eq!((r.count, r.inside, r.outside), (3, 3, 0));
        assert_eq!(r.summary, "3 buildings, 2 with a height");
        assert_eq!(r.height_property.as_deref(), Some("height"));
        assert!(codes(r).contains(&"geom.mixed") && codes(r).contains(&"height.estimated") && codes(r).contains(&"height.missing"));
        assert!(codes(r).contains(&"data.replaces"));

        let (updated, report) = apply(&site, prepared).unwrap();
        assert_eq!(report.path.as_deref(), Some("data/buildings.geojson"));
        let b = updated.manifest.scene.buildings.as_ref().unwrap();
        assert_eq!((b.path.as_str(), b.height_property.as_str(), b.default_height_m), ("data/buildings.geojson", "height", 12.0));
        let (_, stats) = updated.bake().unwrap();
        assert_eq!(stats.buildings, 3);
        let written: Value = serde_json::from_slice(&std::fs::read(updated.dir.join("data/buildings.geojson")).unwrap()).unwrap();
        assert_eq!(written["features"][1]["properties"]["height"], json!(12.0));
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn national_grid_coordinates_are_recognised_and_converted() {
        let site = scratch("sweref");
        let crs = Crs::from_epsg(3006).unwrap();
        let (x, y) = crs.forward(11.970, 57.700);
        let ring = json!([[x, y], [x + 10.0, y], [x + 10.0, y + 10.0], [x, y + 10.0], [x, y]]);
        let file =
            collection(vec![json!({ "type": "Feature", "properties": {}, "geometry": { "type": "Polygon", "coordinates": [ring] } })]);
        let r = inspect(&site, &Target::Buildings, "b.geojson", &file, Options::default()).report;
        assert!(r.ok, "{:?}", r.issues);
        assert_eq!(r.crs.as_ref().map(|c| (c.code.as_str(), c.guessed)), Some(("EPSG:3006", true)));
        assert!(codes(&r).contains(&"coords.projected"));
        let first = &r.preview.as_ref().unwrap()["features"][0]["geometry"]["coordinates"][0][0];
        assert!((first[0].as_f64().unwrap() - 11.970).abs() < 1e-6 && (first[1].as_f64().unwrap() - 57.700).abs() < 1e-6, "{first}");
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn swapped_and_distant_data_is_refused_with_the_reason() {
        let site = scratch("refused");
        let swapped = collection(vec![
            json!({ "type": "Feature", "properties": {}, "geometry": { "type": "Point", "coordinates": [57.70, 11.97] } }),
        ]);
        let r = inspect(&site, &Target::Trees, "t.geojson", &swapped, Options::default()).report;
        assert!(!r.ok);
        assert_eq!(r.issues.last().map(|i| (i.code, i.fix)), Some(("coords.swapped", Some("swap"))));
        let fixed = inspect(&site, &Target::Trees, "t.geojson", &swapped, Options { swap: true, ..Default::default() }).report;
        assert!(fixed.ok, "{:?}", fixed.issues);

        let stockholm = collection(vec![
            json!({ "type": "Feature", "properties": {}, "geometry": { "type": "Point", "coordinates": [18.07, 59.33] } }),
        ]);
        let r = inspect(&site, &Target::Trees, "t.geojson", &stockholm, Options::default()).report;
        let issue = r.issues.iter().find(|i| i.code == "extent.outside_all").unwrap();
        assert!(issue.message.contains("km north-east"), "{}", issue.message);

        let lines = collection(vec![
            json!({ "type": "Feature", "properties": {}, "geometry": { "type": "LineString", "coordinates": [[11.97, 57.70], [11.971, 57.70]] } }),
        ]);
        let r = inspect(&site, &Target::Buildings, "b.geojson", &lines, Options::default()).report;
        assert_eq!(r.issues[0].message, "Buildings need areas, and this file has 1 lines.");

        let r = inspect(&site, &Target::Buildings, "b.zip", b"PK\x03\x04rest", Options::default()).report;
        assert!(r.issues[0].message.contains("zip archive"));
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn trees_from_a_swedish_csv() {
        let site = scratch("csv");
        let csv = "id;latitud;longitud;höjd;art\n1;57,7001;11,9701;9,5;Lind\n2;57,7002;11,9702;;Ek\n3;;;4;Björk\n".as_bytes();
        let latin1: Vec<u8> = String::from_utf8(csv.to_vec()).unwrap().chars().map(|c| c as u32 as u8).collect();
        let prepared = inspect(&site, &Target::Trees, "trees.csv", &latin1, Options::default());
        let r = &prepared.report;
        assert!(r.ok, "{:?}", r.issues);
        assert_eq!(r.count, 2);
        assert_eq!(r.height_property.as_deref(), Some("höjd"));
        assert!(
            ["read.encoding", "read.decimal_comma", "pos.missing", "height.missing"].iter().all(|c| codes(r).contains(c)),
            "{:?}",
            codes(r)
        );
        let tree = &r.preview.as_ref().unwrap()["features"][0];
        assert_eq!(tree["properties"]["art"], "Lind");
        assert_eq!(tree["properties"]["höjd"], json!(9.5));
        let (updated, _) = apply(&site, prepared).unwrap();
        assert_eq!(updated.manifest.scene.trees.as_ref().unwrap().height_property, "höjd");
        assert_eq!(updated.manifest.scene.trees.as_ref().unwrap().crown_radius_m, 3.5, "settings already there are kept");
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn swedish_column_names_in_any_case() {
        let site = scratch("case");
        let csv = "Latitud,Longitud,Höjd\n57.7001,11.9701,9.5\n57.7002,11.9702,6\n".as_bytes();
        let r = inspect(&site, &Target::Trees, "trees.csv", csv, Options::default()).report;
        assert!(r.ok, "{:?}", r.issues);
        assert_eq!(r.height_property.as_deref(), Some("Höjd"));
        assert!(r.summary.contains("2 with a height"), "{}", r.summary);
        assert!(!codes(&r).contains(&"height.missing"));

        let mut features = vec![json!({ "properties": { "Antal_Våningar": "4" } }), json!({ "properties": { "HÖJD": 12 } })];
        let (property, known, estimated) = building_heights(&mut features);
        assert_eq!((property.as_str(), known, estimated), ("HÖJD", 1, 1));
        assert_eq!(features[0]["properties"]["HÖJD"], json!(4.0 * METRES_PER_STOREY));
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn tables_without_positions_are_kept_as_csv_for_named_datasets() {
        let site = scratch("table");
        let csv = "place;hour;visitors;note\nLibrary;9;12,5;\"quiet, mostly\"\nCafé;12;40;\n".as_bytes();
        let prepared = inspect(&site, &Target::Data("activity".into()), "activity.csv", csv, Options::default());
        let r = &prepared.report;
        assert!(r.ok, "{:?}", r.issues);
        assert_eq!(r.count, 2);
        assert!(r.summary.starts_with("A table of 2 rows: place, hour, visitors, note"), "{}", r.summary);
        assert!(codes(r).contains(&"table.no_positions") && codes(r).contains(&"read.decimal_comma"));
        assert!(r.preview.is_none());
        let (site2, report) = apply(&site, prepared).unwrap();
        assert_eq!(report.path.as_deref(), Some("data/activity.csv"));
        assert_eq!(site2.data()["activity"], "data/activity.csv");
        let written = std::fs::read_to_string(site2.dir.join("data/activity.csv")).unwrap();
        assert_eq!(written, "place,hour,visitors,note\nLibrary,9,12.5,\"quiet, mostly\"\nCafé,12,40,\n");

        // Trees need positions: the same file is refused for them.
        let trees = inspect(&site2, &Target::Trees, "activity.csv", csv, Options::default()).report;
        assert!(!trees.ok);
        assert_eq!(trees.issues[0].code, "pos.none");
        // Column names alone are not a table.
        let empty = inspect(&site2, &Target::Data("flows".into()), "flows.csv", b"from,to,weight\n", Options::default()).report;
        assert!(!empty.ok);
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn walkways_trips_and_named_datasets_land_under_data() {
        let site = scratch("data");
        let walk = collection(vec![
            json!({ "type": "Feature", "properties": {}, "geometry": { "type": "LineString", "coordinates": [[11.969, 57.70], [11.971, 57.70]] } }),
        ]);
        let (site2, _) = apply(&site, inspect(&site, &Target::Walkways, "w.geojson", &walk, Options::default())).unwrap();
        assert_eq!(site2.data()["walkways"], "data/walkways.geojson");

        let trips = json!({ "trips": [{ "group": "walk", "legs": [{ "start": 0, "duration": 60, "coordinates": [[11.969, 57.70], [11.971, 57.70]] }] }] });
        let prepared = inspect(&site2, &Target::Trips, "trips.json", &serde_json::to_vec(&trips).unwrap(), Options::default());
        assert!(prepared.report.ok, "{:?}", prepared.report.issues);
        assert_eq!(prepared.report.summary, "1 trips in 1 groups");
        let (site3, _) = apply(&site2, prepared).unwrap();
        assert_eq!(site3.data()["trips"], "data/trips.json");

        let bad = inspect(&site3, &Target::Trips, "trips.json", br#"{ "nope": [] }"#, Options::default());
        assert_eq!(bad.report.issues[0].code, "trips.format");
        assert!(apply(&site3, bad).is_err());

        let far_and_near = collection(vec![
            json!({ "type": "Feature", "properties": { "n": 1 }, "geometry": { "type": "Point", "coordinates": [11.97, 57.70] } }),
            json!({ "type": "Feature", "properties": { "n": 2 }, "geometry": { "type": "Point", "coordinates": [12.5, 57.70] } }),
        ]);
        let r = inspect(&site3, &Target::Data("counters".into()), "c.geojson", &far_and_near, Options::default()).report;
        assert_eq!(r.issues[0].fix, Some("crop"));
        let cropped =
            inspect(&site3, &Target::Data("counters".into()), "c.geojson", &far_and_near, Options { crop: true, ..Default::default() });
        let (site4, _) = apply(&site3, cropped).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(site4.dir.join("data/counters.geojson")).unwrap()).unwrap();
        assert_eq!(written["features"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn terrain_from_a_national_grid_geotiff() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sites/chalmers/data");
        let tif = std::fs::read(repo.join("terrain.tif")).unwrap();

        // The sample district lies a few hundred metres north of the campus raster.
        let sample = scratch("terrain-miss");
        let r = inspect(&sample, &Target::Terrain, "terrain.tif", &tif, Options::default()).report;
        // The file only cites its grid, and no grid puts it on this table.
        assert_eq!(codes(&r), ["coords.unknown"]);
        let named = inspect(&sample, &Target::Terrain, "terrain.tif", &tif, Options { crs: Some(3006), ..Default::default() }).report;
        assert_eq!(codes(&named), ["extent.outside_all"]);
        assert!(inspect(&sample, &Target::Terrain, "t.geojson", b"{}", Options::default()).report.issues[0].message.contains("not a TIFF"));
        assert_eq!(
            inspect(&sample, &Target::Terrain, "t.tif", &tif, Options { crs: Some(2154), ..Default::default() }).report.issues[0].code,
            "coords.unsupported"
        );
        std::fs::remove_dir_all(&sample.dir).unwrap();

        // A new table on the campus takes it, and the bake raises the ground.
        let base = std::env::temp_dir().join(format!("mrs-import-campus-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let campus = Site::load(&{
            let dir = base.join("campus");
            crate::create::create(&dir, "Campus", 11.977769, 57.688384, 1250.0, 750.0, -92.555).unwrap();
            dir
        })
        .unwrap();
        let prepared = inspect(&campus, &Target::Terrain, "terrain.tif", &tif, Options::default());
        assert!(prepared.report.ok, "{:?}", prepared.report.issues);
        assert_eq!(codes(&prepared.report), ["coords.projected"]);
        assert!(
            prepared.report.summary.starts_with("Ground from") && prepared.report.summary.ends_with("100% of the table"),
            "{}",
            prepared.report.summary
        );
        let (campus, _) = apply(&campus, prepared).unwrap();
        let terrain = campus.manifest.scene.terrain.as_ref().unwrap();
        // The grid was found by trying, so it is written down for the bake.
        assert_eq!((terrain.path.as_str(), terrain.width, terrain.crs.as_deref()), ("data/terrain.tif", None, Some("EPSG:3006")));
        let (scene, stats) = campus.bake().unwrap();
        assert_eq!(stats.terrain_missing_cells, 0);
        let (low, high) = scene.dtm.iter().fold((f32::MAX, f32::MIN), |(a, b), &z| (a.min(z), b.max(z)));
        assert!(high - low > 10.0, "{low} {high}");

        // A whole campus of buildings and trees, as exported for the old app.
        let started = std::time::Instant::now();
        let buildings = std::fs::read(repo.join("buildings.geojson")).unwrap();
        let prepared = inspect(&campus, &Target::Buildings, "buildings.geojson", &buildings, Options::default());
        assert!(prepared.report.ok && prepared.report.count == 788, "{:?}", prepared.report);
        let (campus, _) = apply(&campus, prepared).unwrap();
        let trees = std::fs::read(repo.join("trees.geojson")).unwrap();
        let prepared = inspect(&campus, &Target::Trees, "trees.geojson", &trees, Options::default());
        assert_eq!(prepared.report.count, 8120);
        assert_eq!(prepared.report.preview.as_ref().unwrap()["features"].as_array().unwrap().len(), PREVIEW_LIMIT);
        let (campus, _) = apply(&campus, prepared).unwrap();
        let (_, stats) = campus.bake().unwrap();
        assert!(stats.buildings > 700 && stats.trees > 7000, "{stats:?}");
        assert!(started.elapsed().as_secs_f64() < 20.0, "{:?}", started.elapsed());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
