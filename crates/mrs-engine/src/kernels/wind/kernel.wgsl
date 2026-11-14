// Wind kernel: D2Q9 lattice Boltzmann with two-relaxation-time collision.
// One dispatch advances the lattice by one time step. Must stay in step with
// cpu.rs, which is the reference and explains the algorithm.

struct Pass {
    nx: u32,
    ny: u32,
    // The visible window inside the padded domain.
    x0: u32,
    y0: u32,
    vw: u32,
    vh: u32,
    // 1 to write (u, v, density) of the visible window to `out`.
    write_macros: u32,
    _pad: u32,
    omega_plus: f32,
    omega_minus: f32,
    // Unit vector the wind blows towards, in (column, row).
    wind_x: f32,
    wind_y: f32,
    // Inlet speed in lattice units for the boundary of this step and for the sponge.
    inlet_bc: f32,
    inlet_sponge: f32,
    force_x: f32,
    force_y: f32,
}

@group(0) @binding(0) var<uniform> p: Pass;
// Per cell: bit 0 solid, bits 1-2 edge type, bits 8-23 the eight streaming links.
@group(0) @binding(1) var<storage, read> cells: array<u32>;
// Per cell: sponge strength, canopy drag.
@group(0) @binding(2) var<storage, read> aux: array<f32>;
@group(0) @binding(3) var<storage, read> src: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst: array<f32>;
@group(0) @binding(5) var<storage, read_write> out: array<f32>;

const EX = array<i32, 9>(0, 1, 0, -1, 0, 1, -1, -1, 1);
const EY = array<i32, 9>(0, 0, 1, 0, -1, 1, 1, -1, -1);
const OPP = array<u32, 9>(0u, 3u, 4u, 1u, 2u, 7u, 8u, 5u, 6u);
const W = array<f32, 9>(4.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0);

const SOLID = 1u;
const EDGE_INLET = 1u;
const EDGE_OUTLET = 2u;
const EDGE_SIDE = 3u;
const LINK_PULL = 0u;
const LINK_BOUNCE = 1u;

fn equilibrium(k: u32, r: f32, u: f32, v: f32) -> f32 {
    let cu = f32(EX[k]) * u + f32(EY[k]) * v;
    return W[k] * r * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * (u * u + v * v));
}

// Density and velocity of a set of populations, as (density, u, v).
fn moments(f: array<f32, 9>) -> vec3<f32> {
    var r = 0.0;
    var mx = 0.0;
    var my = 0.0;
    for (var k = 0u; k < 9u; k++) {
        r += f[k];
        mx += f32(EX[k]) * f[k];
        my += f32(EY[k]) * f[k];
    }
    return vec3<f32>(r, mx / r, my / r);
}

fn pull(x: i32, y: i32, cell: u32) -> array<f32, 9> {
    let nx = i32(p.nx);
    let ny = i32(p.ny);
    let base = u32(y * nx + x) * 9u;
    var f: array<f32, 9>;
    f[0] = src[base];
    for (var k = 1u; k < 9u; k++) {
        let link = (cell >> (6u + 2u * k)) & 3u;
        if (link == LINK_PULL) {
            let sx = (x - EX[k] + nx) % nx;
            let sy = (y - EY[k] + ny) % ny;
            f[k] = src[u32(sy * nx + sx) * 9u + k];
        } else if (link == LINK_BOUNCE) {
            f[k] = src[base + OPP[k]];
        } else {
            f[k] = 0.0;
        }
    }
    return f;
}

fn open_edge(x: i32, y: i32, edge: u32) -> array<f32, 9> {
    let sx = clamp(x, 1, i32(p.nx) - 2);
    let sy = clamp(y, 1, i32(p.ny) - 2);
    let source = cells[u32(sy * i32(p.nx) + sx)];
    let blocked = (source & SOLID) != 0u;
    var g: array<f32, 9>;
    if (!blocked) {
        g = pull(sx, sy, source);
    }
    if (edge == EDGE_SIDE && !blocked) {
        return g;
    }
    var m = vec3<f32>(1.0, p.wind_x * p.inlet_bc, p.wind_y * p.inlet_bc);
    if (!blocked) {
        m = moments(g);
    }
    var target_r = m.x;
    if (edge == EDGE_OUTLET) {
        target_r = 1.0;
    }
    var target_u = m.y;
    var target_v = m.z;
    if (edge == EDGE_INLET) {
        target_u = p.wind_x * p.inlet_bc;
        target_v = p.wind_y * p.inlet_bc;
    }
    var f: array<f32, 9>;
    for (var k = 0u; k < 9u; k++) {
        f[k] = equilibrium(k, target_r, target_u, target_v);
        if (!blocked) {
            f[k] += g[k] - equilibrium(k, m.x, m.y, m.z);
        }
    }
    return f;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.nx || id.y >= p.ny) {
        return;
    }
    let n = id.y * p.nx + id.x;
    let cell = cells[n];
    let visible = p.write_macros != 0u && id.x >= p.x0 && id.x < p.x0 + p.vw && id.y >= p.y0 && id.y < p.y0 + p.vh;
    let slot = ((id.y - p.y0) * p.vw + (id.x - p.x0)) * 3u;
    if ((cell & SOLID) != 0u) {
        if (visible) {
            out[slot] = 0.0;
            out[slot + 1u] = 0.0;
            out[slot + 2u] = 1.0;
        }
        return;
    }

    let x = i32(id.x);
    let y = i32(id.y);
    let edge = (cell >> 1u) & 3u;
    var f: array<f32, 9>;
    if (edge != 0u) {
        f = open_edge(x, y, edge);
    } else {
        f = pull(x, y, cell);
    }
    let m = moments(f);
    let r = m.x;
    let u = m.y;
    let v = m.z;
    if (visible) {
        out[slot] = u;
        out[slot + 1u] = v;
        out[slot + 2u] = r;
    }

    // Collision, forcing and sponge.
    let sponge = aux[n * 2u];
    let drag = aux[n * 2u + 1u];
    let u2 = u * u + v * v;
    var retention = 1.0;
    if (drag > 0.0) {
        retention = exp(-drag * sqrt(u2));
    }
    let du = u * (retention - 1.0) + p.force_x;
    let dv = v * (retention - 1.0) + p.force_y;
    let forced = du != 0.0 || dv != 0.0;
    let new_u2 = (u + du) * (u + du) + (v + dv) * (v + dv);
    let base = n * 9u;
    for (var k = 0u; k < 9u; k++) {
        let cu = f32(EX[k]) * u + f32(EY[k]) * v;
        let wr = W[k] * r;
        let eq_plus = wr * (1.0 + 4.5 * cu * cu - 1.5 * u2);
        let eq_minus = wr * 3.0 * cu;
        let fk = f[k];
        let fo = f[OPP[k]];
        var value = fk - p.omega_plus * (0.5 * (fk + fo) - eq_plus) - p.omega_minus * (0.5 * (fk - fo) - eq_minus);
        if (forced) {
            let new_cu = cu + f32(EX[k]) * du + f32(EY[k]) * dv;
            value += wr * (3.0 * (new_cu - cu) + 4.5 * (new_cu * new_cu - cu * cu) - 1.5 * (new_u2 - u2));
        }
        if (sponge > 0.0) {
            value = value * (1.0 - sponge) + sponge * equilibrium(k, 1.0, p.wind_x * p.inlet_sponge, p.wind_y * p.inlet_sponge);
        }
        dst[base + k] = value;
    }
}
