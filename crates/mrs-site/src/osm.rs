//! OpenStreetMap as a source for a table's place data: the Overpass query for a site's
//! extent, and the answer turned into GeoJSON that `import::inspect` takes like any file.
//!
//! The host does the fetching; this module only writes queries and reads answers, so it
//! works and is tested without a network.

use serde_json::{json, Map, Value};

use crate::import::Target;
use crate::Site;

/// Shown with any table that uses OpenStreetMap data; the ODbL requires it.
pub const ATTRIBUTION: &str = "© OpenStreetMap contributors";
/// The share of the table's size fetched around it, so lines and areas crossing the edge are whole.
const MARGIN: f64 = 0.1;

/// The road classes traffic drives on.
const STREETS: &str = "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service";
/// The paths people walk on.
const WATER_WAY: &str = "way[\"natural\"=\"water\"]";
const WATER_RELATION: &str = "relation[\"natural\"=\"water\"][\"type\"=\"multipolygon\"]";
const WALKWAYS: &str = "footway|path|pedestrian|steps|living_street|cycleway|track|residential|service|unclassified";

/// What OpenStreetMap can give a table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsmLayer {
    Buildings,
    Trees,
    Walkways,
    Streets,
    /// Rivers, lakes and harbour basins mapped as areas (#343).
    Water,
}

impl OsmLayer {
    /// The layer for an import target, or why OpenStreetMap has none.
    pub fn for_target(target: &Target) -> Result<Self, String> {
        match target {
            Target::Buildings => Ok(Self::Buildings),
            Target::Trees => Ok(Self::Trees),
            Target::Walkways => Ok(Self::Walkways),
            Target::Water => Ok(Self::Water),
            Target::Data(name) if name == "roads" || name == "streets" => Ok(Self::Streets),
            Target::Trips => Err("OpenStreetMap has no trips; they come from a travel survey or a simulation".into()),
            Target::Terrain => Err("OpenStreetMap has no ground heights; use a terrain GeoTIFF".into()),
            Target::Context => {
                Err("bring buildings around the table in from a file; fetching them from OpenStreetMap is not built yet".into())
            }
            Target::Data(name) => Err(format!("OpenStreetMap can fill buildings, trees, water, walkways and roads, not '{name}'")),
        }
    }

    fn words(self) -> &'static str {
        match self {
            Self::Buildings => "buildings",
            Self::Trees => "trees",
            Self::Walkways => "walkways",
            Self::Streets => "streets",
            Self::Water => "water areas",
        }
    }
}

/// South, west, north, east of the table plus a margin, in degrees.
pub fn bounds(site: &Site) -> [f64; 4] {
    let info = site.info();
    let (mut s, mut w, mut n, mut e) = (90.0_f64, 180.0_f64, -90.0_f64, -180.0_f64);
    for [lon, lat] in info.corners {
        (s, w, n, e) = (s.min(lat), w.min(lon), n.max(lat), e.max(lon));
    }
    let (dy, dx) = ((n - s) * MARGIN, (e - w) * MARGIN);
    [s - dy, w - dx, n + dy, e + dx]
}

/// The Overpass QL query for one layer within `bounds`.
pub fn query(layer: OsmLayer, bounds: [f64; 4]) -> String {
    let [s, w, n, e] = bounds;
    let b = format!("({s:.6},{w:.6},{n:.6},{e:.6})");
    let body = match layer {
        OsmLayer::Buildings => format!("(way[\"building\"]{b};relation[\"building\"][\"type\"=\"multipolygon\"]{b};);out geom;"),
        OsmLayer::Trees => format!("node[\"natural\"=\"tree\"]{b};out;"),
        OsmLayer::Walkways => format!("way[\"highway\"~\"^({WALKWAYS})$\"]{b};out geom;"),
        OsmLayer::Streets => format!("way[\"highway\"~\"^({STREETS})$\"]{b};out geom;"),
        OsmLayer::Water => format!("({WATER_WAY}{b};{WATER_RELATION}{b};way[\"waterway\"=\"riverbank\"]{b};);out geom;"),
    };
    format!("[out:json][timeout:90];{body}")
}

