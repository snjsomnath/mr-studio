//! The digital twin: a triangle mesh of the scene's top surface, for surfaces that
//! render the physical model in 3D. Contract in `docs/contracts/model.md`.
//!
//! The mesh is built from the rasters every site already has. The `dtm` becomes a smooth
//! ground sheet, every solid cell of the `dsm` a flat piece of roof, and every height step
//! between neighbouring cells a wall. Pieces with the same height are merged, so a flat-roofed
//! building is a handful of quads rather than one per cell.

use crate::{Grid, SceneData, SOLID_THRESHOLD_M};

/// What a surface point is. The value is what the mesh stores per vertex.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SurfaceKind {
    Ground = 0,
    Roof = 1,
    Wall = 2,
}

#[derive(Debug, Clone, Copy)]
pub struct TwinOptions {
    /// Roof cells whose heights differ by no more than this are merged into one flat piece.
    pub merge_tolerance_m: f32,
    /// Upper bound on ground vertices. The ground is sampled every few cells to stay under it.
    pub max_ground_vertices: usize,
}

impl Default for TwinOptions {
    fn default() -> Self {
        Self { merge_tolerance_m: 0.05, max_ground_vertices: 60_000 }
    }
}

/// The twin as indexed triangles in the site's local frame: x east, y north, z up, in metres.
/// Triangles are wound counter-clockwise seen from outside.
#[derive(Debug, Clone, Default)]
pub struct TwinMesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub kinds: Vec<SurfaceKind>,
    /// 0 for none, otherwise the building's number as given to `build` (feature index plus one).
    pub buildings: Vec<u32>,
    pub indices: Vec<u32>,
}

pub const TWIN_MAGIC: &[u8; 4] = b"MRSM";
pub const TWIN_VERSION: u16 = 1;
pub const TWIN_HEADER_LEN: usize = 32;

impl TwinMesh {
    /// Builds the twin of a scene. `buildings`, when given, holds a building number per cell
    /// (0 for none) so each roof and wall knows which building it belongs to.
    pub fn build(scene: &SceneData, buildings: Option<&[u32]>, options: TwinOptions) -> Self {
        let mut mesh = Self::default();
        let builder = Builder { scene, grid: scene.grid, buildings, options };
        builder.ground(&mut mesh);
        let tops = builder.roofs(&mut mesh);
        builder.walls(&tops, &mut mesh);
        mesh
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// The wire and file form. Little endian:
    ///
    /// | Offset | Type | Meaning |
    /// | --- | --- | --- |
    /// | 0 | 4 bytes | `MRSM` |
    /// | 4 | u16 | version, 1 |
    /// | 6 | u16 | reserved |
    /// | 8 | u32 | vertex count `V` |
    /// | 12 | u32 | index count `I` |
    /// | 16 | f32 | lowest z |
    /// | 20 | f32 | highest z |
    /// | 24 | 8 bytes | reserved |
    /// | 32 | f32 × 3V | positions |
    /// | | i8 × 3V + u8 × V, interleaved | normal × 127 and surface kind, 4 bytes per vertex |
    /// | | u32 × V | building number |
    /// | | u32 × I | triangle indices |
    pub fn encode(&self) -> Vec<u8> {
        let v = self.positions.len();
        let mut out = Vec::with_capacity(TWIN_HEADER_LEN + v * 20 + self.indices.len() * 4);
        out.extend_from_slice(TWIN_MAGIC);
        out.extend_from_slice(&TWIN_VERSION.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(v as u32).to_le_bytes());
        out.extend_from_slice(&(self.indices.len() as u32).to_le_bytes());
        let (mut low, mut high) = (f32::MAX, f32::MIN);
        for p in &self.positions {
            low = low.min(p[2]);
            high = high.max(p[2]);
        }
        if v == 0 {
            (low, high) = (0.0, 0.0);
        }
        out.extend_from_slice(&low.to_le_bytes());
        out.extend_from_slice(&high.to_le_bytes());
        out.extend_from_slice(&[0u8; 8]);
        for p in &self.positions {
            for c in p {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
        for (n, kind) in self.normals.iter().zip(&self.kinds) {
            for c in n {
                out.push((c * 127.0).round().clamp(-127.0, 127.0) as i8 as u8);
            }
            out.push(*kind as u8);
        }
        for b in &self.buildings {
            out.extend_from_slice(&b.to_le_bytes());
        }
        for i in &self.indices {
            out.extend_from_slice(&i.to_le_bytes());
        }
        out
    }
}

struct Builder<'a> {
    scene: &'a SceneData,
    grid: Grid,
    buildings: Option<&'a [u32]>,
    options: TwinOptions,
}

impl Builder<'_> {
    fn size(&self) -> (usize, usize) {
        (self.grid.width as usize, self.grid.height as usize)
    }

    fn solid(&self, i: usize) -> bool {
        self.scene.dsm[i] - self.scene.dtm[i] > SOLID_THRESHOLD_M
    }

    fn building(&self, i: usize) -> u32 {
        self.buildings.map_or(0, |b| b[i])
    }

    /// A grid corner (fractional column and row) and a height, in the local frame.
    fn point(&self, col: f64, row: f64, z: f32) -> [f32; 3] {
        let (east, north) = self.grid.cell_to_local(col, row);
        [east as f32, north as f32, z]
    }

    /// A direction given as (right, up) on the grid, in the local frame.
    fn direction(&self, right: f32, up: f32, z: f32) -> [f32; 3] {
        let r = self.grid.rotation_deg.to_radians();
        let v = [right * r.cos() + up * r.sin(), -right * r.sin() + up * r.cos(), z];
        let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-12);
        [v[0] / len, v[1] / len, v[2] / len]
    }

