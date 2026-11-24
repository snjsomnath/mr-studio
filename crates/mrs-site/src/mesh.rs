//! Triangle meshes as a source for the top surface: reads STL, OBJ and GLB, and rasterises them from above.

use std::path::Path;

use serde_json::Value;

pub type Triangle = [[f32; 3]; 3];

/// The mesh files a site can take, known by their extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Stl,
    Obj,
    Glb,
}

impl Format {
    pub fn of(path: &str) -> Option<Self> {
        let lower = path.to_ascii_lowercase();
        let extension = lower.rsplit_once('.')?.1;
        match extension {
            "stl" => Some(Self::Stl),
            "obj" => Some(Self::Obj),
            "glb" => Some(Self::Glb),
            _ => None,
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Stl => "stl",
            Self::Obj => "obj",
            Self::Glb => "glb",
        }
    }
}

/// Reads a mesh file in its own coordinates, by its extension.
pub fn read(path: &Path) -> Result<Vec<Triangle>, String> {
    let format = Format::of(&path.to_string_lossy()).ok_or("a mesh is an STL, OBJ or GLB file")?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    parse(format, &bytes)
}

/// Reads mesh bytes in their own coordinates.
pub fn parse(format: Format, bytes: &[u8]) -> Result<Vec<Triangle>, String> {
    let triangles = match format {
        Format::Stl => parse_stl(bytes)?,
        Format::Obj => parse_obj(bytes)?,
        Format::Glb => parse_glb(bytes)?,
    };
    if triangles.is_empty() {
        return Err("the model has no triangles".into());
    }
    if triangles.iter().flatten().flatten().any(|v| !v.is_finite()) {
        return Err("the mesh contains non-finite coordinates".into());
    }
    Ok(triangles)
}