/// One Overpass QL query for several layers at once (#310), so a table's open data is one
/// polite request instead of one per layer. `to_geojson` picks each layer's share of the answer.
pub fn query_all(layers: &[OsmLayer], bounds: [f64; 4]) -> String {
    let [s, w, n, e] = bounds;
    let b = format!("({s:.6},{w:.6},{n:.6},{e:.6})");
    let mut parts = String::new();
    if layers.contains(&OsmLayer::Buildings) {
        parts.push_str(&format!("way[\"building\"]{b};relation[\"building\"][\"type\"=\"multipolygon\"]{b};"));
    }
    if layers.contains(&OsmLayer::Water) {
        parts.push_str(&format!("{WATER_WAY}{b};{WATER_RELATION}{b};way[\"waterway\"=\"riverbank\"]{b};"));
    }
    if layers.contains(&OsmLayer::Trees) {
        parts.push_str(&format!("node[\"natural\"=\"tree\"]{b};"));
    }
    // Streets and walkways share some classes: one regex for both, so each way comes once.
    let mut classes: Vec<&str> = Vec::new();
    for (layer, list) in [(OsmLayer::Streets, STREETS), (OsmLayer::Walkways, WALKWAYS)] {
        if layers.contains(&layer) {
            for class in list.split('|') {
                if !classes.contains(&class) {
                    classes.push(class);
                }
            }
        }
    }
    if !classes.is_empty() {
        parts.push_str(&format!("way[\"highway\"~\"^({})$\"]{b};", classes.join("|")));
    }
    format!("[out:json][timeout:180];({parts});out geom;")
}

/// The widest side of one Overpass query, in metres (#424). A whole table at once made the main
/// server answer 502 for buildings; tiles this size come back in seconds and a failed one is
/// asked again on its own.
pub const TILE_M: f64 = 1200.0;

/// `bounds` (south, west, north, east) cut into a grid of tiles no wider than `side_m`.
pub fn tiles(bounds: [f64; 4], side_m: f64) -> Vec<[f64; 4]> {
    let [s, w, n, e] = bounds;
    let metres_lat = 111_320.0;
    let metres_lon = metres_lat * ((s + n) / 2.0).to_radians().cos().max(0.01);
    let rows = (((n - s) * metres_lat) / side_m).ceil().max(1.0) as usize;
    let cols = (((e - w) * metres_lon) / side_m).ceil().max(1.0) as usize;
    let (dy, dx) = ((n - s) / rows as f64, (e - w) / cols as f64);
    // The last row and column end exactly on the bounds.
    let lat = |i: usize| if i == rows { n } else { s + dy * i as f64 };
    let lon = |i: usize| if i == cols { e } else { w + dx * i as f64 };
    let mut out = Vec::with_capacity(rows * cols);
    for r in 0..rows {
        for c in 0..cols {
            out.push([lat(r), lon(c), lat(r + 1), lon(c + 1)]);
        }
    }
    out
}

/// Overpass answers for neighbouring tiles as one answer: an element that crosses a tile edge
/// comes back from both tiles and is kept once.
#[derive(Default)]
pub struct Merge {
    seen: std::collections::HashSet<(String, i64)>,
    elements: Vec<Value>,
}

impl Merge {
    pub fn add(&mut self, answer: Value) {
        let Value::Array(elements) = answer.get("elements").cloned().unwrap_or(Value::Null) else { return };
        for element in elements {
            let key = (element["type"].as_str().unwrap_or("?").to_string(), element["id"].as_i64().unwrap_or(-1));
            if key.1 < 0 || self.seen.insert(key) {
                self.elements.push(element);
            }
        }
    }

    pub fn answer(self) -> Value {
        json!({ "elements": self.elements })
    }
}

/// Whether an Overpass element belongs to `layer`, by its kind and tags.
fn belongs(layer: OsmLayer, element: &Value) -> bool {
    let tags = &element["tags"];
    let highway = |list: &str| tags["highway"].as_str().is_some_and(|h| list.split('|').any(|c| c == h));
    match (layer, element["type"].as_str()) {
        (OsmLayer::Buildings, Some("way")) => tags.get("building").is_some(),
        (OsmLayer::Buildings, Some("relation")) => tags.get("building").is_some(),
        (OsmLayer::Trees, Some("node")) => tags["natural"] == "tree",
        (OsmLayer::Water, Some("way" | "relation")) => tags["natural"] == "water" || tags["waterway"] == "riverbank",
        (OsmLayer::Walkways, Some("way")) => highway(WALKWAYS),
        (OsmLayer::Streets, Some("way")) => highway(STREETS),
        _ => false,
    }
}

