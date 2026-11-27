//! What covers the ground and the soil under it (#624, #625), for stormwater: read from the
//! site's own data (OpenStreetMap roads and land use, Nationella marktäckedata, SGU's soil map, a
//! field walk's marks) into the scene's `surface` and `soil` grids. No new data: only what the
//! table already has, read the way the stormwater kernel needs it.
//!
//! Finer data wins: every source's rasters are laid first, then polygons, then lines (a road
//! through a park is asphalt), then points (a drain in the road is a drain).

use mrs_engine::{SceneData, Soil, Surface};
use serde_json::{Map, Value};

use crate::bake::{features, polygon_cells, polygons, to_cells};
use crate::geotiff::GeoRaster;
use crate::{Crs, Site, SiteError, SurfaceClasses, SurfaceSource};

/// The datasets read when `scene.surfaces` is left out.
pub const DEFAULT_DATASETS: [&str; 3] = ["roads", "streets", "walkways"];

/// What was read, for the bake's stats.
#[derive(Debug, Default)]
pub struct Painted {
    pub surface_cells: usize,
    pub soil_cells: usize,
}

/// The sources a site reads: its own list, or its roads, streets and walkways datasets.
pub fn sources(site: &Site) -> Vec<SurfaceSource> {
    if let Some(list) = &site.manifest.scene.surfaces {
        return list.clone();
    }
    let data = site.data();
    let mut seen: Vec<&String> = Vec::new();
    let mut out = Vec::new();
    for name in DEFAULT_DATASETS {
        if let Some(path) = data.get(name) {
            if seen.contains(&path) || SurfaceSource::is_geotiff(path) {
                continue;
            }
            seen.push(path);
            out.push(SurfaceSource {
                data: Some(name.to_string()),
                path: None,
                classes: SurfaceClasses::Osm,
                property: None,
                size_m: None,
                crs: None,
            });
        }
    }
    out
}

/// The site-relative path of a source.
pub fn path_of(site: &Site, source: &SurfaceSource) -> Option<String> {
    match (&source.data, &source.path) {
        (Some(name), None) => site.data().get(name).cloned(),
        (None, Some(path)) => Some(path.clone()),
        _ => None,
    }
}

/// Problems with `scene.surfaces`, for `Site::validate`.
pub fn check(site: &Site, out: &mut Vec<String>) {
    let Some(list) = &site.manifest.scene.surfaces else { return };
    for (i, source) in list.iter().enumerate() {
        let label = format!("scene.surfaces[{i}]");
        let path = match (&source.data, &source.path) {
            (Some(_), Some(_)) | (None, None) => {
                out.push(format!("{label}: give either data (a dataset's name) or path"));
                continue;
            }
            (Some(name), None) => match site.data().get(name) {
                Some(path) => path.clone(),
                None => {
                    out.push(format!("{label}.data: the site has no dataset '{name}'"));
                    continue;
                }
            },
            (None, Some(path)) => path.clone(),
        };
        match site.resolve(&path) {
            None => out.push(format!("{label}: '{path}' must be a relative path inside the site folder")),
            Some(full) if !full.exists() => out.push(format!("{label}: '{path}' does not exist")),
            _ => {}
        }
        let raster = SurfaceSource::is_geotiff(&path);
        if source.classes == SurfaceClasses::Nmd && !raster {
            out.push(format!("{label}: nmd classes come in a GeoTIFF of NMD codes"));
        }
        if raster && source.classes != SurfaceClasses::Nmd {
            out.push(format!("{label}: a GeoTIFF is read as nmd classes; set \"classes\": \"nmd\""));
        }
        if let Some(crs) = source.crs.as_deref().filter(|crs| Crs::parse(crs).is_none()) {
            out.push(format!("{label}.crs: '{crs}' is not supported; use one of {}", Crs::SUPPORTED));
        }
        if source.size_m.is_some_and(|s| !(s > 0.0 && s <= 100.0)) {
            out.push(format!("{label}.size_m must be above 0 and at most 100"));
        }
    }
}