    /// The ground as one smooth sheet under everything, sampled at cell corners every `step` cells.
    fn ground(&self, mesh: &mut TwinMesh) {
        let (width, height) = self.size();
        let budget = self.options.max_ground_vertices.max(4) as f64;
        let step = (((width + 1) * (height + 1)) as f64 / budget).sqrt().ceil().max(1.0) as usize;
        let lattice = |n: usize| -> Vec<usize> {
            let mut at: Vec<usize> = (0..n).step_by(step).collect();
            at.push(n);
            at
        };
        let (cols, rows) = (lattice(width), lattice(height));
        // A corner's height is the mean of the ground in the cells that meet there.
        let corner = |col: usize, row: usize| -> f32 {
            let (mut sum, mut n) = (0.0f32, 0.0f32);
            for (dc, dr) in [(0i64, 0i64), (-1, 0), (0, -1), (-1, -1)] {
                let (c, r) = (col as i64 + dc, row as i64 + dr);
                if c >= 0 && r >= 0 && (c as usize) < width && (r as usize) < height {
                    sum += self.scene.dtm[r as usize * width + c as usize];
                    n += 1.0;
                }
            }
            sum / n
        };
        let cell = self.grid.cell_m;
        let base = mesh.positions.len() as u32;
        for &row in &rows {
            for &col in &cols {
                let z = corner(col, row);
                // Slope by central differences one lattice step away, clamped at the edges.
                let (c0, c1) = (col.saturating_sub(step), (col + step).min(width));
                let (r0, r1) = (row.saturating_sub(step), (row + step).min(height));
                let dz_right = (corner(c1, row) - corner(c0, row)) / ((c1 - c0).max(1) as f32 * cell);
                let dz_up = (corner(col, r0) - corner(col, r1)) / ((r1 - r0).max(1) as f32 * cell);
                mesh.positions.push(self.point(col as f64, row as f64, z));
                mesh.normals.push(self.direction(-dz_right, -dz_up, 1.0));
                mesh.kinds.push(SurfaceKind::Ground);
                mesh.buildings.push(0);
            }
        }
        let across = cols.len() as u32;
        for r in 0..rows.len() as u32 - 1 {
            for c in 0..across - 1 {
                let (a, b) = (base + r * across + c, base + r * across + c + 1);
                let (d, e) = (a + across, b + across);
                // Row 0 is the far edge, so going down the rows is towards the viewer: a, d, e is counter-clockwise from above.
                mesh.indices.extend_from_slice(&[a, d, e, a, e, b]);
            }
        }
    }