/// An Overpass answer as a GeoJSON FeatureCollection, with every OSM tag kept as a
/// property and the source named in a `source` member, which the import keeps.
pub fn to_geojson(layer: OsmLayer, answer: &Value, fetched: &str) -> Value {
    let mut features = Vec::new();
    for element in answer["elements"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        // An answer to `query_all` holds every layer: keep this one's share.
        if !belongs(layer, element) {
            continue;
        }
        let mut properties: Map<String, Value> = element["tags"].as_object().cloned().unwrap_or_default();
        properties.insert("osm_id".into(), json!(format!("{}/{}", element["type"].as_str().unwrap_or("?"), element["id"])));
        let geometry = match (layer, element["type"].as_str()) {
            (OsmLayer::Trees, Some("node")) => {
                let (Some(lon), Some(lat)) = (element["lon"].as_f64(), element["lat"].as_f64()) else { continue };
                json!({ "type": "Point", "coordinates": [lon, lat] })
            }
            (OsmLayer::Buildings | OsmLayer::Water, Some("way")) => {
                let ring = line(&element["geometry"]);
                if ring.len() < 4 || ring.first() != ring.last() {
                    continue;
                }
                json!({ "type": "Polygon", "coordinates": [ring] })
            }
            (OsmLayer::Buildings | OsmLayer::Water, Some("relation")) => {
                let Some(polygons) = multipolygon(&element["members"]) else { continue };
                json!({ "type": "MultiPolygon", "coordinates": polygons })
            }
            (OsmLayer::Walkways | OsmLayer::Streets, Some("way")) => {
                let path = line(&element["geometry"]);
                if path.len() < 2 {
                    continue;
                }
                if layer == OsmLayer::Streets {
                    // What the traffic layer reads; the OSM class stays in `highway`.
                    properties.insert("kind".into(), json!("street"));
                }
                json!({ "type": "LineString", "coordinates": path })
            }
            _ => continue,
        };
        features.push(json!({ "type": "Feature", "properties": properties, "geometry": geometry }));
    }
    json!({
        "type": "FeatureCollection",
        "source": { "name": "OpenStreetMap", "layer": layer.words(), "attribution": ATTRIBUTION, "licence": "ODbL-1.0", "fetched": fetched },
        "features": features,
    })
}