/// Wavefront OBJ: `v` lines and `f` lines; faces with more than three corners are fanned.
fn parse_obj(bytes: &[u8]) -> Result<Vec<Triangle>, String> {
    let text = String::from_utf8_lossy(bytes);
    let mut vertices: Vec<[f32; 3]> = Vec::new();
    let mut triangles = Vec::new();
    for (number, line) in text.lines().enumerate() {
        let mut words = line.split_whitespace();
        match words.next() {
            Some("v") => {
                let mut next = || words.next().and_then(|w| w.parse::<f32>().ok());
                match (next(), next(), next()) {
                    (Some(x), Some(y), Some(z)) => vertices.push([x, y, z]),
                    _ => return Err(format!("line {}: a vertex needs three numbers", number + 1)),
                }
            }
            Some("f") => {
                let corners = words
                    .map(|word| {
                        // `v`, `v/vt`, `v//vn` or `v/vt/vn`; negative indices count back from the last vertex.
                        let index: i64 =
                            word.split('/').next().unwrap_or("").parse().map_err(|_| format!("line {}: bad face", number + 1))?;
                        let at = if index < 0 { vertices.len() as i64 + index } else { index - 1 };
                        vertices
                            .get(usize::try_from(at).map_err(|_| format!("line {}: bad face", number + 1))?)
                            .copied()
                            .ok_or_else(|| format!("line {}: a face names a vertex that is not there", number + 1))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                for i in 1..corners.len().saturating_sub(1) {
                    triangles.push([corners[0], corners[i], corners[i + 1]]);
                }
            }
            _ => {}
        }
    }
    Ok(triangles)
}

/// A column-major 4 x 4 matrix, as glTF writes them.
type Matrix = [f64; 16];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    let mut out = [0.0; 16];
    for col in 0..4 {
        for row in 0..4 {
            out[col * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[col * 4 + k]).sum();
        }
    }
    out
}

/// A node's own transform: its `matrix`, or translation × rotation × scale.
fn node_matrix(node: &Value) -> Matrix {
    let numbers = |key: &str, n: usize| -> Option<Vec<f64>> {
        let list: Vec<f64> = node[key].as_array()?.iter().filter_map(Value::as_f64).collect();
        (list.len() == n).then_some(list)
    };
    if let Some(m) = numbers("matrix", 16) {
        return m.try_into().expect("16");
    }
    let t = numbers("translation", 3).unwrap_or(vec![0.0; 3]);
    let r = numbers("rotation", 4).unwrap_or(vec![0.0, 0.0, 0.0, 1.0]);
    let s = numbers("scale", 3).unwrap_or(vec![1.0; 3]);
    let (x, y, z, w) = (r[0], r[1], r[2], r[3]);
    [
        (1.0 - 2.0 * (y * y + z * z)) * s[0],
        (2.0 * (x * y + z * w)) * s[0],
        (2.0 * (x * z - y * w)) * s[0],
        0.0,
        (2.0 * (x * y - z * w)) * s[1],
        (1.0 - 2.0 * (x * x + z * z)) * s[1],
        (2.0 * (y * z + x * w)) * s[1],
        0.0,
        (2.0 * (x * z + y * w)) * s[2],
        (2.0 * (y * z - x * w)) * s[2],
        (1.0 - 2.0 * (x * x + y * y)) * s[2],
        0.0,
        t[0],
        t[1],
        t[2],
        1.0,
    ]
}

/// Binary glTF: every triangle primitive of the default scene, with its nodes' transforms applied.
/// The result is in glTF's own frame, which is Y up.
fn parse_glb(bytes: &[u8]) -> Result<Vec<Triangle>, String> {
    let word = |at: usize| -> Option<u32> { Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?)) };
    if word(0) != Some(0x4654_6C67) {
        return Err("not a GLB file (a .gltf with separate files is not read; export a single .glb)".into());
    }
    let mut json: Option<Value> = None;
    let mut bin: &[u8] = &[];
    let mut at = 12;
    while let (Some(length), Some(kind)) = (word(at), word(at + 4)) {
        let chunk = bytes.get(at + 8..at + 8 + length as usize).ok_or("the GLB file is cut short")?;
        match kind {
            0x4E4F_534A => json = Some(serde_json::from_slice(chunk).map_err(|e| format!("the GLB's description is broken: {e}"))?),
            0x004E_4942 => bin = chunk,
            _ => {}
        }
        at += 8 + length as usize;
    }
    let gltf = json.ok_or("the GLB file has no description")?;
    if let Some(required) = gltf["extensionsRequired"].as_array().filter(|list| !list.is_empty()) {
        let names: Vec<&str> = required.iter().filter_map(Value::as_str).collect();
        return Err(format!("the GLB needs {} to be read; export it without compression", names.join(", ")));
    }

    // The bytes of an accessor, as float triples or indices.
    let view_of = |accessor: &Value| -> Result<(&[u8], usize, usize, u64, usize), String> {
        let view = &gltf["bufferViews"][accessor["bufferView"].as_u64().ok_or("an accessor without data")? as usize];
        if view["buffer"].as_u64().unwrap_or(0) != 0 {
            return Err("the GLB keeps data in a separate file".into());
        }
        let start = view["byteOffset"].as_u64().unwrap_or(0) as usize;
        let length = view["byteLength"].as_u64().unwrap_or(0) as usize;
        let data = bin.get(start..start + length).ok_or("the GLB's data is cut short")?;
        let component = accessor["componentType"].as_u64().unwrap_or(0);
        let size = match component {
            5120 | 5121 => 1,
            5122 | 5123 => 2,
            5125 | 5126 => 4,
            _ => return Err("an accessor of an unknown kind".into()),
        };
        let width = match accessor["type"].as_str() {
            Some("SCALAR") => 1,
            Some("VEC3") => 3,
            _ => return Err("positions are not three numbers".into()),
        };
        let stride = view["byteStride"].as_u64().map_or(size * width, |s| s as usize);
        Ok((
            data,
            accessor["byteOffset"].as_u64().unwrap_or(0) as usize,
            stride,
            component,
            accessor["count"].as_u64().unwrap_or(0) as usize,
        ))
    };
    let read_u32 = |data: &[u8], at: usize, component: u64| -> Option<u32> {
        Some(match component {
            5121 => *data.get(at)? as u32,
            5123 => u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?) as u32,
            5125 => u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?),
            _ => return None,
        })
    };

    let mut triangles = Vec::new();
    let mut add_mesh = |mesh: &Value, matrix: &Matrix| -> Result<(), String> {
        for primitive in mesh["primitives"].as_array().into_iter().flatten() {
            if primitive["mode"].as_u64().unwrap_or(4) != 4 {
                continue; // points and lines have no surface
            }
            let accessor =
                &gltf["accessors"][primitive["attributes"]["POSITION"].as_u64().ok_or("a primitive without positions")? as usize];
            let (data, offset, stride, component, count) = view_of(accessor)?;
            if component != 5126 {
                return Err("positions are not floats (quantised GLBs are not read)".into());
            }
            let mut points = Vec::with_capacity(count);
            for i in 0..count {
                let at = offset + i * stride;
                let float =
                    |k: usize| -> Option<f64> { Some(f32::from_le_bytes(data.get(at + k * 4..at + k * 4 + 4)?.try_into().ok()?) as f64) };
                let (x, y, z) = (float(0).ok_or("positions are cut short")?, float(1).unwrap_or(0.0), float(2).unwrap_or(0.0));
                let m = matrix;
                points.push([
                    (m[0] * x + m[4] * y + m[8] * z + m[12]) as f32,
                    (m[1] * x + m[5] * y + m[9] * z + m[13]) as f32,
                    (m[2] * x + m[6] * y + m[10] * z + m[14]) as f32,
                ]);
            }
            let indices: Vec<usize> = match primitive["indices"].as_u64() {
                None => (0..count).collect(),
                Some(index) => {
                    let (data, offset, stride, component, count) = view_of(&gltf["accessors"][index as usize])?;
                    (0..count)
                        .map(|i| read_u32(data, offset + i * stride, component).map(|v| v as usize).ok_or("indices are cut short"))
                        .collect::<Result<_, _>>()?
                }
            };
            for t in indices.chunks_exact(3) {
                let corner = |i: usize| points.get(i).copied().ok_or("an index past the last position");
                triangles.push([corner(t[0])?, corner(t[1])?, corner(t[2])?]);
            }
        }
        Ok(())
    };

    let nodes = gltf["nodes"].as_array().cloned().unwrap_or_default();
    let scene = &gltf["scenes"][gltf["scene"].as_u64().unwrap_or(0) as usize];
    let roots: Vec<usize> = match scene["nodes"].as_array() {
        Some(list) => list.iter().filter_map(|n| n.as_u64().map(|n| n as usize)).collect(),
        None => {
            // No scene: every mesh as it is.
            for mesh in gltf["meshes"].as_array().into_iter().flatten() {
                add_mesh(mesh, &IDENTITY)?;
            }
            return Ok(triangles);
        }
    };
    let mut stack: Vec<(usize, Matrix, usize)> = roots.into_iter().map(|n| (n, IDENTITY, 0)).collect();
    while let Some((index, parent, depth)) = stack.pop() {
        let node = nodes.get(index).ok_or("a node that is not there")?;
        if depth > 64 {
            return Err("the GLB's nodes nest too deep".into());
        }
        let matrix = multiply(&parent, &node_matrix(node));
        if let Some(mesh) = node["mesh"].as_u64() {
            add_mesh(&gltf["meshes"][mesh as usize], &matrix)?;
        }
        for child in node["children"].as_array().into_iter().flatten().filter_map(Value::as_u64) {
            stack.push((child as usize, matrix, depth + 1));
        }
    }
    Ok(triangles)
}

