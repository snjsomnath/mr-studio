//! CPU reference for the wind kernel. kernel.wgsl implements the same algorithm,
//! cell for cell; keep the two in step.
//!
//! One pass advances the whole lattice by one time step. For every fluid cell it
//! pulls the populations that stream into the cell, applies the open boundary on
//! edge cells, takes the density and velocity, collides, and writes the result to
//! the other buffer. The buffers therefore hold post-collision populations.

use super::{Pass, EDGE_INLET, EDGE_OUTLET, EDGE_SIDE, LINK_BOUNCE, LINK_PULL, SOLID};

pub const EX: [i32; 9] = [0, 1, 0, -1, 0, 1, -1, -1, 1];
pub const EY: [i32; 9] = [0, 0, 1, 0, -1, 1, 1, -1, -1];
pub const OPP: [usize; 9] = [0, 3, 4, 1, 2, 7, 8, 5, 6];
pub const W: [f32; 9] = [4.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0];

/// The fixed geometry a pass reads.
pub struct Lattice<'a> {
    pub nx: usize,
    pub ny: usize,
    /// Per cell: solid flag, edge type and the eight streaming links. Layout in mod.rs.
    pub cells: &'a [u32],
    /// Per cell: sponge strength, canopy drag.
    pub aux: &'a [f32],
}

#[inline]
fn equilibrium(k: usize, r: f32, u: f32, v: f32) -> f32 {
    let cu = EX[k] as f32 * u + EY[k] as f32 * v;
    W[k] * r * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * (u * u + v * v))
}

/// Density and velocity of a set of populations.
#[inline]
fn moments(f: &[f32; 9]) -> (f32, f32, f32) {
    let (mut r, mut mx, mut my) = (0.0f32, 0.0f32, 0.0f32);
    for k in 0..9 {
        r += f[k];
        mx += EX[k] as f32 * f[k];
        my += EY[k] as f32 * f[k];
    }
    (r, mx / r, my / r)
}

/// The populations that stream into cell (x, y): from the neighbour, reflected
/// off a wall halfway to it, or nothing from outside an open domain.
#[inline]
fn pull(lat: &Lattice, src: &[f32], x: usize, y: usize, cell: u32) -> [f32; 9] {
    let base = (y * lat.nx + x) * 9;
    let mut f = [0.0f32; 9];
    f[0] = src[base];
    for k in 1..9 {
        let link = (cell >> (6 + 2 * k)) & 3;
        f[k] = if link == LINK_PULL {
            // Wrapping is the identity inside the domain and the periodic image on its border.
            let sx = (x as i32 - EX[k] + lat.nx as i32) as usize % lat.nx;
            let sy = (y as i32 - EY[k] + lat.ny as i32) as usize % lat.ny;
            src[(sy * lat.nx + sx) * 9 + k]
        } else if link == LINK_BOUNCE {
            src[base + OPP[k]]
        } else {
            0.0
        };
    }
    f
}

/// Two-relaxation-time collision with exact-difference forcing for canopy drag
/// and the body force, then the far-field sponge.
#[inline]
fn collide(p: &Pass, f: &[f32; 9], r: f32, u: f32, v: f32, sponge: f32, drag: f32) -> [f32; 9] {
    let u2 = u * u + v * v;
    let retention = if drag > 0.0 { (-drag * u2.sqrt()).exp() } else { 1.0 };
    let du = u * (retention - 1.0) + p.force_x;
    let dv = v * (retention - 1.0) + p.force_y;
    let forced = du != 0.0 || dv != 0.0;
    let new_u2 = (u + du) * (u + du) + (v + dv) * (v + dv);
    let mut post = [0.0f32; 9];
    for k in 0..9 {
        let cu = EX[k] as f32 * u + EY[k] as f32 * v;
        let wr = W[k] * r;
        let eq_plus = wr * (1.0 + 4.5 * cu * cu - 1.5 * u2);
        let eq_minus = wr * 3.0 * cu;
        let (fk, fo) = (f[k], f[OPP[k]]);
        let mut value = fk - p.omega_plus * (0.5 * (fk + fo) - eq_plus) - p.omega_minus * (0.5 * (fk - fo) - eq_minus);
        if forced {
            let new_cu = cu + EX[k] as f32 * du + EY[k] as f32 * dv;
            value += wr * (3.0 * (new_cu - cu) + 4.5 * (new_cu * new_cu - cu * cu) - 1.5 * (new_u2 - u2));
        }
        if sponge > 0.0 {
            value = value * (1.0 - sponge) + sponge * equilibrium(k, 1.0, p.wind_x * p.inlet_sponge, p.wind_y * p.inlet_sponge);
        }
        post[k] = value;
    }
    post
}

/// The populations of a cell on the edge of an open domain, from the interior cell next to it.
#[inline]
fn open_edge(lat: &Lattice, p: &Pass, src: &[f32], x: usize, y: usize, edge: u32) -> [f32; 9] {
    // Corners move inward on both axes.
    let sx = x.clamp(1, lat.nx - 2);
    let sy = y.clamp(1, lat.ny - 2);
    let source = lat.cells[sy * lat.nx + sx];
    let blocked = source & SOLID != 0;
    let g = if blocked { [0.0; 9] } else { pull(lat, src, sx, sy, source) };
    if edge == EDGE_SIDE && !blocked {
        // Sides parallel to the wind let deflected air leave; they are not walls.
        return g;
    }
    let (r, u, v) = if blocked { (1.0, p.wind_x * p.inlet_bc, p.wind_y * p.inlet_bc) } else { moments(&g) };
    let target_r = if edge == EDGE_OUTLET { 1.0 } else { r };
    let (target_u, target_v) = if edge == EDGE_INLET { (p.wind_x * p.inlet_bc, p.wind_y * p.inlet_bc) } else { (u, v) };
    // Non-equilibrium extrapolation: the inlet fixes velocity, the outlet fixes density.
    let mut f = [0.0f32; 9];
    for k in 0..9 {
        f[k] = equilibrium(k, target_r, target_u, target_v);
        if !blocked {
            f[k] += g[k] - equilibrium(k, r, u, v);
        }
    }
    f
}