/// `YYYY-MM-DD` for a time in seconds since 1970, in UTC.
pub fn date(unix_seconds: u64) -> String {
    // Howard Hinnant's days-to-civil.
    let z = (unix_seconds / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// How many features an Overpass answer turned into.
pub fn count(collection: &Value) -> usize {
    collection["features"].as_array().map_or(0, Vec::len)
}

/// The words for an empty answer.
pub fn nothing_found(layer: OsmLayer) -> String {
    format!("OpenStreetMap has no {} mapped around this table.", layer.words())
}

/// Overpass `geometry`, a list of `{ lat, lon }`, as `[lon, lat]` positions.
fn line(geometry: &Value) -> Vec<[f64; 2]> {
    let points = geometry.as_array().map(Vec::as_slice).unwrap_or(&[]);
    points.iter().filter_map(|p| Some([p["lon"].as_f64()?, p["lat"].as_f64()?])).collect()
}

/// A multipolygon relation's member ways joined into closed rings, outers with their inners.
/// Inners are given to the first outer; buildings with several outers and courtyards are rare.
fn multipolygon(members: &Value) -> Option<Vec<Vec<Vec<[f64; 2]>>>> {
    let ways = |role: &str| -> Vec<Vec<[f64; 2]>> {
        let members = members.as_array().map(Vec::as_slice).unwrap_or(&[]);
        members.iter().filter(|m| m["type"] == "way" && m["role"] == role).map(|m| line(&m["geometry"])).filter(|l| l.len() >= 2).collect()
    };
    let outers = rings(ways("outer"));
    if outers.is_empty() {
        return None;
    }
    let inners = rings(ways("inner"));
    let mut polygons: Vec<Vec<Vec<[f64; 2]>>> = outers.into_iter().map(|outer| vec![outer]).collect();
    polygons[0].extend(inners);
    Some(polygons)
}

/// Joins line pieces end to end into closed rings. Pieces that never close are dropped.
fn rings(mut pieces: Vec<Vec<[f64; 2]>>) -> Vec<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    while let Some(mut ring) = pieces.pop() {
        while ring.first() != ring.last() {
            let end = *ring.last().expect("not empty");
            let Some(i) = pieces.iter().position(|p| p.first() == Some(&end) || p.last() == Some(&end)) else { break };
            let mut next = pieces.swap_remove(i);
            if next.first() != Some(&end) {
                next.reverse();
            }
            ring.extend(next.into_iter().skip(1));
        }
        if ring.len() >= 4 && ring.first() == ring.last() {
            out.push(ring);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::{apply, inspect, Options};
    use std::path::Path;

    fn sample() -> Site {
        Site::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sites/sample")).unwrap()
    }

    fn node(lat: f64, lon: f64) -> Value {
        json!({ "lat": lat, "lon": lon })
    }

    #[test]
    fn targets_and_queries() {
        assert_eq!(OsmLayer::for_target(&Target::Data("roads".into())), Ok(OsmLayer::Streets));
        assert!(OsmLayer::for_target(&Target::Trips).unwrap_err().contains("no trips"));
        assert!(OsmLayer::for_target(&Target::Terrain).is_err());
        let [s, w, n, e] = bounds(&sample());
        // The sample district is 1000 x 600 m around 11.97, 57.70, plus a tenth on each side.
        assert!(s < 57.6973 && n > 57.7027 && w < 11.9616 && e > 11.9784, "{s} {w} {n} {e}");
        let q = query(OsmLayer::Buildings, [57.69, 11.96, 57.71, 11.98]);
        assert_eq!(date(1_763_164_800), "2025-11-15");
        assert_eq!(q, "[out:json][timeout:90];(way[\"building\"](57.690000,11.960000,57.710000,11.980000);relation[\"building\"][\"type\"=\"multipolygon\"](57.690000,11.960000,57.710000,11.980000););out geom;");
    }

    #[test]
    fn an_overpass_answer_becomes_an_importable_dataset() {
        let (a, b, c, d) = (node(57.7000, 11.9700), node(57.7000, 11.9702), node(57.7002, 11.9702), node(57.7002, 11.9700));
        let answer = json!({ "elements": [
            { "type": "way", "id": 1, "tags": { "building": "yes", "building:levels": "3" }, "geometry": [a, b, c, d, a] },
            // A courtyard building drawn as a relation, its outer ring in two pieces.
            { "type": "relation", "id": 2, "tags": { "building": "university", "height": "18" }, "members": [
                { "type": "way", "role": "outer", "geometry": [node(57.701, 11.971), node(57.701, 11.972), node(57.702, 11.972)] },
                { "type": "way", "role": "outer", "geometry": [node(57.701, 11.971), node(57.702, 11.971), node(57.702, 11.972)] },
                { "type": "way", "role": "inner", "geometry": [node(57.7013, 11.9713), node(57.7013, 11.9716), node(57.7016, 11.9716), node(57.7013, 11.9713)] },
            ] },
            // An unclosed way is not a building.
            { "type": "way", "id": 3, "tags": { "building": "yes" }, "geometry": [a, b, c] },
        ] });
        let collection = to_geojson(OsmLayer::Buildings, &answer, "2026-11-15");
        let features = collection["features"].as_array().unwrap();
        assert_eq!(features.len(), 2);
        assert_eq!(features[1]["geometry"]["type"], "MultiPolygon");
        assert_eq!(features[1]["geometry"]["coordinates"][0].as_array().unwrap().len(), 2, "outer and courtyard");
        assert_eq!(features[1]["properties"]["osm_id"], "relation/2");

        // Through the import, as the host does it: heights found, storeys estimated, source kept.
        let base = std::env::temp_dir().join(format!("mrs-osm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("osm-place");
        crate::create::create(&dir, "OSM place", 11.97, 57.70, 1000.0, 600.0, 0.0).unwrap();
        let site = Site::load(&dir).unwrap();
        let bytes = serde_json::to_vec(&collection).unwrap();
        let prepared = inspect(&site, &Target::Buildings, "openstreetmap.geojson", &bytes, Options::default());
        let report = &prepared.report;
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.summary, "2 buildings, 2 with a height");
        assert!(report.issues.iter().any(|i| i.code == "source.osm" && i.message.contains(ATTRIBUTION)));
        let (site, _) = apply(&site, prepared).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(site.dir.join("data/buildings.geojson")).unwrap()).unwrap();
        assert_eq!(written["source"]["attribution"], ATTRIBUTION);
        assert_eq!(site.bake().unwrap().1.buildings, 2);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn one_answer_for_every_layer() {
        let all = [OsmLayer::Buildings, OsmLayer::Trees, OsmLayer::Walkways, OsmLayer::Streets];
        let q = query_all(&all, [57.69, 11.96, 57.71, 11.98]);
        assert!(q.starts_with("[out:json][timeout:180];(") && q.ends_with(");out geom;"), "{q}");
        assert_eq!(q.matches("way[\"highway\"").count(), 1, "streets and walkways are one clause: {q}");
        assert!(q.contains("|footway|") || q.contains("(footway|") || q.contains("|footway)"), "{q}");
        assert!(!query_all(&[OsmLayer::Trees], [57.69, 11.96, 57.71, 11.98]).contains("highway"));
        let (a, b, c, d) = (node(57.7000, 11.9700), node(57.7000, 11.9702), node(57.7002, 11.9702), node(57.7002, 11.9700));
        let answer = json!({ "elements": [
            { "type": "way", "id": 1, "tags": { "building": "yes" }, "geometry": [a, b, c, d, a] },
            { "type": "node", "id": 2, "lat": 57.7, "lon": 11.97, "tags": { "natural": "tree" } },
            // A residential street is both a street and a walkway; a closed footway round a square is not a building.
            { "type": "way", "id": 3, "tags": { "highway": "residential" }, "geometry": [a, b] },
            { "type": "way", "id": 4, "tags": { "highway": "footway" }, "geometry": [a, b, c, d, a] },
            { "type": "way", "id": 5, "tags": { "highway": "primary" }, "geometry": [a, c] },
        ] });
        let ids = |layer| -> Vec<String> {
            to_geojson(layer, &answer, "2026-11-24")["features"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["properties"]["osm_id"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(ids(OsmLayer::Buildings), ["way/1"]);
        assert_eq!(ids(OsmLayer::Trees), ["node/2"]);
        assert_eq!(ids(OsmLayer::Streets), ["way/3", "way/5"]);
        assert_eq!(ids(OsmLayer::Walkways), ["way/3", "way/4"]);
    }

    #[test]
    fn big_tables_are_asked_in_tiles_and_merged() {
        // About 2.2 km by 2.4 km: four tiles that cover the bounds exactly.
        let b = [57.69, 11.96, 57.71, 12.0];
        let t = tiles(b, TILE_M);
        assert_eq!(t.len(), 2 * 2, "{t:?}");
        assert_eq!((t[0][0], t[0][1], t[3][2], t[3][3]), (57.69, 11.96, 57.71, 12.0));
        assert_eq!(tiles([57.70, 11.97, 57.701, 11.971], TILE_M).len(), 1);
        let mut m = Merge::default();
        m.add(json!({ "elements": [{ "type": "way", "id": 1 }, { "type": "node", "id": 1 }] }));
        m.add(json!({ "elements": [{ "type": "way", "id": 1 }, { "type": "way", "id": 2 }] }));
        assert_eq!(m.answer()["elements"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn trees_and_streets() {
        let trees = to_geojson(
            OsmLayer::Trees,
            &json!({ "elements": [{ "type": "node", "id": 9, "lat": 57.7, "lon": 11.97, "tags": { "natural": "tree", "height": "11" } }] }),
            "2026-11-15",
        );
        assert_eq!(trees["features"][0]["geometry"], json!({ "type": "Point", "coordinates": [11.97, 57.7] }));
        let streets = to_geojson(
            OsmLayer::Streets,
            &json!({ "elements": [{ "type": "way", "id": 5, "tags": { "highway": "residential", "name": "Gibraltargatan" }, "geometry": [node(57.7, 11.96), node(57.7, 11.98)] }] }),
            "2026-11-15",
        );
        let street = &streets["features"][0];
        assert_eq!(
            (street["properties"]["kind"].as_str(), street["properties"]["highway"].as_str()),
            (Some("street"), Some("residential"))
        );
    }
}
