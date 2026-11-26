//! GIS files as agencies hand them out (#600): zipped shapefiles and GeoPackages.
//!
//! SGU, Lantmäteriet, SLU GET and most municipalities deliver vector data as a zip of shapefiles
//! (`.shp` with its `.dbf` columns, `.prj` coordinate system and `.cpg` text encoding) or as a
//! GeoPackage (an SQLite database of tables with a geometry column). Both are read here into
//! GeoJSON features in the file's own coordinates, one [`Layer`] per shapefile or table, so the
//! import can go on exactly as for a GeoJSON file.

use std::collections::BTreeMap;
use std::io::Read;

use serde_json::{json, Map, Value};

/// What kind of GIS file the bytes are, from their first bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Zip,
    GeoPackage,
}

/// Recognises a zip archive or an SQLite database (a GeoPackage).
pub fn sniff(bytes: &[u8]) -> Option<Kind> {
    if bytes.starts_with(b"PK\x03\x04") {
        Some(Kind::Zip)
    } else if bytes.starts_with(b"SQLite format 3\0") {
        Some(Kind::GeoPackage)
    } else {
        None
    }
}

/// One layer of a GIS file: a shapefile or a GeoPackage table.
#[derive(Debug, Clone)]
pub struct Layer {
    /// The shapefile's name without `.shp`, or `file.gpkg : table` for a GeoPackage.
    pub name: String,
    /// GeoJSON features in the layer's own coordinates.
    pub features: Vec<Value>,
    /// `EPSG:3006` when the file names a system MR Studio recognises.
    pub crs: Option<String>,
    /// A GeoTIFF in the zip (#601): its bytes, kept whole as a raster of values.
    pub raster: Option<Vec<u8>>,
}

/// Reads every layer in a zip archive or a GeoPackage. Layers come in file order.
pub fn read(bytes: &[u8]) -> Result<Vec<Layer>, String> {
    match sniff(bytes) {
        Some(Kind::Zip) => read_zip(bytes),
        Some(Kind::GeoPackage) => read_geopackage(bytes, ""),
        None => Err("not a zip archive or a GeoPackage".into()),
    }
}

// ---- Zip archives --------------------------------------------------------------------

#[derive(Default)]
struct Parts {
    shp: Option<Vec<u8>>,
    dbf: Option<Vec<u8>>,
    prj: Option<String>,
    cpg: Option<String>,
}

fn read_zip(bytes: &[u8]) -> Result<Vec<Layer>, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("the zip archive can't be opened: {e}"))?;
    let mut shapefiles: BTreeMap<String, Parts> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut layers = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("the zip archive is damaged: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().map_err(|e| format!("the zip archive is damaged: {e}"))?.replace('\\', "/");
        // macOS adds `__MACOSX/._name` shadows of every file.
        if name.split('/').any(|part| part.starts_with("__MACOSX") || part.starts_with("._")) {
            continue;
        }
        let Some((stem, extension)) = name.rsplit_once('.') else { continue };
        let extension = extension.to_ascii_lowercase();
        if !matches!(extension.as_str(), "shp" | "dbf" | "prj" | "cpg" | "gpkg" | "tif" | "tiff") {
            continue;
        }
        // Over 1 GB is not a table's dataset.
        if entry.size() > 1 << 30 {
            return Err(format!("{name} is too large to read"));
        }
        let mut content = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut content).map_err(|e| format!("{name} can't be read from the zip: {e}"))?;
        if extension == "tif" || extension == "tiff" {
            let file = name.rsplit('/').next().unwrap_or(&name).to_string();
            layers.push(Layer { name: file, features: Vec::new(), crs: None, raster: Some(content) });
            continue;
        }
        if extension == "gpkg" {
            let file = name.rsplit('/').next().unwrap_or(&name).to_string();
            layers.extend(read_geopackage(&content, &file)?);
            continue;
        }
        let key = stem.to_string();
        if !shapefiles.contains_key(&key) {
            order.push(key.clone());
        }
        let parts = shapefiles.entry(key).or_default();
        match extension.as_str() {
            "shp" => parts.shp = Some(content),
            "dbf" => parts.dbf = Some(content),
            "prj" => parts.prj = Some(String::from_utf8_lossy(&content).into_owned()),
            _ => parts.cpg = Some(String::from_utf8_lossy(&content).trim().to_string()),
        }
    }
    for key in order {
        let parts = shapefiles.remove(&key).expect("listed");
        let Some(shp) = parts.shp else { continue };
        let name = key.rsplit('/').next().unwrap_or(&key).to_string();
        let geometries = read_shp(&shp).map_err(|e| format!("{name}.shp: {e}"))?;
        let rows = match &parts.dbf {
            Some(dbf) => read_dbf(dbf, parts.cpg.as_deref()).map_err(|e| format!("{name}.dbf: {e}"))?,
            None => Vec::new(),
        };
        let features = geometries
            .into_iter()
            .enumerate()
            .filter_map(|(i, geometry)| {
                let geometry = geometry?;
                let properties = rows.get(i).cloned().unwrap_or_default();
                Some(json!({ "type": "Feature", "properties": properties, "geometry": geometry }))
            })
            .collect();
        layers.push(Layer { name, features, crs: parts.prj.as_deref().and_then(crs_of_prj), raster: None });
    }
    if layers.is_empty() {
        return Err("the zip archive holds no shapefile (.shp), GeoPackage (.gpkg) or GeoTIFF".into());
    }
    Ok(layers)
}

