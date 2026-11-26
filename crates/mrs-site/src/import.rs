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
    /// Water areas (a river, a lake, the sea): `scene.water` (#343).
    Water,
    /// Footprints around the table that only shape the wind: `scene.context` (#488).
    Context,
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
            "water" => Self::Water,
            "context" => Self::Context,
            "walkways" => Self::Walkways,
            "trips" => Self::Trips,
            "terrain" => Self::Terrain,
            other => {
                let name = other.strip_prefix("data:").ok_or_else(|| {
                    format!(
                        "'{other}' is not something a table can take; use buildings, trees, water, context, walkways, trips, terrain or data:<name>"
                    )
                })?;
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
                    return Err("a dataset name is lowercase letters, digits, dashes and underscores".into());
                }
                match name {
                    "buildings" => Self::Buildings,
                    "trees" => Self::Trees,
                    "water" => Self::Water,
                    "context" => Self::Context,
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
            Self::Water => "water",
            Self::Context => "context",
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
            Self::Water => ("water area", "water areas"),
            Self::Context => ("building around the table", "buildings around the table"),
            Self::Walkways => ("path", "paths"),
            Self::Trips => ("trip", "trips"),
            Self::Terrain => ("terrain", "terrain"),
            Self::Data(_) => ("feature", "features"),
        }
    }

    /// The geometry kind it needs, if any.
    fn shape(&self) -> Option<Shape> {
        match self {
            Self::Buildings | Self::Water | Self::Context => Some(Shape::Area),
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
    /// A terrain with the buildings raised in it: set the ground under the footprints back (#344).
    pub flatten: bool,
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
    /// For terrain: take the buildings out of it when baking (#344).
    flatten: bool,
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
        flatten: false,
        file: None,
    };

    if *target == Target::Terrain {
        return terrain(site, bytes, options.crs, options.flatten);
    }

    if let Some(found) = crate::video::sniff(bytes) {
        return video(target, bytes, found);
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

    if is_drawing(filename, &text) {
        return drawing(site, target, &text, issues);
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
    // Buildings around the table may all lie off it (#488), but not further than the table is wide.
    let reach = if *target == Target::Context { 1.0 } else { 0.0 };
    let inside = features.iter().filter(|f| frame.touches(&f["geometry"], reach)).count();
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
    } else if outside > 0 && *target != Target::Context {
        // Buildings around the table are meant to lie outside it (#488).
        let message = format!("{outside} of {count} {plural} are outside the table.");
        issues.push(Issue::new("extent.outside_some", Severity::Warning, message).fix("crop"));
    }

    // Heights, for what the scene raises.
    let mut height_property = None;
    let mut summary = format!("{} {}", count, if count == 1 { singular } else { plural });
    match target {
        Target::Buildings => {
            let (property, known, renamed, estimated) = building_heights(&mut features);
            if renamed > 0 {
                issues.push(Issue::new(
                    "height.renamed",
                    Severity::Note,
                    format!("{renamed} {plural} had their height under another name than \"{property}\"; it was copied over."),
                ));
            }
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
        issues.push(Issue::new(
            "data.replaces",
            Severity::Note,
            format!("This replaces the table's {} ({existing}). Undo brings them back.", target.name()),
        ));
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
        flatten: false,
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
    // An import never writes over a file that holds something else (#512): the earlier data
    // stays under its own name, so Undo and the version history, which put site.json back,
    // bring the earlier data back with it.
    let relative = beside(&site.dir, &relative, content);
    let file = site.dir.join(&relative);
    let fresh = !file.exists();
    if fresh {
        let temporary = file.with_extension("import.tmp");
        std::fs::write(&temporary, content).map_err(io(&temporary))?;
        std::fs::rename(&temporary, &file).map_err(io(&file))?;
    }

    let manifest_path = site.dir.join("site.json");
    let before = std::fs::read_to_string(&manifest_path).map_err(io(&manifest_path))?;
    let parse = |e: serde_json::Error| SiteError::Parse { path: manifest_path.clone(), message: e.to_string() };
    let mut document: Value = serde_json::from_str(&before).map_err(parse)?;
    point_at(&mut document, &prepared.target, &relative, prepared.report.height_property.as_deref(), prepared.terrain_crs.as_deref());
    if prepared.target == Target::Terrain && prepared.flatten {
        document["scene"]["terrain"]["flatten_buildings"] = json!(true);
    }
    let after = serde_json::to_string_pretty(&document).map_err(parse)? + "\n";
    write_atomically(&manifest_path, &after)?;
    match Site::load(&site.dir) {
        Ok(updated) => {
            forget_old_versions(&site.dir, &relative, &[before.as_str(), after.as_str()]);
            prepared.report.path = Some(relative);
            Ok((updated, prepared.report))
        }
        Err(e) => {
            // A refused import changes nothing: the manifest is put back and the new file goes.
            write_atomically(&manifest_path, &before)?;
            if fresh {
                let _ = std::fs::remove_file(&file);
            }
            Err(e)
        }
    }
}

/// How many earlier versions of a data file are kept beside it, for Undo.
pub const KEPT_VERSIONS: usize = 3;

/// `data/buildings.geojson` as (`data/buildings`, `geojson`), and `data/buildings.v3.geojson`
/// as the same with version 3. The first file of a name is version 1.
pub(crate) fn version_of(relative: &str) -> (String, String, u32) {
    let (stem, extension) = relative.rsplit_once('.').unwrap_or((relative, ""));
    match stem.rsplit_once(".v").and_then(|(base, n)| n.parse::<u32>().ok().filter(|n| *n >= 2).map(|n| (base, n))) {
        Some((base, n)) => (base.to_string(), extension.to_string(), n),
        None => (stem.to_string(), extension.to_string(), 1),
    }
}

/// Every version of `relative` in the site folder, as (version, path relative to the site).
fn versions(site_dir: &Path, relative: &str) -> Vec<(u32, String)> {
    let (base, extension, _) = version_of(relative);
    let folder = Path::new(&base).parent().map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(site_dir.join(&folder)) else { return Vec::new() };
    let mut found: Vec<(u32, String)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(|name| if folder.is_empty() { name.to_string() } else { format!("{folder}/{name}") }))
        .filter_map(|path| {
            let (b, e, n) = version_of(&path);
            (b == base && e == extension).then_some((n, path))
        })
        .collect();
    found.sort();
    found
}

/// Where new `content` for `relative` is saved: the name itself while it is free, the version
/// that already holds exactly this content, or else the next version (`buildings.v2.geojson`).
fn beside(site_dir: &Path, relative: &str, content: &[u8]) -> String {
    let existing = versions(site_dir, relative);
    if existing.is_empty() {
        return relative.to_string();
    }
    let same = |path: &String| {
        let file = site_dir.join(path);
        std::fs::metadata(&file).is_ok_and(|m| m.len() == content.len() as u64) && std::fs::read(&file).is_ok_and(|b| b == content)
    };
    if let Some((_, path)) = existing.iter().find(|(_, path)| same(path)) {
        return path.clone();
    }
    let (base, extension, _) = version_of(relative);
    let next = existing.iter().map(|(n, _)| *n).max().unwrap_or(1) + 1;
    if extension.is_empty() {
        format!("{base}.v{next}")
    } else {
        format!("{base}.v{next}.{extension}")
    }
}

/// Removes versions of `current` that nothing needs any more: all but the newest
/// [`KEPT_VERSIONS`] earlier ones, never one that `manifests` (site.json before and after) name.
fn forget_old_versions(site_dir: &Path, current: &str, manifests: &[&str]) {
    let mut earlier: Vec<(u32, String)> = versions(site_dir, current).into_iter().filter(|(_, path)| path != current).collect();
    earlier.sort_by_key(|b| std::cmp::Reverse(b.0));
    for (_, path) in earlier.into_iter().skip(KEPT_VERSIONS) {
        if !manifests.iter().any(|text| text.contains(&format!("\"{path}\""))) {
            let _ = std::fs::remove_file(site_dir.join(path));
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
        Target::Water => {
            // A mask's `crs` belonged to the old file.
            document["scene"]["water"] = json!({ "path": path });
        }
        Target::Context => {
            // A reach already set stays.
            let reach = document["scene"]["context"]["reach_m"].clone();
            document["scene"]["context"] = json!({ "path": path });
            if !reach.is_null() {
                document["scene"]["context"]["reach_m"] = reach;
            }
        }
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

// ---- Videos (#194) -----------------------------------------------------------------

/// A video for a layer to play, such as a walk along a path: `data/<name>.mp4`, `.mov` or `.webm`.
fn video(target: &Target, bytes: &[u8], found: crate::video::Video) -> Prepared {
    let Target::Data(name) = target else {
        let message = format!("A video can't be {}. Add it as a dataset of its own, such as \"walk\".", target.noun().1);
        return Prepared {
            target: target.clone(),
            report: Report::refused(target, "video.target", message, "A video, not data."),
            content: None,
            terrain_crs: None,
            flatten: false,
            file: None,
        };
    };
    let mut issues = Vec::new();
    let kind = match found.format {
        "mp4" => "An MP4 video",
        "mov" => "A QuickTime video",
        _ => "A WebM video",
    };
    let mut words = vec![kind.to_string()];
    match found.duration_s {
        Some(d) => words.push(crate::video::length_words(d)),
        None => issues.push(Issue::new(
            "video.length",
            Severity::Warning,
            "The file does not say how long it is; a path is paced to the video once it plays.",
        )),
    }
    if let Some((w, h)) = found.size.filter(|(w, h)| *w > 0 && *h > 0) {
        words.push(format!("{w} by {h}"));
    }
    if found.format != "mp4" {
        issues.push(Issue::new(
            "video.format",
            Severity::Note,
            "MP4 (H.264) plays everywhere; some screens can't play other kinds of video.",
        ));
    }
    issues.push(Issue::new(
        "video.walk",
        Severity::Note,
        "Shown as a Video walk: the video plays on the controller while the walker moves along the path it was filmed on.",
    ));
    let mb = bytes.len() as f64 / 1e6;
    if mb > 100.0 {
        issues.push(Issue::new("video.large", Severity::Warning, format!("The video is {mb:.0} MB; the table file grows by as much.")));
    }
    Prepared {
        target: target.clone(),
        report: Report {
            ok: true,
            target: name.clone(),
            summary: words.join(", "),
            count: 1,
            inside: 1,
            outside: 0,
            crs: None,
            height_property: None,
            issues,
            preview: None,
            path: None,
        },
        content: Some(bytes.to_vec()),
        terrain_crs: None,
        flatten: false,
        file: Some(format!("data/{name}.{}", found.format)),
    }
}

// ---- Plan drawings (#193) -------------------------------------------------------

/// An SVG file, by its name or its first element.
fn is_drawing(filename: &str, text: &str) -> bool {
    let start = text.trim_start();
    filename.to_ascii_lowercase().ends_with(".svg")
        || start.starts_with("<svg")
        || (start.starts_with("<?xml") && start.get(..2048).unwrap_or(start).contains("<svg"))
}

/// A plan drawing over the table, whose groups a table reveals one at a time: `data/<name>.svg`.
fn drawing(site: &Site, target: &Target, text: &str, mut issues: Vec<Issue>) -> Prepared {
    let refused = |issues: Vec<Issue>, summary: &str| Prepared {
        target: target.clone(),
        report: Report { issues, ..Report::refused(target, "", "", summary) },
        content: None,
        terrain_crs: None,
        flatten: false,
        file: None,
    };
    let Target::Data(name) = target else {
        let message = format!("A drawing can't be {}. Add it as a dataset of its own, such as \"masterplan\".", target.noun().1);
        return refused(vec![Issue::new("plan.target", Severity::Blocker, message)], "A drawing, not data.");
    };
    let plan = match crate::plan::read(text) {
        Ok(plan) => plan,
        Err(message) => {
            issues.push(Issue::new("plan.unreadable", Severity::Blocker, message));
            return refused(issues, "Not a drawing MR Studio can show.");
        }
    };
    let (w, h) = plan.size;
    let (tw, th) = (site.manifest.extent.width_m, site.manifest.extent.height_m);
    let off = ((w / h) / (tw / th) - 1.0).abs();
    if off > 0.03 {
        let message = format!(
            "The drawing is {} by {} and the table {} by {} m, a different shape, so it is stretched {} to cover the table.",
            w.round(),
            h.round(),
            tw.round(),
            th.round(),
            if w / h > tw / th { "taller" } else { "wider" }
        );
        issues.push(Issue::new("plan.shape", Severity::Warning, message));
    }
    if !plan.removed.is_empty() {
        let message = format!("Taken out so the drawing can only draw: {}.", plan.removed.join(", "));
        issues.push(Issue::new("plan.cleaned", Severity::Note, message));
    }
    issues.push(Issue::new(
        "plan.cover",
        Severity::Note,
        "The drawing covers the whole table, its top along the table's top. Each group is a phase that Next reveals.",
    ));
    let names: Vec<&str> = plan.phases.iter().map(|p| p.name.as_str()).collect();
    let count = plan.phases.len();
    let summary = format!("A plan in {count} {}: {}", if count == 1 { "phase" } else { "phases" }, names.join(", "));
    Prepared {
        target: target.clone(),
        report: Report {
            ok: true,
            target: name.clone(),
            summary,
            count,
            inside: count,
            outside: 0,
            crs: None,
            height_property: None,
            issues,
            preview: None,
            path: None,
        },
        content: Some(plan.svg.into_bytes()),
        terrain_crs: None,
        flatten: false,
        file: Some(format!("data/{name}.svg")),
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
            return Prepared { target: target.clone(), report, content: None, terrain_crs: None, flatten: false, file: None };
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
        return Prepared { target: target.clone(), report, content: None, terrain_crs: None, flatten: false, file: None };
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
        issues.push(Issue::new(
            "data.replaces",
            Severity::Note,
            format!("This replaces the table's trips ({existing}). Undo brings them back."),
        ));
    }
    let groups: std::collections::BTreeSet<&str> = list.iter().filter_map(|t| t["group"].as_str()).collect();
    report.summary = format!("{} trips in {} groups", list.len(), groups.len().max(1));
    report.crs = Some(CrsReport { code: "EPSG:4326".into(), guessed: false });
    report.ok = !issues.iter().any(|i| i.severity == Severity::Blocker);
    report.issues = issues;
    let content = report.ok.then(|| json_file(&value));
    Prepared { target: target.clone(), report, content, terrain_crs: None, flatten: false, file: None }
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
        let line = (0..header.len())
            .map(|i| quote(&cell(row.get(i).map(String::as_str).unwrap_or(""), &mut comma_used)))
            .collect::<Vec<_>>()
            .join(",");
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
        issues.push(Issue::new(
            "data.replaces",
            Severity::Note,
            format!("This replaces the table's {} ({existing}). Undo brings them back.", target.name()),
        ));
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
    Prepared {
        target: target.clone(),
        report,
        content,
        terrain_crs: None,
        flatten: false,
        file: Some(format!("data/{}.csv", target.name())),
    }
}

// ---- Terrain -----------------------------------------------------------------

/// A GeoTIFF of ground heights: read it as the bake would, and say how much of the table it covers.
fn terrain(site: &Site, bytes: &[u8], crs: Option<u32>, flatten: bool) -> Prepared {
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
        Prepared { target: Target::Terrain, report, content, terrain_crs, flatten, file: None }
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
        issues.push(Issue::new(
            "data.replaces",
            Severity::Note,
            format!("This replaces the table's terrain ({}). Undo brings it back.", existing.path),
        ));
    }
    report.summary = format!("Ground from {low:.0} to {high:.0} m, covering {:.0}% of the table", (share * 100.0).min(100.0));
    // A surface model has the buildings in it: they would read as ground (#344).
    if let Some((raised, checked, median)) = raised_footprints(site, &raster) {
        if raised * 5 >= checked * 2 {
            let issue = if flatten {
                Issue::new(
                    "terrain.buildings",
                    Severity::Note,
                    format!("The buildings are raised in this terrain ({raised} of {checked} stand about {median:.0} m above the ground beside them). They will be set back to the ground when the table is built."),
                )
            } else {
                Issue::new(
                    "terrain.buildings",
                    Severity::Warning,
                    format!("This terrain has the buildings raised in it: {raised} of {checked} footprints stand about {median:.0} m above the ground beside them, so they would count as hills. Take them out to keep only the ground."),
                )
                .fix("flatten")
            };
            issues.push(issue);
        }
    }
    let terrain_crs = crs.map(|c| format!("EPSG:{c}"));
    done(report, issues, Some(bytes.to_vec()), terrain_crs)
}

/// How many of the table's footprints (up to 400) stand at least 3 m above the ground around
/// them in `raster`, of how many could be checked, and the median rise among those raised.
fn raised_footprints(site: &Site, raster: &GeoRaster) -> Option<(usize, usize, f32)> {
    let buildings = site.manifest.scene.buildings.as_ref()?;
    let features = crate::bake::features(&site.resolve(&buildings.path)?).ok()?;
    let (mut raised, mut checked, mut rises) = (0, 0, Vec::new());
    for feature in features.iter().take(400) {
        for polygon in crate::bake::polygons(&feature["geometry"]) {
            let outer: Vec<(f64, f64)> = polygon
                .first()
                .and_then(Value::as_array)
                .map(|ring| ring.iter().filter_map(|p| Some((p.get(0)?.as_f64()?, p.get(1)?.as_f64()?))).collect())
                .unwrap_or_default();
            if outer.len() < 4 {
                continue;
            }
            let n = outer.len() as f64;
            let (lon, lat) = (outer.iter().map(|p| p.0).sum::<f64>() / n, outer.iter().map(|p| p.1).sum::<f64>() / n);
            let (w, s, e, north) = outer
                .iter()
                .fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |(w, s, e, n), p| (w.min(p.0), s.min(p.1), e.max(p.0), n.max(p.1)));
            // 6 m beyond each side of the footprint's box.
            let (dx, dy) = (6.0 / (111_320.0 * lat.to_radians().cos()), 6.0 / 110_540.0);
            let around = [(w - dx, lat), (e + dx, lat), (lon, s - dy), (lon, north + dy)];
            let Some(inside) = raster.sample(lon, lat) else { continue };
            let Some(ground) = around.iter().filter_map(|(x, y)| raster.sample(*x, *y)).reduce(f32::min) else { continue };
            checked += 1;
            if inside - ground > 3.0 {
                raised += 1;
                rises.push(inside - ground);
            }
        }
    }
    if checked == 0 {
        return None;
    }
    rises.sort_by(f32::total_cmp);
    Some((raised, checked, rises.get(rises.len() / 2).copied().unwrap_or(0.0)))
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

/// Finds the property that holds building heights; a building that has its height under
/// another name (`höjd` where most use `height`, #411) gets it copied to that property, and
/// one with only storeys gets `height` from those. Returns the property, how many had a
/// height, how many of those came from another name, and how many were estimated.
fn building_heights(features: &mut [Value]) -> (String, usize, usize, usize) {
    let has = |f: &Value, p: &str| number(&f["properties"][p]).is_some_and(|h| h > 0.0);
    let heights = property_names(features, &["height", "height_m", "building:height", "höjd", "hojd", "höjd_m", "hojd_m"]);
    let property =
        heights.iter().max_by_key(|p| features.iter().filter(|f| has(f, p)).count()).filter(|p| features.iter().any(|f| has(f, p)));
    let property = property.cloned().unwrap_or_else(|| "height".to_string());
    let storeys = property_names(
        features,
        &["building:levels", "levels", "floors", "storeys", "vaningar", "våningar", "antal_vaningar", "antal_våningar"],
    );
    let (mut known, mut renamed, mut estimated) = (0, 0, 0);
    for feature in features.iter_mut() {
        if has(feature, &property) {
            known += 1;
            continue;
        }
        if let Some(h) = heights.iter().find_map(|p| number(&feature["properties"][p.as_str()]).filter(|h| *h > 0.0)) {
            feature["properties"][&property] = json!(h);
            known += 1;
            renamed += 1;
        } else if let Some(levels) = storeys.iter().find_map(|p| number(&feature["properties"][p.as_str()]).filter(|l| *l > 0.0)) {
            feature["properties"][&property] = json!(levels * METRES_PER_STOREY);
            estimated += 1;
        }
    }
    (property, known, renamed, estimated)
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

        // The sample has buildings already: the new ones are saved beside them (#512).
        let (updated, report) = apply(&site, prepared).unwrap();
        assert_eq!(report.path.as_deref(), Some("data/buildings.v2.geojson"));
        let b = updated.manifest.scene.buildings.as_ref().unwrap();
        assert_eq!((b.path.as_str(), b.height_property.as_str(), b.default_height_m), ("data/buildings.v2.geojson", "height", 12.0));
        let (_, stats) = updated.bake().unwrap();
        assert_eq!(stats.buildings, 3);
        let written: Value = serde_json::from_slice(&std::fs::read(updated.dir.join("data/buildings.v2.geojson")).unwrap()).unwrap();
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
        let (property, known, renamed, estimated) = building_heights(&mut features);
        assert_eq!((property.as_str(), known, renamed, estimated), ("HÖJD", 1, 0, 1));
        assert_eq!(features[0]["properties"]["HÖJD"], json!(4.0 * METRES_PER_STOREY));
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn buildings_that_mix_height_names_keep_every_height() {
        // #411: most use `height`, one only has `höjd`, one only storeys.
        let mut features = vec![
            json!({ "properties": { "height": 20 } }),
            json!({ "properties": { "height": "15 m" } }),
            json!({ "properties": { "höjd": 9 } }),
            json!({ "properties": { "building:levels": 2 } }),
            json!({ "properties": {} }),
        ];
        let (property, known, renamed, estimated) = building_heights(&mut features);
        assert_eq!((property.as_str(), known, renamed, estimated), ("height", 3, 1, 1));
        assert_eq!(features[2]["properties"]["height"], json!(9.0));
        assert!(features[4]["properties"]["height"].is_null());

        let site = scratch("mixed-heights");
        let square = |x: f64| json!([[[11.97 + x, 57.70], [11.9702 + x, 57.70], [11.9702 + x, 57.7002], [11.97 + x, 57.70]]]);
        let file = json!({ "type": "FeatureCollection", "features": [
            { "type": "Feature", "properties": { "height": 20 }, "geometry": { "type": "Polygon", "coordinates": square(0.0) } },
            { "type": "Feature", "properties": { "height": 18 }, "geometry": { "type": "Polygon", "coordinates": square(0.0004) } },
            { "type": "Feature", "properties": { "höjd": 9 }, "geometry": { "type": "Polygon", "coordinates": square(0.0008) } },
        ]});
        let bytes = serde_json::to_vec(&file).unwrap();
        let r = inspect(&site, &Target::Buildings, "mixed.geojson", &bytes, Options::default()).report;
        assert!(r.ok, "{:?}", r.issues);
        assert_eq!(r.height_property.as_deref(), Some("height"));
        assert!(r.summary.contains("3 with a height"), "{}", r.summary);
        assert!(codes(&r).contains(&"height.renamed") && !codes(&r).contains(&"height.missing"), "{:?}", r.issues);
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
    fn a_video_lands_with_its_length() {
        let site = scratch("video");
        // An MP4 whose movie header says 90 s: ftyp, then moov > mvhd.
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&600u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&54_000u32.to_be_bytes());
        let boxed = |kind: &[u8], body: &[u8]| [&((body.len() + 8) as u32).to_be_bytes()[..], kind, body].concat();
        let bytes = [boxed(b"ftyp", b"isom\0\0\x02\0"), boxed(b"moov", &boxed(b"mvhd", &mvhd))].concat();
        let prepared = inspect(&site, &Target::Data("walk".into()), "walk.mp4", &bytes, Options::default());
        assert!(prepared.report.ok, "{:?}", prepared.report.issues);
        assert_eq!(prepared.report.summary, "An MP4 video, 1 min 30 s");
        let (site2, report) = apply(&site, prepared).unwrap();
        assert_eq!(report.path.as_deref(), Some("data/walk.mp4"));
        assert_eq!(site2.data()["walk"], "data/walk.mp4");
        assert_eq!(std::fs::read(site.dir.join("data/walk.mp4")).unwrap(), bytes);
        let trees = inspect(&site2, &Target::Trees, "walk.mp4", &bytes, Options::default()).report;
        assert!(!trees.ok && trees.issues[0].code == "video.target");
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn a_plan_drawing_lands_as_svg_with_its_phases() {
        let site = scratch("plan");
        let drawing = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600"><script>alert(1)</script>
            <g id="boundary"><path d="M0 0H10" stroke="#e03131"/></g><g id="green_spaces"><rect width="5" height="5" fill="#2f9e44"/></g></svg>"##;
        let prepared = inspect(&site, &Target::Data("masterplan".into()), "campus.svg", drawing, Options::default());
        let report = &prepared.report;
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.summary, "A plan in 2 phases: Boundary, Green spaces");
        assert!(report.issues.iter().any(|i| i.code == "plan.cleaned"));
        assert!(!report.issues.iter().any(|i| i.code == "plan.shape"), "1000 by 600 is the sample table's shape");
        let (site2, report) = apply(&site, prepared).unwrap();
        assert_eq!(report.path.as_deref(), Some("data/masterplan.svg"));
        assert_eq!(site2.data()["masterplan"], "data/masterplan.svg");
        let written = std::fs::read_to_string(site.dir.join("data/masterplan.svg")).unwrap();
        assert!(written.contains(r#"data-mrs-name="Green spaces""#) && !written.contains("alert"));

        // Another shape is stretched, and said so; a drawing is never buildings.
        let square = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g id="a"><path d="M0 0"/></g></svg>"#;
        let r = inspect(&site2, &Target::Data("square".into()), "square.svg", square, Options::default()).report;
        assert!(r.ok && r.issues.iter().any(|i| i.code == "plan.shape" && i.message.contains("wider")), "{:?}", r.issues);
        let r = inspect(&site2, &Target::Buildings, "square.svg", square, Options::default()).report;
        assert!(!r.ok && r.issues[0].code == "plan.target");
        let r = inspect(
            &site2,
            &Target::Data("flat".into()),
            "flat.svg",
            br#"<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>"#,
            Options::default(),
        )
        .report;
        assert!(!r.ok && r.issues[0].code == "plan.unreadable");
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn buildings_around_the_table_go_into_the_scene_for_the_wind() {
        // One footprint on the table and one about 200 m west of its edge (#488).
        let site = scratch("context");
        let square = |lon: f64| {
            json!({
                "type": "Feature", "properties": {},
                "geometry": { "type": "Polygon", "coordinates": [[[lon, 57.6998], [lon + 0.0004, 57.6998], [lon + 0.0004, 57.7002], [lon, 57.7002], [lon, 57.6998]]] }
            })
        };
        let ring = collection(vec![square(11.970), square(11.958)]);
        let prepared = inspect(&site, &Target::Context, "context.geojson", &ring, Options::default());
        assert!(prepared.report.ok, "{:?}", prepared.report.issues);
        assert!(
            prepared.report.issues.iter().all(|i| i.code != "extent.outside_some"),
            "outside is where they belong: {:?}",
            prepared.report.issues
        );
        let (site2, _) = apply(&site, prepared).unwrap();
        let context = site2.manifest.scene.context.as_ref().unwrap();
        assert_eq!((context.path.as_str(), context.reach_m), ("data/context.geojson", 500.0));
        assert_eq!(site2.data()["context"], "data/context.geojson");
        let (scene, stats) = site2.bake().unwrap();
        assert_eq!(stats.context_buildings, 2);
        let ring = scene.context.unwrap();
        assert_eq!(ring.margin, 500);
        // The west one lies outside the grid, in the ring; nothing of it is raised on the table.
        let (east, north) = site2.projection().to_local(11.9582, 57.70);
        let (col, row) = scene.grid.local_to_cell(east, north);
        assert!(col < 0.0);
        assert!(ring.is_solid(&scene.grid, col.floor() as i64, row.floor() as i64));
        assert!(!ring.is_solid(&scene.grid, col.floor() as i64, row.floor() as i64 - 60));
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn water_areas_go_into_the_scene_and_bake_as_water() {
        let site = scratch("water");
        let river = collection(vec![json!({
            "type": "Feature", "properties": { "natural": "water" },
            "geometry": { "type": "Polygon", "coordinates": [[[11.968, 57.6995], [11.972, 57.6995], [11.972, 57.7005], [11.968, 57.7005], [11.968, 57.6995]]] }
        })]);
        let prepared = inspect(&site, &Target::Water, "river.geojson", &river, Options::default());
        assert!(prepared.report.ok, "{:?}", prepared.report.issues);
        let lines = collection(vec![
            json!({ "type": "Feature", "properties": {}, "geometry": { "type": "LineString", "coordinates": [[11.969, 57.70], [11.971, 57.70]] } }),
        ]);
        assert!(!inspect(&site, &Target::Water, "l.geojson", &lines, Options::default()).report.ok, "water needs areas");
        let (site2, _) = apply(&site, prepared).unwrap();
        assert_eq!(site2.manifest.scene.water.as_ref().unwrap().path, "data/water.geojson");
        assert_eq!(site2.data()["water"], "data/water.geojson");
        let (scene, stats) = site2.bake().unwrap();
        assert!(stats.water_fraction > 0.01, "{stats:?}");
        assert_eq!(scene.water.iter().filter(|w| **w != 0).count() as f32 / scene.water.len() as f32, stats.water_fraction);
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn walkways_trips_and_named_datasets_land_under_data() {
        let site = scratch("data");
        let walk = collection(vec![
            json!({ "type": "Feature", "properties": {}, "geometry": { "type": "LineString", "coordinates": [[11.969, 57.70], [11.971, 57.70]] } }),
        ]);
        let (site2, _) = apply(&site, inspect(&site, &Target::Walkways, "w.geojson", &walk, Options::default())).unwrap();
        assert_eq!(site2.data()["walkways"], "data/walkways.v2.geojson");

        let trips = json!({ "trips": [{ "group": "walk", "legs": [{ "start": 0, "duration": 60, "coordinates": [[11.969, 57.70], [11.971, 57.70]] }] }] });
        let prepared = inspect(&site2, &Target::Trips, "trips.json", &serde_json::to_vec(&trips).unwrap(), Options::default());
        assert!(prepared.report.ok, "{:?}", prepared.report.issues);
        assert_eq!(prepared.report.summary, "1 trips in 1 groups");
        let (site3, _) = apply(&site2, prepared).unwrap();
        assert_eq!(site3.data()["trips"], "data/trips.v2.json");

        let bad = inspect(&site3, &Target::Trips, "trips.json", br#"{ "nope": [] }"#, Options::default());
        assert_eq!(bad.report.issues[0].code, "trips.format");
        assert!(apply(&site3, bad).is_err());
        assert!(!site3.dir.join("data/trips.v3.json").exists(), "a refused import leaves no file");

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

    /// #512: an import never writes over other data, so putting site.json back (Undo, the
    /// version history) brings the earlier data back with it.
    #[test]
    fn an_import_keeps_the_data_it_replaces_and_undo_finds_it() {
        let site = scratch("keeps");
        let original = std::fs::read(site.dir.join("data/buildings.geojson")).unwrap();
        let first_manifest = std::fs::read_to_string(site.dir.join("site.json")).unwrap();
        let square = |lon: f64| {
            collection(vec![json!({ "type": "Feature", "properties": { "height": 9 }, "geometry": { "type": "Polygon", "coordinates":
                [[[lon, 57.70], [lon + 0.0004, 57.70], [lon + 0.0004, 57.7002], [lon, 57.7002], [lon, 57.70]]] } })])
        };
        let import = |site: &Site, lon: f64| {
            apply(site, inspect(site, &Target::Buildings, "b.geojson", &square(lon), Options::default())).unwrap().0
        };

        let second = import(&site, 11.9690);
        assert_eq!(second.manifest.scene.buildings.as_ref().unwrap().path, "data/buildings.v2.geojson");
        assert_eq!(std::fs::read(site.dir.join("data/buildings.geojson")).unwrap(), original, "the earlier buildings are untouched");
        assert_eq!(second.bake().unwrap().1.buildings, 1);

        // Undo is site.json as it was: the table has its first buildings again.
        std::fs::write(site.dir.join("site.json"), &first_manifest).unwrap();
        let undone = Site::load(&site.dir).unwrap();
        assert_eq!(undone.manifest.scene.buildings.as_ref().unwrap().path, "data/buildings.geojson");
        assert_eq!(std::fs::read(undone.dir.join("data/buildings.geojson")).unwrap(), original);

        // The same data again is the same file, not another copy.
        let again = import(&undone, 11.9690);
        assert_eq!(again.manifest.scene.buildings.as_ref().unwrap().path, "data/buildings.v2.geojson");
        assert!(!site.dir.join("data/buildings.v3.geojson").exists());

        // Only the last few earlier versions are kept, and never fewer than what site.json names.
        let mut latest = again;
        for n in 0..6 {
            latest = import(&latest, 11.9700 + n as f64 * 0.0005);
        }
        assert_eq!(latest.manifest.scene.buildings.as_ref().unwrap().path, "data/buildings.v8.geojson");
        let kept: Vec<u32> = versions(&site.dir, "data/buildings.geojson").into_iter().map(|(n, _)| n).collect();
        assert_eq!(kept, [5, 6, 7, 8], "the current one and the {KEPT_VERSIONS} before it");
        std::fs::remove_dir_all(&site.dir).unwrap();
    }

    #[test]
    fn versions_are_told_from_ordinary_names() {
        assert_eq!(version_of("data/buildings.geojson"), ("data/buildings".into(), "geojson".into(), 1));
        assert_eq!(version_of("data/buildings.v3.geojson"), ("data/buildings".into(), "geojson".into(), 3));
        // A name that only looks like one is a name.
        assert_eq!(version_of("data/plan.v1.geojson").2, 1);
        assert_eq!(version_of("data/survey.vast.geojson"), ("data/survey.vast".into(), "geojson".into(), 1));
    }

    /// A WGS84 GeoTIFF over `bounds` (s, w, n, e) with `height(lon, lat)` in each pixel.
    fn wgs84_tif(bounds: [f64; 4], pixel: f64, height: impl Fn(f64, f64) -> f32) -> Vec<u8> {
        use tiff::encoder::{colortype::Gray32Float, TiffEncoder};
        use tiff::tags::Tag;
        let [s, w, n, e] = bounds;
        let (width, rows) = (((e - w) / pixel).ceil() as usize, ((n - s) / pixel).ceil() as usize);
        let mut data = Vec::with_capacity(width * rows);
        for row in 0..rows {
            for col in 0..width {
                data.push(height(w + (col as f64 + 0.5) * pixel, n - (row as f64 + 0.5) * pixel));
            }
        }
        let mut bytes = std::io::Cursor::new(Vec::new());
        let mut encoder = TiffEncoder::new(&mut bytes).unwrap();
        let mut image = encoder.new_image::<Gray32Float>(width as u32, rows as u32).unwrap();
        image.encoder().write_tag(Tag::ModelPixelScaleTag, &[pixel, pixel, 0.0][..]).unwrap();
        image.encoder().write_tag(Tag::ModelTiepointTag, &[0.0, 0.0, 0.0, w, n, 0.0][..]).unwrap();
        let keys: [u16; 16] = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];
        image.encoder().write_tag(Tag::GeoKeyDirectoryTag, &keys[..]).unwrap();
        image.write_data(&data).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn a_surface_model_with_the_buildings_in_it_is_offered_flattening() {
        let site = scratch("terrain-dsm");
        // The sample's footprints (courtyards left as ground), raised 15 m above flat ground at 10 m: a surface model.
        let path = site.resolve(&site.manifest.scene.buildings.as_ref().unwrap().path).unwrap();
        let rings: Vec<Vec<(f64, f64)>> = crate::bake::features(&path)
            .unwrap()
            .iter()
            .flat_map(|f| {
                crate::bake::polygons(&f["geometry"])
                    .into_iter()
                    .flat_map(|p| {
                        p.iter()
                            .map(|ring| ring.as_array().unwrap().iter().map(|q| (q[0].as_f64().unwrap(), q[1].as_f64().unwrap())).collect())
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        let inside = |x: f64, y: f64, ring: &[(f64, f64)]| {
            let mut hit = false;
            for (i, a) in ring.iter().enumerate() {
                let b = ring[(i + 1) % ring.len()];
                if (a.1 > y) != (b.1 > y) && x < a.0 + (y - a.1) * (b.0 - a.0) / (b.1 - a.1) {
                    hit = !hit;
                }
            }
            hit
        };
        let boxes: Vec<[f64; 4]> = rings
            .iter()
            .map(|r| {
                r.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| [b[0].min(p.0), b[1].min(p.1), b[2].max(p.0), b[3].max(p.1)])
            })
            .collect();
        // Even-odd over every ring, so courtyards stay ground.
        let raised = |x: f64, y: f64| {
            rings.iter().zip(&boxes).filter(|(r, b)| x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && inside(x, y, r)).count() % 2 == 1
        };
        // About a metre a pixel, as a national surface model.
        let dsm = wgs84_tif([57.6955, 11.9590, 57.7040, 11.9810], 0.000012, |x, y| if raised(x, y) { 25.0 } else { 10.0 });
        let plain = inspect(&site, &Target::Terrain, "dsm.tif", &dsm, Options::default());
        let issue = plain.report.issues.iter().find(|i| i.code == "terrain.buildings").expect("raised footprints are noticed");
        assert_eq!((issue.severity, issue.fix), (Severity::Warning, Some("flatten")));
        assert!(issue.message.contains("15 m"), "{}", issue.message);

        let taken = inspect(&site, &Target::Terrain, "dsm.tif", &dsm, Options { flatten: true, ..Default::default() });
        assert_eq!(taken.report.issues.iter().find(|i| i.code == "terrain.buildings").unwrap().severity, Severity::Note);
        let (site, _) = apply(&site, taken).unwrap();
        assert!(site.manifest.scene.terrain.as_ref().unwrap().flatten_buildings);
        let (scene, stats) = site.bake().unwrap();
        assert!(stats.terrain_flattened_cells > 100, "{stats:?}");
        // Only the ground is left (narrow courtyards keep a little of the roofs around them).
        let ground = scene.dtm.iter().filter(|&&z| (z - 10.0).abs() < 0.5).count();
        assert!(ground * 1000 >= scene.dtm.len() * 998, "{ground} of {}", scene.dtm.len());
        assert!(scene.dtm.iter().all(|&z| z < 15.0));

        // Ground with no buildings in it is left alone.
        let ground = wgs84_tif([57.6955, 11.9590, 57.7040, 11.9810], 0.0002, |_, _| 10.0);
        assert!(!codes(&inspect(&site, &Target::Terrain, "dtm.tif", &ground, Options::default()).report).contains(&"terrain.buildings"));
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
