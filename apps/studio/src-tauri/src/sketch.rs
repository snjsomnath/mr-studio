//! A drawing of a table from its own streets and buildings, for Home's card when there is no
//! picture from a last visit yet (#709). Every table looks like itself instead of a placeholder.

use std::fmt::Write as _;
use std::path::Path;

use mrs_site::Site;
use serde_json::Value;

/// Files bigger than this are not read for a card.
const MAX_FILE: u64 = 40 * 1024 * 1024;
/// Points drawn at most, so a city of buildings stays a small picture.
const MAX_POINTS: usize = 60_000;

/// The drawing as a `data:image/svg+xml` URL, or `None` when the table has no streets or
/// buildings to draw.
pub fn sketch(dir: &Path) -> Option<String> {
    let site = Site::load(dir).ok()?;
    let grid = site.grid();
    let projection = site.projection();
    let data = site.data();
    let (w, h) = (grid.width as f64, grid.height as f64);
    let mut points = 0usize;
    let mut draw = |key: &str, closed: bool| -> String {
        let mut path = String::new();
        let Some(file) = data.get(key).and_then(|rel| site.resolve(rel)) else { return path };
        if std::fs::metadata(&file).map(|m| m.len() > MAX_FILE).unwrap_or(true) {
            return path;
        }
        let Some(json) = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return path };
        let Some(features) = json.get("features").and_then(Value::as_array) else { return path };
        for feature in features {
            let Some(geometry) = feature.get("geometry") else { continue };
            for line in lines(geometry, closed) {
                if points >= MAX_POINTS {
                    return path;
                }
                for (i, c) in line.iter().enumerate() {
                    let (Some(lon), Some(lat)) = (c.get(0).and_then(Value::as_f64), c.get(1).and_then(Value::as_f64)) else { continue };
                    let (east, north) = projection.to_local(lon, lat);
                    let (col, row) = grid.local_to_cell(east, north);
                    let _ = write!(path, "{}{:.1} {:.1}", if i == 0 { 'M' } else { 'L' }, col, row);
                    points += 1;
                }
                if closed {
                    path.push('Z');
                }
            }
        }
        path
    };
    let streets = ["roads", "walkways"].map(|k| draw(k, false)).concat();
    let buildings = draw("buildings", true);
    if streets.is_empty() && buildings.is_empty() {
        return None;
    }
    let stroke = (w.max(h) / 300.0).max(0.5);
    let svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w} {h}' preserveAspectRatio='xMidYMid slice'>\
<rect width='{w}' height='{h}' fill='#0d1320'/>\
<path d='{streets}' fill='none' stroke='#3c4d78' stroke-width='{stroke:.1}' stroke-linecap='round' stroke-linejoin='round'/>\
<path d='{buildings}' fill='#c9d3e6' fill-opacity='0.85' stroke='none'/></svg>"
    );
    use base64::Engine as _;
    Some(format!("data:image/svg+xml;base64,{}", base64::engine::general_purpose::STANDARD.encode(svg)))
}

fn arr(v: Option<&Value>) -> Option<&Vec<Value>> {
    v.and_then(Value::as_array)
}

/// The lines of a geometry to draw: outer rings of polygons, every part of a line.
fn lines(geometry: &Value, closed: bool) -> Vec<&Vec<Value>> {
    let coords = geometry.get("coordinates");
    let kind = geometry.get("type").and_then(Value::as_str).unwrap_or("");
    match (kind, closed) {
        ("Polygon", true) => arr(coords).and_then(|rings| arr(rings.first())).into_iter().collect(),
        ("MultiPolygon", true) => arr(coords).map(|ps| ps.iter().filter_map(|p| arr(p.get(0))).collect()).unwrap_or_default(),
        ("LineString", false) => arr(coords).into_iter().collect(),
        ("MultiLineString", false) => arr(coords).map(|ls| ls.iter().filter_map(|l| l.as_array()).collect()).unwrap_or_default(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sample_table_is_drawn_from_its_streets_and_buildings() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../sites/sample");
        let url = sketch(&sample).expect("the sample has streets and buildings");
        assert!(url.starts_with("data:image/svg+xml;base64,"));
        use base64::Engine as _;
        let svg = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(&url[26..]).unwrap()).unwrap();
        assert!(svg.contains("Z") && svg.contains("stroke='#3c4d78'"), "{}", &svg[..200.min(svg.len())]);
    }

    #[test]
    fn a_table_without_streets_or_buildings_has_no_drawing() {
        let dir = std::env::temp_dir().join(format!("mrs-sketch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("site.json"), "{}").unwrap();
        assert_eq!(sketch(&dir), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