/// The EPSG code a `.prj` (ESRI WKT) names, for the systems MR Studio converts.
pub fn crs_of_prj(prj: &str) -> Option<String> {
    let text = prj.trim();
    // The system's own AUTHORITY is the last one in the WKT.
    if let Some(at) = text.rfind("AUTHORITY[") {
        let digits: String = text[at..].split(',').nth(1).unwrap_or("").chars().filter(char::is_ascii_digit).collect();
        if let Ok(code) = digits.parse::<u32>() {
            let geographic_only = !text.starts_with("PROJCS") && !text.starts_with("PROJCRS");
            if !geographic_only || code == 4326 {
                return Some(format!("EPSG:{code}"));
            }
        }
    }
    let upper = text.to_ascii_uppercase().replace(' ', "_");
    if upper.contains("SWEREF99_TM") {
        return Some("EPSG:3006".into());
    }
    const LOCAL: [(&str, u32); 12] = [
        ("12_00", 3007),
        ("13_30", 3008),
        ("15_00", 3009),
        ("16_30", 3010),
        ("18_00", 3011),
        ("14_15", 3012),
        ("15_45", 3013),
        ("17_15", 3014),
        ("18_45", 3015),
        ("20_15", 3016),
        ("21_45", 3017),
        ("23_15", 3018),
    ];
    if upper.contains("SWEREF99_") {
        if let Some((_, code)) = LOCAL.iter().find(|(zone, _)| upper.contains(&format!("SWEREF99_{zone}"))) {
            return Some(format!("EPSG:{code}"));
        }
    }
    if let Some(at) = upper.find("UTM_ZONE_") {
        let zone: String = upper[at + 9..].chars().take_while(char::is_ascii_digit).collect();
        if let Ok(zone) = zone.parse::<u32>() {
            let north = upper[at + 9..].chars().find(|c| c.is_ascii_alphabetic()).is_none_or(|c| c == 'N');
            if north && upper.contains("ETRS") {
                return Some(format!("EPSG:{}", 25800 + zone));
            }
            if north {
                return Some(format!("EPSG:{}", 32600 + zone));
            }
        }
    }
    if (upper.starts_with("GEOGCS") || upper.starts_with("GEOGCRS")) && (upper.contains("WGS_1984") || upper.contains("WGS_84")) {
        return Some("EPSG:4326".into());
    }
    None
}

// ---- Shapefiles ----------------------------------------------------------------------

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).filter(|&e| e <= self.bytes.len()).ok_or("the file ends too early")?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }
    fn i32_le(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().expect("4")))
    }
    fn f64_le(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().expect("8")))
    }
    fn count(&mut self) -> Result<usize, String> {
        let n = self.i32_le()?;
        usize::try_from(n).ok().filter(|&n| n <= self.bytes.len()).ok_or_else(|| "a count in the file is wrong".to_string())
    }
}