/// Lays every source onto the scene's `surface` and `soil` grids.
pub fn paint(site: &Site, scene: &mut SceneData) -> Result<Painted, SiteError> {
    let grid = scene.grid;
    let projection = site.projection();
    let (width, rows) = (grid.width as usize, grid.height as usize);
    let list = sources(site);
    // Read every vector source once.
    let mut read: Vec<(&SurfaceSource, Vec<Value>)> = Vec::new();
    for source in &list {
        let Some(path) = path_of(site, source) else { continue };
        let full = site.resolve(&path).expect("validated");
        if SurfaceSource::is_geotiff(&path) {
            // 1. Rasters.
            let crs = source.crs.as_deref().and_then(Crs::parse);
            let raster = GeoRaster::read(&full, crs).map_err(|message| SiteError::Parse { path: full.clone(), message })?;
            for (i, out) in scene.surface.iter_mut().enumerate() {
                let (east, north) = grid.cell_to_local((i % width) as f64 + 0.5, (i / width) as f64 + 0.5);
                let p = projection.to_lonlat(east, north);
                if let Some(surface) = raster.nearest(p.lon, p.lat).and_then(|v| nmd(v.round() as i64)) {
                    *out = surface as u8;
                }
            }
        } else {
            read.push((source, features(&full)?));
        }
    }
    let cell_m = f64::from(grid.cell_m);
    // 2. Polygons, 3. lines, 4. points.
    for pass in 0..3 {
        for (source, features) in &read {
            for feature in features {
                let properties = feature["properties"].as_object().cloned().unwrap_or_default();
                let class = classify(source, &properties);
                let Some(class) = class else { continue };
                let geometry = &feature["geometry"];
                let mut cells: Vec<usize> = Vec::new();
                match pass {
                    0 => {
                        for polygon in polygons(geometry) {
                            let rings: Vec<Vec<(f64, f64)>> = polygon.iter().map(|ring| to_cells(ring, &projection, grid)).collect();
                            cells.extend(polygon_cells(&rings, width, rows));
                        }
                    }
                    1 => {
                        let half = match class {
                            Class::Surface(_) => line_width(&properties) / 2.0,
                            Class::Soil(_) => 0.0,
                        };
                        for line in lines(geometry) {
                            let points = to_cells(&Value::Array(line.clone()), &projection, grid);
                            stroke(&points, (half / cell_m).max(0.5), width, rows, &mut cells);
                        }
                    }
                    _ => {
                        let size = source.size_m.unwrap_or(match class {
                            Class::Surface(Surface::Drain) => 1.0,
                            Class::Surface(Surface::RainGarden) => 4.0,
                            _ => 3.0,
                        });
                        for point in points(geometry) {
                            let at = to_cells(&Value::Array(vec![Value::Array(point.clone())]), &projection, grid);
                            if let Some(&(col, row)) = at.first() {
                                disc(col, row, (size / 2.0 / cell_m).max(0.5), width, rows, &mut cells);
                            }
                        }
                    }
                }
                for i in cells {
                    match class {
                        Class::Surface(s) => scene.surface[i] = s as u8,
                        Class::Soil(s) => scene.soil[i] = s as u8,
                    }
                }
            }
        }
    }
    Ok(Painted {
        surface_cells: scene.surface.iter().filter(|s| **s != 0).count(),
        soil_cells: scene.soil.iter().filter(|s| **s != 0).count(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Class {
    Surface(Surface),
    Soil(Soil),
}

fn classify(source: &SurfaceSource, properties: &Map<String, Value>) -> Option<Class> {
    match source.classes {
        SurfaceClasses::Osm => osm(properties).map(Class::Surface),
        SurfaceClasses::Nmd => None,
        SurfaceClasses::Kind => {
            let key = source.property.as_deref().unwrap_or("kind");
            text(properties, key).and_then(|v| kind(&v)).map(Class::Surface)
        }
        SurfaceClasses::Soil => {
            let named = source.property.as_deref().and_then(|key| text(properties, key)).and_then(|v| soil(&v));
            named
                .or_else(|| text(properties, "jg2_tx").and_then(|v| soil(&v)))
                .or_else(|| properties.values().filter_map(Value::as_str).find_map(soil))
                .map(Class::Soil)
        }
    }
}

/// A property's text, whatever case its key is written in.
fn text(properties: &Map<String, Value>, key: &str) -> Option<String> {
    properties.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).and_then(|(_, v)| v.as_str()).map(|v| v.trim().to_lowercase())
}

/// An OpenStreetMap feature's surface, from its tags.
pub fn osm(tags: &Map<String, Value>) -> Option<Surface> {
    let tag = |key: &str| text(tags, key);
    if let Some(surface) = tag("surface").and_then(|v| osm_surface(&v)) {
        return Some(surface);
    }
    if tag("manhole").as_deref() == Some("drain") || tag("man_made").as_deref() == Some("storm_drain") {
        return Some(Surface::Drain);
    }
    if let Some(v) = tag("landuse") {
        match v.as_str() {
            "grass" | "meadow" | "village_green" | "recreation_ground" | "cemetery" | "farmland" | "allotments" | "orchard" => {
                return Some(Surface::Grass)
            }
            "forest" => return Some(Surface::Woodland),
            "construction" | "brownfield" | "landfill" => return Some(Surface::Bare),
            "residential" | "commercial" | "retail" | "industrial" | "railway" | "garages" => {}
            _ => {}
        }
    }
    if let Some(v) = tag("leisure") {
        match v.as_str() {
            "park" | "garden" | "pitch" | "playground" | "golf_course" | "dog_park" => return Some(Surface::Grass),
            _ => {}
        }
    }
    if let Some(v) = tag("natural") {
        match v.as_str() {
            "wood" | "scrub" | "heath" => return Some(Surface::Woodland),
            "grassland" | "wetland" => return Some(Surface::Grass),
            "bare_rock" | "scree" | "sand" | "beach" => return Some(Surface::Bare),
            _ => {}
        }
    }
    if tag("amenity").as_deref() == Some("parking") || tag("area:highway").is_some() {
        return Some(Surface::Sealed);
    }
    if let Some(v) = tag("highway") {
        return match v.as_str() {
            "construction" | "proposed" | "abandoned" | "corridor" | "elevator" => None,
            "path" | "track" | "bridleway" => Some(Surface::Gravel),
            _ => Some(Surface::Sealed),
        };
    }
    None
}

fn osm_surface(value: &str) -> Option<Surface> {
    Some(match value {
        "asphalt" | "concrete" | "concrete:plates" | "concrete:lanes" | "paved" | "metal" | "tartan" | "artificial_turf" | "acrylic" => {
            Surface::Sealed
        }
        "paving_stones" | "sett" | "cobblestone" | "unhewn_cobblestone" | "bricks" | "brick" | "stone" | "wood" => Surface::Paving,
        "gravel" | "fine_gravel" | "compacted" | "pebblestone" | "unpaved" | "grass_paver" | "woodchips" => Surface::Gravel,
        "grass" => Surface::Grass,
        "dirt" | "earth" | "ground" | "mud" | "sand" | "rock" => Surface::Bare,
        _ => kind(value)?,
    })
}

/// A surface named in words, as a field walk's kinds or a hand-made dataset name it.
pub fn kind(value: &str) -> Option<Surface> {
    let v = value.trim().to_lowercase().replace(['-', '_'], " ");
    let has = |words: &[&str]| words.iter().any(|w| v.contains(w));
    Some(if has(&["rain garden", "raingarden", "regnbädd", "regnträdgård", "bioretention", "swale", "infiltration"]) {
        Surface::RainGarden
    } else if has(&["drain", "gully", "inlet", "brunn", "dagvatten"]) {
        Surface::Drain
    } else if let Some(surface) = Surface::ALL.into_iter().find(|s| s.name().replace('_', " ") == v) {
        surface
    } else if has(&["asphalt", "asfalt", "concrete", "betong", "sealed", "parking", "parkering"]) {
        Surface::Sealed
    } else if has(&["paving", "plattor", "sten", "cobble", "sett"]) {
        Surface::Paving
    } else if has(&["gravel", "grus"]) {
        Surface::Gravel
    } else if has(&["grass", "gräs", "lawn", "park"]) {
        Surface::Grass
    } else if has(&["wood", "skog", "forest"]) {
        Surface::Woodland
    } else if has(&["bare", "soil", "jord"]) {
        Surface::Bare
    } else {
        return None;
    })
}

/// A soil named in words: SGU's soil map (`jg2_tx`, Swedish) or English.
pub fn soil(value: &str) -> Option<Soil> {
    let v = value.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| v.contains(w));
    // The order matters: "lerig morän" is till, "sandig lera" is clay.
    Some(if has(&["fyllning", "fill", "made ground"]) {
        Soil::Fill
    } else if has(&["torv", "gyttja", "peat", "kärr", "mosse"]) {
        Soil::Peat
    } else if has(&["urberg", "berg", "rock", "hällmark", "bedrock"]) {
        Soil::Rock
    } else if has(&["morän", "moran", "till"]) {
        Soil::Till
    } else if has(&["lera", "clay"]) {
        Soil::Clay
    } else if has(&["silt", "mjäla", "mo"]) && !has(&["morän"]) {
        Soil::Silt
    } else if has(&["grus", "gravel", "stenblock", "blockmark", "boulder"]) {
        Soil::Gravel
    } else if has(&["sand"]) {
        Soil::Sand
    } else {
        return None;
    })
}

/// A class of Naturvårdsverket's Nationella marktäckedata (basskikt) as a surface.
pub fn nmd(code: i64) -> Option<Surface> {
    Some(match code {
        51..=53 => Surface::Sealed,
        41 => Surface::Bare,
        42 | 3 | 2 => Surface::Grass,
        111..=128 => Surface::Woodland,
        _ => return None,
    })
}

/// How wide a road or path is, metres: its `width` tag, else by its class.
fn line_width(tags: &Map<String, Value>) -> f64 {
    if let Some(width) = tags.iter().find(|(k, _)| k.eq_ignore_ascii_case("width")).and_then(|(_, v)| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('m').trim().parse().ok(),
        _ => None,
    }) {
        if width > 0.0 && width < 60.0 {
            return width;
        }
    }
    match text(tags, "highway").as_deref() {
        Some("motorway" | "trunk") => 14.0,
        Some("primary") => 12.0,
        Some("secondary") => 10.0,
        Some("tertiary" | "busway") => 8.0,
        Some("residential" | "unclassified" | "living_street" | "road") => 6.0,
        Some("service" | "pedestrian") => 4.0,
        Some("track") => 3.0,
        _ => 2.5,
    }
}

fn lines(geometry: &Value) -> Vec<&Vec<Value>> {
    let coordinates = geometry["coordinates"].as_array();
    match (geometry["type"].as_str(), coordinates) {
        (Some("LineString"), Some(line)) => vec![line],
        (Some("MultiLineString"), Some(lines)) => lines.iter().filter_map(Value::as_array).collect(),
        _ => Vec::new(),
    }
}

fn points(geometry: &Value) -> Vec<&Vec<Value>> {
    let coordinates = geometry["coordinates"].as_array();
    match (geometry["type"].as_str(), coordinates) {
        (Some("Point"), Some(point)) => vec![point],
        (Some("MultiPoint"), Some(points)) => points.iter().filter_map(Value::as_array).collect(),
        _ => Vec::new(),
    }
}

/// The cells within `radius` cells of a polyline given in cell coordinates.
fn stroke(points: &[(f64, f64)], radius: f64, width: usize, rows: usize, out: &mut Vec<usize>) {
    for pair in points.windows(2) {
        let ((ax, ay), (bx, by)) = (pair[0], pair[1]);
        let (x0, x1) = ((ax.min(bx) - radius).floor().max(0.0) as usize, ((ax.max(bx) + radius).ceil().max(0.0) as usize).min(width));
        let (y0, y1) = ((ay.min(by) - radius).floor().max(0.0) as usize, ((ay.max(by) + radius).ceil().max(0.0) as usize).min(rows));
        let (dx, dy) = (bx - ax, by - ay);
        let length2 = (dx * dx + dy * dy).max(1e-12);
        for y in y0..y1 {
            for x in x0..x1 {
                let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                let t = (((px - ax) * dx + (py - ay) * dy) / length2).clamp(0.0, 1.0);
                let (ex, ey) = (ax + t * dx - px, ay + t * dy - py);
                if ex * ex + ey * ey <= radius * radius {
                    out.push(y * width + x);
                }
            }
        }
    }
}

/// The cells within `radius` of a point, and always the cell it falls in.
fn disc(col: f64, row: f64, radius: f64, width: usize, rows: usize, out: &mut Vec<usize>) {
    if col >= 0.0 && row >= 0.0 && (col as usize) < width && (row as usize) < rows {
        out.push(row as usize * width + col as usize);
    }
    let (x0, x1) = ((col - radius).floor().max(0.0) as usize, ((col + radius).ceil().max(0.0) as usize).min(width));
    let (y0, y1) = ((row - radius).floor().max(0.0) as usize, ((row + radius).ceil().max(0.0) as usize).min(rows));
    for y in y0..y1 {
        for x in x0..x1 {
            let (dx, dy) = (x as f64 + 0.5 - col, y as f64 + 0.5 - row);
            if dx * dx + dy * dy <= radius * radius {
                out.push(y * width + x);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tags(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn reads_openstreetmap_tags() {
        assert_eq!(osm(&tags(json!({ "highway": "residential" }))), Some(Surface::Sealed));
        assert_eq!(osm(&tags(json!({ "highway": "footway", "surface": "paving_stones" }))), Some(Surface::Paving));
        assert_eq!(osm(&tags(json!({ "highway": "path" }))), Some(Surface::Gravel));
        assert_eq!(osm(&tags(json!({ "highway": "construction" }))), None);
        assert_eq!(osm(&tags(json!({ "leisure": "park" }))), Some(Surface::Grass));
        assert_eq!(osm(&tags(json!({ "amenity": "parking" }))), Some(Surface::Sealed));
        assert_eq!(osm(&tags(json!({ "natural": "wood" }))), Some(Surface::Woodland));
        assert_eq!(osm(&tags(json!({ "man_made": "manhole", "manhole": "drain" }))), Some(Surface::Drain));
        assert_eq!(osm(&tags(json!({ "name": "Gibraltargatan" }))), None);
    }

    #[test]
    fn reads_field_walk_kinds_and_soil_names() {
        assert_eq!(kind("Rain garden"), Some(Surface::RainGarden));
        assert_eq!(kind("rain_garden"), Some(Surface::RainGarden));
        assert_eq!(kind("Drain"), Some(Surface::Drain));
        assert_eq!(kind("Dagvattenbrunn"), Some(Surface::Drain));
        assert_eq!(kind("Bench"), None);
        assert_eq!(soil("Glacial lera"), Some(Soil::Clay));
        assert_eq!(soil("Sandig morän"), Some(Soil::Till));
        assert_eq!(soil("Postglacial sand"), Some(Soil::Sand));
        assert_eq!(soil("Urberg"), Some(Soil::Rock));
        assert_eq!(soil("Fyllning"), Some(Soil::Fill));
        assert_eq!(soil("Kärrtorv"), Some(Soil::Peat));
        assert_eq!(soil("Isälvssediment, grus"), Some(Soil::Gravel));
        assert_eq!(soil("clay"), Some(Soil::Clay));
        assert_eq!(soil("Vatten"), None);
        assert_eq!(nmd(53), Some(Surface::Sealed));
        assert_eq!(nmd(42), Some(Surface::Grass));
        assert_eq!(nmd(115), Some(Surface::Woodland));
        assert_eq!(nmd(61), None);
    }

    #[test]
    fn strokes_and_discs_cover_the_right_cells() {
        let mut cells = Vec::new();
        stroke(&[(0.0, 5.0), (10.0, 5.0)], 1.0, 10, 10, &mut cells);
        cells.sort();
        cells.dedup();
        assert_eq!(cells.len(), 20, "a 2-cell-wide road across 10 columns");
        let mut cells = Vec::new();
        disc(5.2, 5.2, 0.5, 10, 10, &mut cells);
        cells.dedup();
        assert_eq!(cells, vec![55], "a drain smaller than a cell is the cell it falls in");
        let mut cells = Vec::new();
        disc(5.0, 5.0, 2.0, 10, 10, &mut cells);
        cells.sort();
        cells.dedup();
        assert_eq!(cells.len(), 12, "a 4 m rain garden on 1 m cells");
    }
}