/// One cell of one pass. Returns the post-collision populations and (density, u, v),
/// or `None` for a solid cell.
#[inline]
fn update(lat: &Lattice, p: &Pass, src: &[f32], x: usize, y: usize) -> Option<([f32; 9], f32, f32, f32)> {
    let n = y * lat.nx + x;
    let cell = lat.cells[n];
    if cell & SOLID != 0 {
        return None;
    }
    let edge = (cell >> 1) & 3;
    let f = if edge != 0 { open_edge(lat, p, src, x, y, edge) } else { pull(lat, src, x, y, cell) };
    let (r, u, v) = moments(&f);
    Some((collide(p, &f, r, u, v, lat.aux[n * 2], lat.aux[n * 2 + 1]), r, u, v))
}

/// Writes (u, v, density) of a visible cell.
#[inline]
fn write_macros(out: &mut [f32], u: f32, v: f32, r: f32) {
    out[0] = u;
    out[1] = v;
    out[2] = r;
}

/// Advances the lattice by one step: reads `src`, writes `dst`, and writes the
/// macroscopic values of the visible window to `out` when the pass asks for them.
pub fn step(lat: &Lattice, p: &Pass, src: &[f32], dst: &mut [f32], out: &mut [f32], threads: usize) {
    let (nx, ny) = (lat.nx, lat.ny);
    let (x0, y0, vw, vh) = (p.x0 as usize, p.y0 as usize, p.vw as usize, p.vh as usize);
    // Small lattices are faster on one thread than the cost of starting several.
    let threads = if nx * ny < 16_384 { 1 } else { threads.clamp(1, ny) };
    let rows_per_chunk = ny.div_ceil(threads);
    let run = |first_row: usize, dst: &mut [f32], out: &mut [f32]| {
        // `out` starts at the first visible row of this chunk.
        let out_first = first_row.max(y0);
        for (offset, cell) in dst.as_chunks_mut::<9>().0.iter_mut().enumerate() {
            let (x, y) = (offset % nx, first_row + offset / nx);
            let visible = p.write_macros != 0 && x >= x0 && x < x0 + vw && y >= y0 && y < y0 + vh;
            let slot = if visible { ((y - out_first) * vw + (x - x0)) * 3 } else { 0 };
            match update(lat, p, src, x, y) {
                Some((post, r, u, v)) => {
                    cell.copy_from_slice(&post);
                    if visible {
                        write_macros(&mut out[slot..slot + 3], u, v, r);
                    }
                }
                None if visible => write_macros(&mut out[slot..slot + 3], 0.0, 0.0, 1.0),
                None => {}
            }
        }
    };
    if threads == 1 {
        run(0, dst, out);
        return;
    }
    std::thread::scope(|scope| {
        let mut out_rest = out;
        for (chunk_index, chunk) in dst.chunks_mut(rows_per_chunk * nx * 9).enumerate() {
            let first_row = chunk_index * rows_per_chunk;
            let last_row = first_row + chunk.len() / (nx * 9);
            let visible_rows = last_row.min(y0 + vh).saturating_sub(first_row.max(y0));
            let (mine, rest) = std::mem::take(&mut out_rest).split_at_mut(visible_rows * vw * 3);
            out_rest = rest;
            let run = &run;
            scope.spawn(move || run(first_row, chunk, mine));
        }
    });
}

/// Fills `dst` and `out` for step 0: every fluid cell at equilibrium with the
/// velocity (u0, v0), already collided so the first pass can stream it.
pub fn initialise(lat: &Lattice, p: &Pass, u0: f32, v0: f32, dst: &mut [f32], out: &mut [f32]) {
    let mut f = [0.0f32; 9];
    for (k, value) in f.iter_mut().enumerate() {
        *value = equilibrium(k, 1.0, u0, v0);
    }
    let (r, u, v) = moments(&f);
    let (x0, y0, vw, vh) = (p.x0 as usize, p.y0 as usize, p.vw as usize, p.vh as usize);
    for y in 0..lat.ny {
        for x in 0..lat.nx {
            let n = y * lat.nx + x;
            let solid = lat.cells[n] & SOLID != 0;
            if !solid {
                dst[n * 9..n * 9 + 9].copy_from_slice(&collide(p, &f, r, u, v, lat.aux[n * 2], lat.aux[n * 2 + 1]));
            }
            if x >= x0 && x < x0 + vw && y >= y0 && y < y0 + vh {
                let slot = ((y - y0) * vw + (x - x0)) * 3;
                if solid {
                    write_macros(&mut out[slot..slot + 3], 0.0, 0.0, 1.0);
                } else {
                    write_macros(&mut out[slot..slot + 3], u, v, r);
                }
            }
        }
    }
}