fn parse_stl(bytes: &[u8]) -> Result<Vec<Triangle>, String> {
    // Binary: an 80-byte header, a count, then 50 bytes per triangle. The size is the
    // reliable test, because binary files may also start with the word "solid".
    if bytes.len() >= 84 {
        let count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
        if bytes.len() == 84 + count * 50 {
            let float = |at: usize| f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
            return Ok((0..count)
                .map(|i| {
                    // Skip the normal; it is recomputable and often wrong.
                    let at = 84 + i * 50 + 12;
                    [0, 1, 2].map(|v| [0, 1, 2].map(|k| float(at + v * 12 + k * 4)))
                })
                .collect());
        }
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "neither a binary nor an ASCII STL".to_string())?;
    if !text.trim_start().starts_with("solid") {
        return Err("neither a binary nor an ASCII STL".into());
    }
    let mut vertices: Vec<[f32; 3]> = Vec::new();
    for line in text.lines() {
        let mut words = line.split_whitespace();
        if words.next() == Some("vertex") {
            let mut next = || words.next().and_then(|w| w.parse::<f32>().ok());
            match (next(), next(), next()) {
                (Some(x), Some(y), Some(z)) => vertices.push([x, y, z]),
                _ => return Err(format!("bad vertex line: '{}'", line.trim())),
            }
        }
    }
    if !vertices.len().is_multiple_of(3) {
        return Err("the vertex count is not a multiple of three".into());
    }
    Ok(vertices.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect())
}