    /// Flat roof pieces over the solid cells. Returns the height each cell's top was given,
    /// so the walls meet the roofs exactly.
    fn roofs(&self, mesh: &mut TwinMesh) -> Vec<f32> {
        let (width, height) = self.size();
        let mut tops = self.scene.dtm.clone();
        let mut done = vec![false; width * height];
        let tolerance = self.options.merge_tolerance_m;
        for row in 0..height {
            for col in 0..width {
                let seed = row * width + col;
                if done[seed] || !self.solid(seed) {
                    continue;
                }
                let (z, building) = (self.scene.dsm[seed], self.building(seed));
                let fits = |i: usize, done: &[bool]| {
                    !done[i] && self.solid(i) && (self.scene.dsm[i] - z).abs() <= tolerance && self.building(i) == building
                };
                let mut right = col + 1;
                while right < width && fits(row * width + right, &done) {
                    right += 1;
                }
                let mut bottom = row + 1;
                while bottom < height && (col..right).all(|c| fits(bottom * width + c, &done)) {
                    bottom += 1;
                }
                for r in row..bottom {
                    for c in col..right {
                        done[r * width + c] = true;
                        tops[r * width + c] = z;
                    }
                }
                let corners = [
                    self.point(col as f64, row as f64, z),
                    self.point(col as f64, bottom as f64, z),
                    self.point(right as f64, bottom as f64, z),
                    self.point(right as f64, row as f64, z),
                ];
                quad(mesh, corners, [0.0, 0.0, 1.0], SurfaceKind::Roof, building);
            }
        }
        tops
    }

    /// A wall wherever the top surface steps between two neighbouring cells and at least one of
    /// them is solid, and where a solid cell meets the edge of the grid.
    fn walls(&self, tops: &[f32], mesh: &mut TwinMesh) {
        let (width, height) = self.size();
        // Lines between columns, walked down the rows; then lines between rows, walked along the columns.
        for vertical in [true, false] {
            let (lines, length) = if vertical { (width + 1, height) } else { (height + 1, width) };
            for line in 0..lines {
                let mut run: Option<Run> = None;
                for along in 0..=length {
                    let step = if along < length { self.step(tops, vertical, line, along) } else { None };
                    match (&mut run, step) {
                        (Some(open), Some(next)) if open.continues(&next) => {
                            open.low = open.low.min(next.low);
                            open.end = along + 1;
                        }
                        _ => {
                            if let Some(open) = run.take() {
                                self.wall(&open, tops, vertical, line, mesh);
                            }
                            run = step.map(|s| Run { start: along, end: along + 1, ..s });
                        }
                    }
                }
            }
        }
    }

    /// The height step across one cell edge, if it needs a wall.
    fn step(&self, tops: &[f32], vertical: bool, line: usize, along: usize) -> Option<Run> {
        let (width, height) = self.size();
        // The cells before and after the line; `None` is outside the grid.
        let cell = |offset: usize| -> Option<usize> {
            let (col, row) = if vertical { (offset, along) } else { (along, offset) };
            (col < width && row < height).then(|| row * width + col)
        };
        let before = line.checked_sub(1).and_then(cell);
        let after = cell(line);
        // Outside the grid the surface is taken to be the ground of the cell inside.
        let top = |c: Option<usize>, other: Option<usize>| c.map(|i| tops[i]).or_else(|| other.map(|i| self.scene.dtm[i]));
        let (a, b) = (top(before, after)?, top(after, before)?);
        let solid = |c: Option<usize>| c.is_some_and(|i| self.solid(i));
        if !(solid(before) || solid(after)) || (a - b).abs() <= 1e-3 {
            return None;
        }
        let faces_after = a > b;
        let (upper, lower) = if faces_after { (before, after) } else { (after, before) };
        let onto_ground = !solid(lower);
        let building = match upper.map(|i| self.building(i)) {
            Some(0) | None => lower.map_or(0, |i| self.building(i)),
            Some(id) => id,
        };
        Some(Run { start: 0, end: 0, faces_after, high: a.max(b), low: a.min(b), onto_ground, building })
    }

