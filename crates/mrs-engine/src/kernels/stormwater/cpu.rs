//! CPU reference for the stormwater kernel. `kernel.wgsl` must stay in step with it.
//!
//! The model is the local inertial form of the shallow water equations
//! (Bates, Horritt and Fewtrell 2010, the scheme behind LISFLOOD-FP): water
//! depth lives on cells, discharge per unit width lives on the faces between
//! them, and one step is two passes.
//!
//! 1. Faces: each cell updates the discharge through its east and south faces
//!    from the water-surface slope across the face, with Manning friction
//!    applied semi-implicitly so thin sheets of water stay slow and stable.
//!    The flow depth on a face is the water above the higher of the two beds,
//!    so water never climbs a kerb it does not reach over. Outflow through a
//!    face is limited to a quarter of the upstream cell's water per step, which
//!    keeps every depth non-negative and the scheme mass-conserving.
//! 2. Cells: each cell adds its rain, the net inflow through its four faces and
//!    loses what infiltrates. It writes depth and velocity for the visible window.
//!
//! Buildings are walls. The lattice has a ring of outfall cells around the site
//! that always stay dry, so water reaching the edge drains away off the table.

use super::{Pass, OUTFALL, SOLID};

/// Water shallower than this on a face does not flow.
pub const H_FLOW: f32 = 1e-3;
/// Water shallower than this in a cell reports no velocity.
pub const H_VELOCITY: f32 = 5e-3;
/// Velocities are clamped to this, in m/s.
pub const V_MAX: f32 = 6.0;

/// The fixed data of one lattice.
pub struct Lattice<'a> {
    pub nx: usize,
    pub ny: usize,
    /// Per cell: `SOLID`, `OUTFALL` or 0.
    pub cells: &'a [u32],
    /// Bed elevation per cell, metres.
    pub bed: &'a [f32],
    /// Per cell: rain multiplier (1 plus the roof cells draining into it), infiltration multiplier.
    pub aux: &'a [f32],
}

/// The discharge through one face, per unit width, from the cell `a` towards the cell `b`.
#[inline]
pub fn face(lat: &Lattice, p: &Pass, h: &[f32], q: f32, a: usize, b: usize) -> f32 {
    if (lat.cells[a] | lat.cells[b]) & SOLID != 0 || lat.cells[a] & lat.cells[b] & OUTFALL != 0 {
        return 0.0;
    }
    let (za, zb) = (lat.bed[a], lat.bed[b]);
    let (ea, eb) = (za + h[a], zb + h[b]);
    let depth = ea.max(eb) - za.max(zb);
    if depth <= H_FLOW {
        return 0.0;
    }
    let slope = (eb - ea) / p.cell_m;
    let friction = 1.0 + p.g * p.dt * p.manning2 * q.abs() / depth.powf(7.0 / 3.0);
    let next = (q - p.g * depth * p.dt * slope) / friction;
    // A face may take at most a quarter of the upstream cell's water in one step.
    let limit = p.cell_m / (4.0 * p.dt);
    if next > 0.0 {
        next.min(h[a] * limit)
    } else {
        next.max(-h[b] * limit)
    }
}

/// Pass 1: discharge through every cell's east (`qx`) and south (`qy`) face.
pub fn faces(lat: &Lattice, p: &Pass, h: &[f32], qx: &mut [f32], qy: &mut [f32], threads: usize) {
    let nx = lat.nx;
    let run = |first_row: usize, qx: &mut [f32], qy: &mut [f32]| {
        for offset in 0..qx.len() {
            let (x, y) = (offset % nx, first_row + offset / nx);
            let c = y * nx + x;
            qx[offset] = if x + 1 < nx { face(lat, p, h, qx[offset], c, c + 1) } else { 0.0 };
            qy[offset] = if y + 1 < lat.ny { face(lat, p, h, qy[offset], c, c + nx) } else { 0.0 };
        }
    };
    split_rows(lat, threads, qx, qy, &run);
}

/// Pass 2: new depths, and (u, v, depth) of the visible window into `out`.
#[allow(clippy::too_many_arguments)]
pub fn cells(lat: &Lattice, p: &Pass, h: &mut [f32], qx: &[f32], qy: &[f32], out: &mut [f32], threads: usize) {
    let (nx, ny) = (lat.nx, lat.ny);
    let (vw, vh) = (nx - 2, ny - 2);
    let run = |first_row: usize, h: &mut [f32], out: &mut [f32]| {
        let out_first = first_row.max(1);
        for (offset, depth) in h.iter_mut().enumerate() {
            let (x, y) = (offset % nx, first_row + offset / nx);
            let c = y * nx + x;
            let visible = x >= 1 && x <= vw && y >= 1 && y <= vh;
            let flags = lat.cells[c];
            let (mut u, mut v) = (0.0, 0.0);
            if flags & (SOLID | OUTFALL) != 0 {
                *depth = 0.0;
            } else {
                let west = if x > 0 { qx[c - 1] } else { 0.0 };
                let north = if y > 0 { qy[c - nx] } else { 0.0 };
                let inflow = west - qx[c] + north - qy[c];
                let wet = *depth + p.dt * p.rain * lat.aux[c * 2] + p.dt * inflow / p.cell_m;
                *depth = (wet - p.dt * p.infiltration * lat.aux[c * 2 + 1]).max(0.0);
                if *depth > H_VELOCITY {
                    u = (0.5 * (west + qx[c]) / *depth).clamp(-V_MAX, V_MAX);
                    v = (0.5 * (north + qy[c]) / *depth).clamp(-V_MAX, V_MAX);
                }
            }
            if visible {
                let slot = ((y - out_first) * vw + (x - 1)) * 3;
                out[slot] = u;
                out[slot + 1] = v;
                out[slot + 2] = *depth;
            }
        }
    };
    // Small lattices are faster on one thread than the cost of starting several.
    let threads = if nx * ny < 16_384 { 1 } else { threads.clamp(1, ny) };
    if threads == 1 {
        run(0, h, out);
        return;
    }
    let rows_per_chunk = ny.div_ceil(threads);
    std::thread::scope(|scope| {
        let mut out_rest = out;
        for (chunk_index, chunk) in h.chunks_mut(rows_per_chunk * nx).enumerate() {
            let first_row = chunk_index * rows_per_chunk;
            let last_row = first_row + chunk.len() / nx;
            let visible_rows = last_row.min(1 + vh).saturating_sub(first_row.max(1));
            let (mine, rest) = std::mem::take(&mut out_rest).split_at_mut(visible_rows * vw * 3);
            out_rest = rest;
            let run = &run;
            scope.spawn(move || run(first_row, chunk, mine));
        }
    });
}

/// Runs `run(first_row, a_chunk, b_chunk)` over row bands of two equally sized per-cell arrays.
fn split_rows<F>(lat: &Lattice, threads: usize, a: &mut [f32], b: &mut [f32], run: &F)
where
    F: Fn(usize, &mut [f32], &mut [f32]) + Sync,
{
    let (nx, ny) = (lat.nx, lat.ny);
    let threads = if nx * ny < 16_384 { 1 } else { threads.clamp(1, ny) };
    if threads == 1 {
        run(0, a, b);
        return;
    }
    let rows_per_chunk = ny.div_ceil(threads);
    std::thread::scope(|scope| {
        for (chunk_index, (ca, cb)) in a.chunks_mut(rows_per_chunk * nx).zip(b.chunks_mut(rows_per_chunk * nx)).enumerate() {
            scope.spawn(move || run(chunk_index * rows_per_chunk, ca, cb));
        }
    });
}