/// The geometries of a `.shp`, one per record (None for a null shape), as GeoJSON.
fn read_shp(bytes: &[u8]) -> Result<Vec<Option<Value>>, String> {
    if bytes.len() < 100 || i32::from_be_bytes(bytes[0..4].try_into().expect("4")) != 9994 {
        return Err("not a shapefile".into());
    }
    let mut out = Vec::new();
    let mut at = 100;
    while at + 8 <= bytes.len() {
        let length = i32::from_be_bytes(bytes[at + 4..at + 8].try_into().expect("4"));
        let length = usize::try_from(length).map_err(|_| "a record length is wrong")? * 2;
        let start = at + 8;
        let end = start.checked_add(length).filter(|&e| e <= bytes.len()).ok_or("a record runs past the end of the file")?;
        out.push(shape(&bytes[start..end])?);
        at = end;
    }
    Ok(out)
}

fn shape(record: &[u8]) -> Result<Option<Value>, String> {
    let mut c = Cursor { bytes: record, at: 0 };
    let kind = c.i32_le()?;
    let point = |c: &mut Cursor| -> Result<Value, String> { Ok(json!([c.f64_le()?, c.f64_le()?])) };
    match kind {
        0 => Ok(None),
        1 | 11 | 21 => Ok(Some(json!({ "type": "Point", "coordinates": point(&mut c)? }))),
        8 | 18 | 28 => {
            c.take(32)?;
            let n = c.count()?;
            let points = (0..n).map(|_| point(&mut c)).collect::<Result<Vec<_>, _>>()?;
            Ok(Some(match points.len() {
                0 => return Ok(None),
                1 => json!({ "type": "Point", "coordinates": points[0] }),
                _ => json!({ "type": "MultiPoint", "coordinates": points }),
            }))
        }
        3 | 13 | 23 | 5 | 15 | 25 => {
            c.take(32)?;
            let parts = c.count()?;
            let total = c.count()?;
            let starts = (0..parts).map(|_| c.count()).collect::<Result<Vec<_>, _>>()?;
            let points: Vec<(f64, f64)> = (0..total).map(|_| Ok((c.f64_le()?, c.f64_le()?))).collect::<Result<_, String>>()?;
            let mut rings = Vec::new();
            for (i, &from) in starts.iter().enumerate() {
                let to = starts.get(i + 1).copied().unwrap_or(total).min(total);
                if from < to {
                    rings.push(points[from..to].to_vec());
                }
            }
            if rings.is_empty() {
                return Ok(None);
            }
            if matches!(kind, 3 | 13 | 23) {
                let lines: Vec<Value> = rings.iter().map(|r| positions(r)).collect();
                return Ok(Some(if lines.len() == 1 {
                    json!({ "type": "LineString", "coordinates": lines[0] })
                } else {
                    json!({ "type": "MultiLineString", "coordinates": lines })
                }));
            }
            Ok(Some(polygons(rings)))
        }
        other => Err(format!("shape type {other} (multipatch or unknown) can't be read")),
    }
}

fn positions(ring: &[(f64, f64)]) -> Value {
    Value::Array(ring.iter().map(|&(x, y)| json!([x, y])).collect())
}

/// Twice the signed area: negative for a clockwise ring (y up).
fn signed_area(ring: &[(f64, f64)]) -> f64 {
    ring.windows(2).map(|w| w[0].0 * w[1].1 - w[1].0 * w[0].1).sum()
}

