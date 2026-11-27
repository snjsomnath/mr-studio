//! Checking what phones draw with their tools: points, lines and areas.

use super::*;

/// The most positions one tool input may carry.
pub(super) const MAX_VERTICES: usize = 256;

/// One `[lon, lat]` position. Anything after the first two numbers is dropped.
pub(super) fn clean_position(value: &Value) -> Result<Value, String> {
    let pair = value.as_array().filter(|a| a.len() >= 2).ok_or("a position must be [lon, lat]")?;
    let lon = pair[0].as_f64().filter(|v| (-180.0..=180.0).contains(v)).ok_or("longitude must be between -180 and 180")?;
    let lat = pair[1].as_f64().filter(|v| (-90.0..=90.0).contains(v)).ok_or("latitude must be between -90 and 90")?;
    Ok(json!([lon, lat]))
}

pub(super) fn clean_path(value: &Value, least: usize, budget: &mut usize) -> Result<Vec<Value>, String> {
    let positions = value.as_array().ok_or("coordinates must be a list of positions")?;
    if positions.len() < least {
        return Err(format!("needs at least {least} positions"));
    }
    *budget = budget.checked_sub(positions.len()).ok_or(format!("more than {MAX_VERTICES} positions"))?;
    positions.iter().map(clean_position).collect()
}

/// Checks a tool's geometry against its kind and returns it as plain GeoJSON in WGS84:
/// `Point`, `LineString` or `Polygon` with closed rings, and nothing else attached.
pub(super) fn clean_geometry(kind: ToolKind, geometry: &Value) -> Result<Value, String> {
    let name = match kind {
        ToolKind::Point => "Point",
        ToolKind::Line => "LineString",
        ToolKind::Polygon => "Polygon",
    };
    if geometry["type"] != name {
        return Err(format!("geometry must be a GeoJSON {name}"));
    }
    let coordinates = &geometry["coordinates"];
    let mut budget = MAX_VERTICES;
    let cleaned = match kind {
        ToolKind::Point => clean_position(coordinates)?,
        ToolKind::Line => Value::Array(clean_path(coordinates, 2, &mut budget)?),
        ToolKind::Polygon => {
            let rings = coordinates.as_array().filter(|r| !r.is_empty()).ok_or("a polygon needs a ring")?;
            let mut out = Vec::new();
            for ring in rings {
                let ring = clean_path(ring, 4, &mut budget)?;
                if ring.first() != ring.last() {
                    return Err("a polygon ring must end where it starts".into());
                }
                out.push(Value::Array(ring));
            }
            Value::Array(out)
        }
    };
    Ok(json!({ "type": name, "coordinates": cleaned }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_geometry_is_checked_against_the_tool() {
        let point = json!({ "type": "Point", "coordinates": [11.97, 57.7, 12.0], "crs": "x" });
        assert_eq!(clean_geometry(ToolKind::Point, &point).unwrap(), json!({ "type": "Point", "coordinates": [11.97, 57.7] }));
        assert!(clean_geometry(ToolKind::Line, &point).is_err());
        assert!(clean_geometry(ToolKind::Point, &json!({ "type": "Point", "coordinates": [181, 0] })).is_err());
        assert!(clean_geometry(ToolKind::Point, &json!({ "type": "Point", "coordinates": ["a", 0] })).is_err());
        assert!(clean_geometry(ToolKind::Point, &json!({ "type": "Point", "coordinates": [1] })).is_err());

        let line =
            |n: usize| json!({ "type": "LineString", "coordinates": (0..n).map(|i| json!([i as f64 * 1e-4, 0])).collect::<Vec<_>>() });
        assert!(clean_geometry(ToolKind::Line, &line(1)).is_err());
        assert!(clean_geometry(ToolKind::Line, &line(2)).is_ok());
        assert!(clean_geometry(ToolKind::Line, &line(MAX_VERTICES)).is_ok());
        assert!(clean_geometry(ToolKind::Line, &line(MAX_VERTICES + 1)).is_err());

        let ring = json!([[0, 0], [1, 0], [1, 1], [0, 0]]);
        assert!(clean_geometry(ToolKind::Polygon, &json!({ "type": "Polygon", "coordinates": [ring] })).is_ok());
        let open = json!({ "type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1]]] });
        assert!(clean_geometry(ToolKind::Polygon, &open).is_err());
        assert!(clean_geometry(ToolKind::Polygon, &json!({ "type": "Polygon", "coordinates": [] })).is_err());
    }
}