/// Rasterises triangles seen from above, keeping the highest surface in each cell.
/// `to_cell` maps a mesh vertex to fractional grid `(col, row)` and a height in metres.
/// `top` holds `f32::NEG_INFINITY` where no triangle covers the cell centre.
pub fn rasterise(triangles: &[Triangle], to_cell: impl Fn([f32; 3]) -> (f64, f64, f64), width: usize, height: usize, top: &mut [f32]) {
    for triangle in triangles {
        let [a, b, c] = triangle.map(&to_cell);
        let area = (b.0 - a.0) * (c.1 - a.1) - (c.0 - a.0) * (b.1 - a.1);
        // Walls and slivers have no area from above; the roofs and ground around them cover their cells.
        if area.abs() < 1e-12 {
            continue;
        }
        let first_col = (a.0.min(b.0).min(c.0) - 0.5).ceil().max(0.0) as usize;
        let first_row = (a.1.min(b.1).min(c.1) - 0.5).ceil().max(0.0) as usize;
        let last_col = ((a.0.max(b.0).max(c.0) - 0.5).floor() as i64).min(width as i64 - 1);
        let last_row = ((a.1.max(b.1).max(c.1) - 0.5).floor() as i64).min(height as i64 - 1);
        for row in first_row as i64..=last_row {
            let y = row as f64 + 0.5;
            for col in first_col as i64..=last_col {
                let x = col as f64 + 0.5;
                // Barycentric weights. A centre exactly on a shared edge belongs to both triangles.
                let wa = ((b.0 - x) * (c.1 - y) - (c.0 - x) * (b.1 - y)) / area;
                let wb = ((c.0 - x) * (a.1 - y) - (a.0 - x) * (c.1 - y)) / area;
                let wc = 1.0 - wa - wb;
                if wa < -1e-9 || wb < -1e-9 || wc < -1e-9 {
                    continue;
                }
                let z = (wa * a.2 + wb * b.2 + wc * c.2) as f32;
                let cell = &mut top[row as usize * width + col as usize];
                *cell = cell.max(z);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x0: f32, y0: f32, x1: f32, y1: f32, z: f32) -> [Triangle; 2] {
        [[[x0, y0, z], [x1, y0, z], [x1, y1, z]], [[x0, y0, z], [x1, y1, z], [x0, y1, z]]]
    }

    #[test]
    fn keeps_the_highest_surface_without_gaps() {
        // Ground at 2 m over the whole grid, a 4 x 4 roof at 9 m, and the box's floor below it.
        let mut triangles = square(0.0, 0.0, 10.0, 10.0, 2.0).to_vec();
        triangles.extend(square(3.0, 3.0, 7.0, 7.0, 9.0));
        triangles.extend(square(3.0, 3.0, 7.0, 7.0, 0.0));
        let mut top = vec![f32::NEG_INFINITY; 100];
        rasterise(&triangles, |v| (v[0] as f64, v[1] as f64, v[2] as f64), 10, 10, &mut top);
        assert!(top.iter().all(|z| z.is_finite()), "the diagonal between two triangles leaves no hole");
        assert_eq!(top.iter().filter(|z| **z == 9.0).count(), 16);
        assert_eq!(top[3 * 10 + 3], 9.0);
        assert_eq!(top[2 * 10 + 3], 2.0);
    }

    #[test]
    fn interpolates_slopes_and_clips_to_the_grid() {
        // A ramp rising 1 m per cell along x, reaching beyond the grid on every side.
        let ramp: Vec<Triangle> = square(-5.0, -5.0, 15.0, 15.0, 0.0).iter().map(|t| t.map(|v| [v[0], v[1], v[0]])).collect();
        let mut top = vec![f32::NEG_INFINITY; 40];
        rasterise(&ramp, |v| (v[0] as f64, v[1] as f64, v[2] as f64), 10, 4, &mut top);
        for (i, z) in top.iter().enumerate() {
            assert!((z - ((i % 10) as f32 + 0.5)).abs() < 1e-5, "cell {i}: {z}");
        }
    }

    #[test]
    fn reads_binary_and_ascii() {
        let ascii = "solid t\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0.5\n  endloop\n endfacet\nendsolid t\n";
        let expected: Triangle = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.5]];
        assert_eq!(parse_stl(ascii.as_bytes()).unwrap(), vec![expected]);

        let mut binary = vec![0u8; 80];
        binary[..5].copy_from_slice(b"solid");
        binary.extend(1u32.to_le_bytes());
        binary.extend([0f32; 3].iter().flat_map(|v| v.to_le_bytes()));
        binary.extend(expected.iter().flatten().flat_map(|v| v.to_le_bytes()));
        binary.extend([0u8; 2]);
        assert_eq!(parse_stl(&binary).unwrap(), vec![expected]);

        assert!(parse_stl(b"not a mesh").is_err());
    }

    #[test]
    fn reads_obj_with_quads_and_negative_indices() {
        let obj = "# a square and a triangle\nv 0 0 0\nv 2 0 0\nv 2 2 1\nv 0 2 1\nf 1/1/1 2/2/2 3/3/3 4/4/4\nv 5 5 5\nf -1 1 2\n";
        let triangles = parse(Format::Obj, obj.as_bytes()).unwrap();
        assert_eq!(triangles.len(), 3);
        assert_eq!(triangles[1], [[0.0, 0.0, 0.0], [2.0, 2.0, 1.0], [0.0, 2.0, 1.0]]);
        assert_eq!(triangles[2][0], [5.0, 5.0, 5.0]);
        assert!(parse(Format::Obj, b"f 1 2 3\n").is_err());
    }

    /// A GLB of one triangle, under a node moved by (10, 0, 0) and turned a quarter about Y.
    fn glb() -> Vec<u8> {
        let positions: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 2.0, 0.0];
        let indices: [u16; 3] = [0, 1, 2];
        let mut bin: Vec<u8> = positions.iter().flat_map(|v| v.to_le_bytes()).collect();
        bin.extend(indices.iter().flat_map(|v| v.to_le_bytes()));
        bin.extend([0, 0]);
        let half = std::f64::consts::FRAC_1_SQRT_2;
        let json = serde_json::json!({
            "asset": { "version": "2.0" },
            "scene": 0,
            "scenes": [{ "nodes": [0] }],
            "nodes": [{ "children": [1], "translation": [10.0, 0.0, 0.0] }, { "mesh": 0, "rotation": [0.0, half, 0.0, half] }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 }, "indices": 1 }] }],
            "accessors": [
                { "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3" },
                { "bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR" }
            ],
            "bufferViews": [{ "buffer": 0, "byteOffset": 0, "byteLength": 36 }, { "buffer": 0, "byteOffset": 36, "byteLength": 6 }],
            "buffers": [{ "byteLength": bin.len() }]
        });
        let mut text = serde_json::to_vec(&json).unwrap();
        while text.len() % 4 != 0 {
            text.push(b' ');
        }
        let mut out = Vec::new();
        out.extend(0x4654_6C67u32.to_le_bytes());
        out.extend(2u32.to_le_bytes());
        out.extend(((12 + 8 + text.len() + 8 + bin.len()) as u32).to_le_bytes());
        out.extend((text.len() as u32).to_le_bytes());
        out.extend(0x4E4F_534Au32.to_le_bytes());
        out.extend(text);
        out.extend((bin.len() as u32).to_le_bytes());
        out.extend(0x004E_4942u32.to_le_bytes());
        out.extend(bin);
        out
    }

    #[test]
    fn reads_glb_with_node_transforms() {
        let triangles = parse(Format::Glb, &glb()).unwrap();
        assert_eq!(triangles.len(), 1);
        // A quarter turn about Y takes +X to -Z; then the parent moves it 10 along X.
        let near = |a: [f32; 3], b: [f32; 3]| a.iter().zip(b).all(|(p, q)| (p - q).abs() < 1e-5);
        assert!(near(triangles[0][0], [10.0, 0.0, 0.0]));
        assert!(near(triangles[0][1], [10.0, 0.0, -1.0]), "{:?}", triangles[0][1]);
        assert!(near(triangles[0][2], [10.0, 2.0, 0.0]));
        assert!(parse(Format::Glb, b"glTF but not really").is_err());
    }

    #[test]
    fn knows_formats_by_extension() {
        assert_eq!(Format::of("data/Model.STL"), Some(Format::Stl));
        assert_eq!(Format::of("x.glb"), Some(Format::Glb));
        assert_eq!(Format::of("x.gltf"), None);
        assert_eq!(Format::of("noextension"), None);
    }
}
