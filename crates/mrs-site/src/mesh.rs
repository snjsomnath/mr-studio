//! Triangle meshes as a source for the top surface: reads STL and rasterises it from above.

use std::path::Path;

pub type Triangle = [[f32; 3]; 3];

/// Reads a binary or ASCII STL.
pub fn read_stl(path: &Path) -> Result<Vec<Triangle>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let triangles = parse_stl(&bytes)?;
    if triangles.iter().flatten().flatten().any(|v| !v.is_finite()) {
        return Err("the mesh contains non-finite coordinates".into());
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
}