fn contains(ring: &[(f64, f64)], (x, y): (f64, f64)) -> bool {
    let mut inside = false;
    for w in ring.windows(2) {
        let ((x1, y1), (x2, y2)) = (w[0], w[1]);
        if (y1 > y) != (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1 {
            inside = !inside;
        }
    }
    inside
}

/// Shapefile rings to a GeoJSON Polygon or MultiPolygon: clockwise rings are outer rings,
/// counter-clockwise ones holes in the outer ring that holds them. Written the GeoJSON way
/// round (RFC 7946: outer rings counter-clockwise).
fn polygons(rings: Vec<Vec<(f64, f64)>>) -> Value {
    let mut shells: Vec<(Vec<(f64, f64)>, Vec<Vec<(f64, f64)>>)> = Vec::new();
    let mut holes = Vec::new();
    for ring in rings {
        if signed_area(&ring) <= 0.0 {
            shells.push((ring, Vec::new()));
        } else {
            holes.push(ring);
        }
    }
    if shells.is_empty() {
        // Wound the other way round throughout: take them all as outer rings.
        shells = holes.drain(..).map(|r| (r, Vec::new())).collect();
    }
    for hole in holes {
        let first = hole[0];
        let index = shells.iter().position(|(shell, _)| contains(shell, first)).unwrap_or(shells.len() - 1);
        shells[index].1.push(hole);
    }
    let polygon = |(mut shell, holes): (Vec<(f64, f64)>, Vec<Vec<(f64, f64)>>)| {
        shell.reverse();
        let mut rings = vec![positions(&shell)];
        rings.extend(holes.into_iter().map(|mut h| {
            h.reverse();
            positions(&h)
        }));
        Value::Array(rings)
    };
    let mut all: Vec<Value> = shells.into_iter().map(polygon).collect();
    if all.len() == 1 {
        json!({ "type": "Polygon", "coordinates": all.remove(0) })
    } else {
        json!({ "type": "MultiPolygon", "coordinates": all })
    }
}

// ---- dBASE columns -------------------------------------------------------------------

/// The rows of a `.dbf`, as GeoJSON properties. Text is UTF-8 when the `.cpg` says so or it
/// reads as UTF-8, else Windows-1252.
fn read_dbf(bytes: &[u8], cpg: Option<&str>) -> Result<Vec<Map<String, Value>>, String> {
    if bytes.len() < 32 {
        return Err("too short to be a dBASE file".into());
    }
    let records = u32::from_le_bytes(bytes[4..8].try_into().expect("4")) as usize;
    let header = u16::from_le_bytes(bytes[8..10].try_into().expect("2")) as usize;
    let size = u16::from_le_bytes(bytes[10..12].try_into().expect("2")) as usize;
    let mut fields = Vec::new();
    let mut at = 32;
    while at + 32 <= bytes.len().min(header) && bytes[at] != 0x0d {
        let raw = &bytes[at..at + 11];
        let name = String::from_utf8_lossy(&raw[..raw.iter().position(|&b| b == 0).unwrap_or(11)]).trim().to_string();
        fields.push((name, bytes[at + 11], bytes[at + 16] as usize));
        at += 32;
    }
    let latin = cpg.is_some_and(|c| {
        let c = c.to_ascii_uppercase();
        !c.contains("UTF") && !c.contains("65001")
    });
    let text = |raw: &[u8]| -> String {
        let raw = raw.split(|&b| b == 0).next().unwrap_or(raw);
        match (latin, std::str::from_utf8(raw)) {
            (false, Ok(s)) => s.trim().to_string(),
            _ => raw.iter().map(|&b| crate::import::windows_1252(b)).collect::<String>().trim().to_string(),
        }
    };
    let mut rows = Vec::with_capacity(records);
    for r in 0..records {
        let start = header + r * size;
        let Some(record) = bytes.get(start..start + size) else { break };
        let mut row = Map::new();
        let mut offset = 1;
        for (name, kind, length) in &fields {
            let Some(raw) = record.get(offset..offset + length) else { break };
            offset += length;
            let value = text(raw);
            let value = match kind {
                b'N' | b'F' => {
                    if value.is_empty() || value.starts_with('*') {
                        Value::Null
                    } else if let Ok(n) = value.parse::<i64>() {
                        json!(n)
                    } else {
                        value.replace(',', ".").parse::<f64>().ok().filter(|f| f.is_finite()).map_or(Value::Null, |f| json!(f))
                    }
                }
                b'L' => match value.chars().next() {
                    Some('T' | 't' | 'Y' | 'y') => json!(true),
                    Some('F' | 'f' | 'N' | 'n') => json!(false),
                    _ => Value::Null,
                },
                _ if value.is_empty() => Value::Null,
                _ => json!(value),
            };
            row.insert(name.clone(), value);
        }
        rows.push(row);
    }
    Ok(rows)
}

// ---- GeoPackages ---------------------------------------------------------------------

fn read_geopackage(bytes: &[u8], file: &str) -> Result<Vec<Layer>, String> {
    // SQLite opens files: a scratch copy in the system's temporary folder.
    let scratch = std::env::temp_dir().join(format!("mrs-gpkg-{}-{:p}.gpkg", std::process::id(), bytes.as_ptr()));
    std::fs::write(&scratch, bytes).map_err(|e| format!("the GeoPackage can't be read: {e}"))?;
    let read = read_geopackage_file(&scratch, file);
    let _ = std::fs::remove_file(&scratch);
    read
}

fn read_geopackage_file(path: &std::path::Path, file: &str) -> Result<Vec<Layer>, String> {
    use rusqlite::{types::ValueRef, Connection, OpenFlags};
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("the GeoPackage can't be opened: {e}"))?;
    let sql = "SELECT g.table_name, g.column_name, s.organization, s.organization_coordsys_id \
               FROM gpkg_geometry_columns g LEFT JOIN gpkg_spatial_ref_sys s ON s.srs_id = g.srs_id \
               LEFT JOIN gpkg_contents c ON c.table_name = g.table_name ORDER BY c.rowid";
    let mut tables = db.prepare(sql).map_err(|_| "this SQLite file is not a GeoPackage (it has no geometry tables)".to_string())?;
    let found: Vec<(String, String, Option<String>, Option<i64>)> = tables
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| format!("the GeoPackage can't be read: {e}"))?
        .filter_map(Result::ok)
        .collect();
    let mut layers = Vec::new();
    for (table, column, organization, code) in found {
        let crs = match (organization.as_deref().map(str::to_ascii_uppercase).as_deref(), code) {
            (Some("EPSG"), Some(code)) if code > 0 => Some(format!("EPSG:{code}")),
            _ => None,
        };
        let quoted = |name: &str| format!("\"{}\"", name.replace('"', "\"\""));
        let mut query = db.prepare(&format!("SELECT * FROM {}", quoted(&table))).map_err(|e| format!("{table}: {e}"))?;
        let names: Vec<String> = query.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = query.query([]).map_err(|e| format!("{table}: {e}"))?;
        let mut features = Vec::new();
        while let Some(row) = rows.next().map_err(|e| format!("{table}: {e}"))? {
            let mut properties = Map::new();
            let mut geometry = None;
            for (i, name) in names.iter().enumerate() {
                let Ok(value) = row.get_ref(i) else { continue };
                if name.eq_ignore_ascii_case(&column) {
                    if let ValueRef::Blob(blob) = value {
                        geometry = gpkg_geometry(blob);
                    }
                    continue;
                }
                let value = match value {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(f) if f.is_finite() => json!(f),
                    ValueRef::Real(_) => Value::Null,
                    ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                    ValueRef::Blob(_) => continue,
                };
                properties.insert(name.clone(), value);
            }
            if let Some(geometry) = geometry {
                features.push(json!({ "type": "Feature", "properties": properties, "geometry": geometry }));
            }
        }
        let name = if file.is_empty() { table.clone() } else { format!("{file} : {table}") };
        layers.push(Layer { name, features, crs, raster: None });
    }
    if layers.is_empty() {
        return Err("the GeoPackage holds no tables of places, lines or areas".into());
    }
    Ok(layers)
}