    fn wall(&self, run: &Run, tops: &[f32], vertical: bool, line: usize, mesh: &mut TwinMesh) {
        // A wall that meets the ground goes a little below it, so the coarser ground sheet never shows a gap.
        let low = if run.onto_ground { run.low - GROUND_SKIRT_M } else { run.low };
        let at = |along: usize, z: f32| {
            let (col, row) = if vertical { (line, along) } else { (along, line) };
            self.point(col as f64, row as f64, z)
        };
        let corners = [at(run.start, low), at(run.end, low), at(run.end, run.high), at(run.start, run.high)];
        // Columns grow to the right; rows grow downwards, which is "up" negative.
        let sign = if run.faces_after { 1.0 } else { -1.0 };
        let (right, up) = if vertical { (sign, 0.0) } else { (0.0, -sign) };
        let middle = (run.start + run.end) as f32 / 2.0;
        let (col, row) = if vertical { (line as f32, middle) } else { (middle, line as f32) };
        let shade = self.facing(tops, col, row, (run.high + run.low) / 2.0, (right, up));
        // Wound by the way the edge really faces; shaded by the way the facade it belongs to faces.
        let base = mesh.normals.len();
        quad(mesh, corners, self.direction(right, up, 0.0), SurfaceKind::Wall, run.building);
        let normal = self.direction(shade.0, shade.1, 0.0);
        mesh.normals[base..].fill(normal);
    }

    /// Which way a wall faces for shading, as (right, up) on the grid. A wall that runs at an
    /// angle to the grid is a staircase of cell edges; lit by their own normals it would be
    /// striped. This looks at the cells around the wall and finds the direction from the
    /// higher side to the lower, so a diagonal facade shades as the single plane it stands for.
    fn facing(&self, tops: &[f32], col: f32, row: f32, level: f32, axis: (f32, f32)) -> (f32, f32) {
        const REACH: i64 = 4;
        let (width, height) = self.size();
        let (mut right, mut up) = (0.0f32, 0.0f32);
        for r in row.floor() as i64 - REACH..=row.floor() as i64 + REACH {
            for c in col.floor() as i64 - REACH..=col.floor() as i64 + REACH {
                let inside = c >= 0 && r >= 0 && (c as usize) < width && (r as usize) < height;
                if !inside || tops[r as usize * width + c as usize] <= level {
                    continue;
                }
                let (dc, dr) = (c as f32 + 0.5 - col, r as f32 + 0.5 - row);
                if dc * dc + dr * dr <= (REACH * REACH) as f32 {
                    // Away from every higher cell.
                    right -= dc;
                    up += dr;
                }
            }
        }
        let len = (right * right + up * up).sqrt();
        // A thin fin has higher cells all around and no clear direction, and an edge that faces back
        // along its facade is not part of it. Those keep the edge's own direction.
        if len > 8.0 && (right * axis.0 + up * axis.1) / len > -0.3 {
            (right / len, up / len)
        } else {
            axis
        }
    }
}

/// How far walls reach below the ground they stand on.
const GROUND_SKIRT_M: f32 = 1.0;

/// A stretch of wall along one grid line with the same top, facing and building.
#[derive(Debug, Clone, Copy)]
struct Run {
    start: usize,
    end: usize,
    /// The wall faces the cell after the line (higher column or row).
    faces_after: bool,
    high: f32,
    low: f32,
    onto_ground: bool,
    building: u32,
}

impl Run {
    fn continues(&self, next: &Run) -> bool {
        self.faces_after == next.faces_after
            && self.high == next.high
            && self.onto_ground == next.onto_ground
            && self.building == next.building
            && (self.onto_ground || self.low == next.low)
    }
}

/// Adds a flat quad, winding it so it faces along `normal`.
fn quad(mesh: &mut TwinMesh, corners: [[f32; 3]; 4], normal: [f32; 3], kind: SurfaceKind, building: u32) {
    let base = mesh.positions.len() as u32;
    let [a, b, c, _] = corners;
    let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let facing = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] >= 0.0;
    for corner in corners {
        mesh.positions.push(corner);
        mesh.normals.push(normal);
        mesh.kinds.push(kind);
        mesh.buildings.push(building);
    }
    let order: [u32; 6] = if facing { [0, 1, 2, 0, 2, 3] } else { [0, 2, 1, 0, 3, 2] };
    mesh.indices.extend(order.iter().map(|i| base + i));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(width: u32, height: u32) -> Grid {
        Grid { width, height, cell_m: 2.0, rotation_deg: 0.0 }
    }

    /// A 4 x 3 cell box, 10 m high, on flat ground.
    fn box_scene() -> (SceneData, Vec<u32>) {
        let mut scene = SceneData::flat(grid(20, 10));
        let mut ids = vec![0u32; 200];
        for row in 3..6 {
            for col in 5..9 {
                scene.dsm[row * 20 + col] = 10.0;
                ids[row * 20 + col] = 7;
            }
        }
        (scene, ids)
    }

    fn area(mesh: &TwinMesh, kind: SurfaceKind) -> f32 {
        mesh.indices
            .as_chunks::<3>()
            .0
            .iter()
            .filter(|t| mesh.kinds[t[0] as usize] == kind)
            .map(|t| {
                let [a, b, c] = [mesh.positions[t[0] as usize], mesh.positions[t[1] as usize], mesh.positions[t[2] as usize]];
                let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
                let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
                0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
            })
            .sum()
    }

    #[test]
    fn flat_ground_is_one_sheet() {
        let mesh = TwinMesh::build(&SceneData::flat(grid(20, 10)), None, TwinOptions::default());
        assert!(mesh.kinds.iter().all(|k| *k == SurfaceKind::Ground));
        assert_eq!(mesh.positions.len(), 21 * 11);
        assert!((area(&mesh, SurfaceKind::Ground) - 40.0 * 20.0).abs() < 1e-3);
        // North is towards row 0 and the grid is centred on the origin.
        assert_eq!(mesh.positions[0], [-20.0, 10.0, 0.0]);
    }

    #[test]
    fn a_box_gets_one_roof_and_four_walls() {
        let (scene, ids) = box_scene();
        let mesh = TwinMesh::build(&scene, Some(&ids), TwinOptions::default());
        let count = |kind| mesh.kinds.iter().filter(|k| **k == kind).count() / 4;
        assert_eq!(count(SurfaceKind::Roof), 1, "equal heights merge into one roof");
        assert_eq!(count(SurfaceKind::Wall), 4, "each side is one wall");
        assert!((area(&mesh, SurfaceKind::Roof) - 8.0 * 6.0).abs() < 1e-3);
        // Walls reach the skirt depth below the ground.
        let wall = 2.0 * (8.0 + 6.0) * (10.0 + GROUND_SKIRT_M);
        assert!((area(&mesh, SurfaceKind::Wall) - wall).abs() < 1e-2);
        for (i, kind) in mesh.kinds.iter().enumerate() {
            assert_eq!(mesh.buildings[i], if *kind == SurfaceKind::Ground { 0 } else { 7 });
        }
    }

    #[test]
    fn triangles_face_along_their_normals_and_walls_face_out() {
        let (scene, ids) = box_scene();
        let mesh = TwinMesh::build(&scene, Some(&ids), TwinOptions::default());
        // The box spans columns 5..9 and rows 3..6: x from -10 to -2, y from -2 to 4.
        let centre = [-6.0f32, 1.0];
        for t in mesh.indices.as_chunks::<3>().0.iter() {
            let [a, b, c] = [mesh.positions[t[0] as usize], mesh.positions[t[1] as usize], mesh.positions[t[2] as usize]];
            let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            let face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            let n = mesh.normals[t[0] as usize];
            assert!(face[0] * n[0] + face[1] * n[1] + face[2] * n[2] > 0.0, "winding matches the normal");
            assert!((n[0] * n[0] + n[1] * n[1] + n[2] * n[2] - 1.0).abs() < 1e-5);
            if mesh.kinds[t[0] as usize] == SurfaceKind::Wall {
                let out = [(a[0] + b[0] + c[0]) / 3.0 - centre[0], (a[1] + b[1] + c[1]) / 3.0 - centre[1]];
                assert!(out[0] * n[0] + out[1] * n[1] > 0.0, "walls face away from the building");
            }
        }
    }

    #[test]
    fn steps_between_roofs_and_grid_edges_get_walls() {
        let mut scene = SceneData::flat(grid(4, 1));
        scene.dsm = vec![6.0, 9.0, 0.0, 0.0];
        let mesh = TwinMesh::build(&scene, None, TwinOptions::default());
        // Roofs and walls are quads of four vertices, after the ground sheet.
        let ground = mesh.kinds.iter().filter(|k| **k == SurfaceKind::Ground).count();
        let walls: Vec<(f32, f32)> = mesh.kinds[ground..]
            .as_chunks::<4>()
            .0
            .iter()
            .zip(mesh.positions[ground..].as_chunks::<4>().0.iter())
            .filter(|(k, _)| k[0] == SurfaceKind::Wall)
            .map(|(_, p)| (p.iter().map(|v| v[2]).fold(f32::MAX, f32::min), p.iter().map(|v| v[2]).fold(f32::MIN, f32::max)))
            .collect();
        // The 6 to 9 step is a wall of exactly that height; it does not reach the ground.
        assert!(walls.contains(&(6.0, 9.0)));
        // West edge of the grid, the 9 m drop to the ground, and the two long sides of each block.
        assert_eq!(walls.len(), 1 + 1 + 1 + 4);
    }

    #[test]
    fn a_diagonal_facade_shades_as_one_plane() {
        // A solid half plane whose edge runs at 45 degrees: a staircase of cell edges.
        let mut scene = SceneData::flat(Grid { width: 40, height: 40, cell_m: 1.0, rotation_deg: 0.0 });
        for row in 0..40 {
            for col in 0..40 {
                if col + row > 40 {
                    scene.dsm[row * 40 + col] = 12.0;
                }
            }
        }
        let mesh = TwinMesh::build(&scene, None, TwinOptions::default());
        // Away from the grid's edges every wall faces up and to the left, not along the grid axes.
        let mut checked = 0;
        for (i, kind) in mesh.kinds.iter().enumerate() {
            let p = mesh.positions[i];
            if *kind == SurfaceKind::Wall && p[0].abs() < 10.0 && p[1].abs() < 10.0 {
                let n = mesh.normals[i];
                let diagonal = std::f32::consts::FRAC_1_SQRT_2;
                assert!((n[0] + diagonal).abs() < 0.1 && (n[1] - diagonal).abs() < 0.1, "{n:?}");
                checked += 1;
            }
        }
        assert!(checked > 20);
    }

    #[test]
    fn the_mesh_follows_the_grid_rotation() {
        let mut scene = SceneData::flat(Grid { width: 10, height: 10, cell_m: 1.0, rotation_deg: 90.0 });
        scene.dsm[0] = 5.0;
        let mesh = TwinMesh::build(&scene, None, TwinOptions::default());
        // With "up" pointing east, the top left corner of the grid is the north-east... of the origin: east 5, north 5.
        assert!((mesh.positions[0][0] - 5.0).abs() < 1e-5 && (mesh.positions[0][1] - 5.0).abs() < 1e-5);
        for n in &mesh.normals {
            assert!((n[0] * n[0] + n[1] * n[1] + n[2] * n[2] - 1.0).abs() < 1e-5);
        }
    }

    #[test]
    fn encodes_to_the_documented_layout() {
        let (scene, ids) = box_scene();
        let mesh = TwinMesh::build(&scene, Some(&ids), TwinOptions::default());
        let bytes = mesh.encode();
        let v = mesh.positions.len();
        assert_eq!(&bytes[0..4], b"MRSM");
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize, v);
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize, mesh.indices.len());
        assert_eq!(f32::from_le_bytes(bytes[20..24].try_into().unwrap()), 10.0);
        assert_eq!(bytes.len(), TWIN_HEADER_LEN + v * 20 + mesh.indices.len() * 4);
        // The first roof vertex: normal straight up, kind roof.
        let roof = mesh.kinds.iter().position(|k| *k == SurfaceKind::Roof).unwrap();
        let at = TWIN_HEADER_LEN + v * 12 + roof * 4;
        assert_eq!(&bytes[at..at + 4], &[0, 0, 127, 1]);
    }

    #[test]
    fn large_grounds_stay_within_the_vertex_budget() {
        let mesh = TwinMesh::build(&SceneData::flat(grid(1000, 600)), None, TwinOptions::default());
        assert!(mesh.positions.len() <= 60_000 + 2_000, "{}", mesh.positions.len());
        assert!((area(&mesh, SurfaceKind::Ground) - 2000.0 * 1200.0).abs() < 1.0);
    }
}