/// A GeoPackage geometry blob (a small header, then well-known binary) as GeoJSON.
fn gpkg_geometry(blob: &[u8]) -> Option<Value> {
    if blob.len() < 8 || &blob[0..2] != b"GP" {
        return None;
    }
    let flags = blob[3];
    if flags & 0b1_0000 != 0 {
        return None; // empty geometry
    }
    let envelope = match (flags >> 1) & 0b111 {
        0 => 0,
        1 => 32,
        2 | 3 => 48,
        4 => 64,
        _ => return None,
    };
    let mut wkb = Wkb { bytes: blob, at: 8 + envelope };
    wkb.geometry()
}

struct Wkb<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Wkb<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let slice = self.bytes.get(self.at..self.at + N)?;
        self.at += N;
        slice.try_into().ok()
    }
    fn u32(&mut self, little: bool) -> Option<u32> {
        let b = self.take::<4>()?;
        Some(if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    }
    fn f64(&mut self, little: bool) -> Option<f64> {
        let b = self.take::<8>()?;
        Some(if little { f64::from_le_bytes(b) } else { f64::from_be_bytes(b) })
    }
    fn count(&mut self, little: bool) -> Option<usize> {
        let n = self.u32(little)? as usize;
        (n <= self.bytes.len()).then_some(n)
    }

    /// One geometry: its type and dimensions, then its coordinates.
    fn header(&mut self) -> Option<(u32, usize, bool)> {
        let little = self.take::<1>()?[0] == 1;
        let raw = self.u32(little)?;
        let (mut z, mut m) = (raw & 0x8000_0000 != 0, raw & 0x4000_0000 != 0);
        if raw & 0x2000_0000 != 0 {
            self.u32(little)?; // EWKB SRID
        }
        let code = raw & 0x0fff_ffff;
        let (base, dims) = (code % 1000, code / 1000);
        z |= dims == 1 || dims == 3;
        m |= dims == 2 || dims == 3;
        Some((base, 2 + z as usize + m as usize, little))
    }

    fn point(&mut self, dims: usize, little: bool) -> Option<Value> {
        let x = self.f64(little)?;
        let y = self.f64(little)?;
        for _ in 2..dims {
            self.f64(little)?;
        }
        Some(json!([x, y]))
    }

    fn line(&mut self, dims: usize, little: bool) -> Option<Value> {
        let n = self.count(little)?;
        Some(Value::Array((0..n).map(|_| self.point(dims, little)).collect::<Option<_>>()?))
    }

    fn polygon(&mut self, dims: usize, little: bool) -> Option<Value> {
        let n = self.count(little)?;
        Some(Value::Array((0..n).map(|_| self.line(dims, little)).collect::<Option<_>>()?))
    }

    fn geometry(&mut self) -> Option<Value> {
        let (kind, dims, little) = self.header()?;
        Some(match kind {
            1 => {
                let p = self.point(dims, little)?;
                if p[0].as_f64()?.is_nan() {
                    return None;
                }
                json!({ "type": "Point", "coordinates": p })
            }
            2 => json!({ "type": "LineString", "coordinates": self.line(dims, little)? }),
            3 => json!({ "type": "Polygon", "coordinates": self.polygon(dims, little)? }),
            4..=6 => {
                let n = self.count(little)?;
                let mut parts = Vec::with_capacity(n);
                for _ in 0..n {
                    let (_, dims, little) = self.header()?;
                    parts.push(match kind {
                        4 => self.point(dims, little)?,
                        5 => self.line(dims, little)?,
                        _ => self.polygon(dims, little)?,
                    });
                }
                let name = ["MultiPoint", "MultiLineString", "MultiPolygon"][(kind - 4) as usize];
                json!({ "type": name, "coordinates": parts })
            }
            7 => {
                let n = self.count(little)?;
                let parts: Vec<Value> = (0..n).map(|_| self.geometry()).collect::<Option<_>>()?;
                json!({ "type": "GeometryCollection", "geometries": parts })
            }
            _ => return None,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn shp_polygon(rings: &[&[(f64, f64)]]) -> Vec<u8> {
        let total: usize = rings.iter().map(|r| r.len()).sum();
        let mut content = Vec::new();
        content.extend_from_slice(&5i32.to_le_bytes());
        content.extend_from_slice(&[0u8; 32]);
        content.extend_from_slice(&(rings.len() as i32).to_le_bytes());
        content.extend_from_slice(&(total as i32).to_le_bytes());
        let mut start = 0;
        for r in rings {
            content.extend_from_slice(&(start as i32).to_le_bytes());
            start += r.len();
        }
        for r in rings {
            for (x, y) in r.iter() {
                content.extend_from_slice(&x.to_le_bytes());
                content.extend_from_slice(&y.to_le_bytes());
            }
        }
        let mut file = vec![0u8; 100];
        file[0..4].copy_from_slice(&9994i32.to_be_bytes());
        file.extend_from_slice(&1i32.to_be_bytes());
        file.extend_from_slice(&((content.len() / 2) as i32).to_be_bytes());
        file.extend_from_slice(&content);
        file
    }

    /// A shapefile of points and its .dbf with one text column `NAMN`.
    pub(crate) fn shp_points(points: &[(f64, f64, &str)]) -> (Vec<u8>, Vec<u8>) {
        let mut shp = vec![0u8; 100];
        shp[0..4].copy_from_slice(&9994i32.to_be_bytes());
        for (i, (x, y, _)) in points.iter().enumerate() {
            shp.extend_from_slice(&(i as i32 + 1).to_be_bytes());
            shp.extend_from_slice(&10i32.to_be_bytes());
            shp.extend_from_slice(&1i32.to_le_bytes());
            shp.extend_from_slice(&x.to_le_bytes());
            shp.extend_from_slice(&y.to_le_bytes());
        }
        let mut dbf = vec![0u8; 32];
        dbf[0] = 3;
        dbf[4..8].copy_from_slice(&(points.len() as u32).to_le_bytes());
        dbf[8..10].copy_from_slice(&(32u16 + 32 + 1).to_le_bytes());
        dbf[10..12].copy_from_slice(&21u16.to_le_bytes());
        let mut field = [0u8; 32];
        field[..4].copy_from_slice(b"NAMN");
        field[11] = b'C';
        field[16] = 20;
        dbf.extend_from_slice(&field);
        dbf.push(0x0d);
        for (_, _, name) in points {
            dbf.push(b' ');
            let mut t = name.as_bytes().to_vec();
            t.resize(20, b' ');
            dbf.extend_from_slice(&t);
        }
        (shp, dbf)
    }

    /// A zip of files, stored without compression.
    pub(crate) fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut out = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut out);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in files {
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        out.into_inner()
    }

    #[test]
    fn a_zip_of_shapefiles_reads_as_layers() {
        let (shp, dbf) = shp_points(&[(1.0, 2.0, "Brunn"), (3.0, 4.0, "Källa")]);
        let (line, _) = shp_points(&[(5.0, 6.0, "x")]);
        let zip = zip_of(&[
            ("sgu/wells.shp", &shp),
            ("sgu/wells.dbf", &dbf),
            ("sgu/wells.prj", br#"PROJCS["SWEREF99_TM",GEOGCS["GCS_SWEREF99"]]"#),
            ("__MACOSX/sgu/._wells.shp", b"junk"),
            ("sgu/other.shp", &line),
            ("sgu/readme.pdf", b"%PDF"),
        ]);
        let layers = read(&zip).unwrap();
        assert_eq!(layers.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["wells", "other"]);
        assert_eq!(layers[0].crs.as_deref(), Some("EPSG:3006"));
        assert_eq!(layers[0].features.len(), 2);
        assert_eq!(layers[0].features[1]["properties"]["NAMN"], "Källa");
        assert_eq!(layers[0].features[1]["geometry"]["coordinates"], json!([3.0, 4.0]));
        assert!(layers[1].features[0]["properties"].as_object().unwrap().is_empty());
    }

    #[test]
    fn shapefile_rings_become_a_polygon_with_its_hole() {
        // Outer ring clockwise, hole counter-clockwise, as shapefiles store them.
        let outer: &[(f64, f64)] = &[(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0), (0.0, 0.0)];
        let hole: &[(f64, f64)] = &[(2.0, 2.0), (4.0, 2.0), (4.0, 4.0), (2.0, 4.0), (2.0, 2.0)];
        let shapes = read_shp(&shp_polygon(&[outer, hole])).unwrap();
        let g = shapes[0].as_ref().unwrap();
        assert_eq!(g["type"], "Polygon");
        assert_eq!(g["coordinates"].as_array().unwrap().len(), 2);
        // Written counter-clockwise for GeoJSON.
        let ring: Vec<(f64, f64)> =
            g["coordinates"][0].as_array().unwrap().iter().map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap())).collect();
        assert!(signed_area(&ring) > 0.0);
    }

    #[test]
    fn dbf_columns_in_utf8_and_windows_1252() {
        let mut dbf = vec![0u8; 32];
        dbf[0] = 3;
        dbf[4..8].copy_from_slice(&2u32.to_le_bytes());
        let header = 32 + 2 * 32 + 1;
        dbf[8..10].copy_from_slice(&(header as u16).to_le_bytes());
        dbf[10..12].copy_from_slice(&(1 + 10 + 5u16).to_le_bytes());
        let field = |name: &str, kind: u8, len: u8| {
            let mut f = [0u8; 32];
            f[..name.len()].copy_from_slice(name.as_bytes());
            f[11] = kind;
            f[16] = len;
            f
        };
        dbf.extend_from_slice(&field("JG2_TX", b'C', 10));
        dbf.extend_from_slice(&field("DJUP", b'N', 5));
        dbf.push(0x0d);
        let mut row = |text: &[u8], n: &str| {
            dbf.push(b' ');
            let mut t = text.to_vec();
            t.resize(10, b' ');
            dbf.extend_from_slice(&t);
            dbf.extend_from_slice(format!("{n:>5}").as_bytes());
        };
        row("Morän".as_bytes(), "12.5");
        row(b"Mor\xe4n", "");
        let rows = read_dbf(&dbf, None).unwrap();
        assert_eq!(rows[0]["JG2_TX"], "Morän");
        assert_eq!(rows[0]["DJUP"], 12.5);
        assert_eq!(rows[1]["JG2_TX"], "Morän");
        assert_eq!(rows[1]["DJUP"], Value::Null);
    }

    #[test]
    fn prj_files_name_their_system() {
        let sweref = r#"PROJCS["SWEREF99_TM", GEOGCS["GCS_SWEREF99", DATUM["D_SWEREF99", SPHEROID["GRS_1980", 6378137.0, 298.257222101]]], PROJECTION["Transverse_Mercator"], UNIT["Meter", 1.0], AUTHORITY["EPSG","3006"]]"#;
        assert_eq!(crs_of_prj(sweref).as_deref(), Some("EPSG:3006"));
        assert_eq!(crs_of_prj(r#"PROJCS["SWEREF99_TM",GEOGCS["GCS_SWEREF99"]]"#).as_deref(), Some("EPSG:3006"));
        assert_eq!(crs_of_prj(r#"PROJCS["SWEREF99 12 00",GEOGCS["SWEREF99"]]"#).as_deref(), Some("EPSG:3007"));
        assert_eq!(crs_of_prj(r#"PROJCS["WGS_1984_UTM_Zone_33N",GEOGCS["GCS_WGS_1984"]]"#).as_deref(), Some("EPSG:32633"));
        assert_eq!(crs_of_prj(r#"GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984"]]"#).as_deref(), Some("EPSG:4326"));
        assert_eq!(crs_of_prj("LOCAL_CS[\"x\"]"), None);
    }

    #[test]
    fn geopackage_geometry_blobs() {
        // GP header (no envelope, little endian), then a WKB polygon with one triangle ring.
        let mut blob = b"GP\x00\x01".to_vec();
        blob.extend_from_slice(&3006i32.to_le_bytes());
        blob.push(1);
        blob.extend_from_slice(&3u32.to_le_bytes());
        blob.extend_from_slice(&1u32.to_le_bytes());
        blob.extend_from_slice(&4u32.to_le_bytes());
        for (x, y) in [(0.0f64, 0.0f64), (1.0, 0.0), (0.0, 1.0), (0.0, 0.0)] {
            blob.extend_from_slice(&x.to_le_bytes());
            blob.extend_from_slice(&y.to_le_bytes());
        }
        let g = gpkg_geometry(&blob).unwrap();
        assert_eq!(g["type"], "Polygon");
        assert_eq!(g["coordinates"][0].as_array().unwrap().len(), 4);
    }
}
