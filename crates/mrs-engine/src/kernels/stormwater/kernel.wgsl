// Stormwater kernel: local inertial shallow water, rain, infiltration.
// One step is a dispatch of `faces` then a dispatch of `cells`. Must stay in
// step with cpu.rs, which is the reference and explains the algorithm.

struct Pass {
    nx: u32,
    ny: u32,
    dt: f32,
    g: f32,
    cell_m: f32,
    rain: f32,
    pad0: f32,
    pad1: f32,
}

@group(0) @binding(0) var<uniform> p: Pass;
// Per cell: bit 0 solid, bit 1 outfall.
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> bed: array<f32>;
// Per cell: rain multiplier, loss rate (m/s: soaking in plus drains), Manning n squared.
@group(0) @binding(3) var<storage, read> aux: array<f32>;
@group(0) @binding(4) var<storage, read_write> h: array<f32>;
@group(0) @binding(5) var<storage, read_write> qx: array<f32>;
@group(0) @binding(6) var<storage, read_write> qy: array<f32>;
// (u, v, depth) of the visible window: the lattice without its outfall ring.
@group(0) @binding(7) var<storage, read_write> out: array<f32>;

const SOLID = 1u;
const OUTFALL = 2u;
const H_FLOW = 1e-3;
const H_VELOCITY = 5e-3;
const V_MAX = 6.0;

fn face(q: f32, a: u32, b: u32) -> f32 {
    if (((flags[a] | flags[b]) & SOLID) != 0u || (flags[a] & flags[b] & OUTFALL) != 0u) {
        return 0.0;
    }
    let za = bed[a];
    let zb = bed[b];
    let ea = za + h[a];
    let eb = zb + h[b];
    let depth = max(ea, eb) - max(za, zb);
    if (depth <= H_FLOW) {
        return 0.0;
    }
    let slope = (eb - ea) / p.cell_m;
    let manning2 = max(aux[a * 3u + 2u], aux[b * 3u + 2u]);
    let friction = 1.0 + p.g * p.dt * manning2 * abs(q) / pow(depth, 7.0 / 3.0);
    let next = (q - p.g * depth * p.dt * slope) / friction;
    let limit = p.cell_m / (4.0 * p.dt);
    if (next > 0.0) {
        return min(next, h[a] * limit);
    }
    return max(next, -h[b] * limit);
}

@compute @workgroup_size(8, 8)
fn faces(@builtin(global_invocation_id) id: vec3<u32>) {
    let x = id.x;
    let y = id.y;
    if (x >= p.nx || y >= p.ny) {
        return;
    }
    let c = y * p.nx + x;
    var east = 0.0;
    if (x + 1u < p.nx) {
        east = face(qx[c], c, c + 1u);
    }
    var south = 0.0;
    if (y + 1u < p.ny) {
        south = face(qy[c], c, c + p.nx);
    }
    qx[c] = east;
    qy[c] = south;
}

@compute @workgroup_size(8, 8)
fn cells(@builtin(global_invocation_id) id: vec3<u32>) {
    let x = id.x;
    let y = id.y;
    if (x >= p.nx || y >= p.ny) {
        return;
    }
    let c = y * p.nx + x;
    var depth = 0.0;
    var u = 0.0;
    var v = 0.0;
    if ((flags[c] & (SOLID | OUTFALL)) == 0u) {
        var west = 0.0;
        if (x > 0u) {
            west = qx[c - 1u];
        }
        var north = 0.0;
        if (y > 0u) {
            north = qy[c - p.nx];
        }
        let inflow = west - qx[c] + north - qy[c];
        let wet = h[c] + p.dt * p.rain * aux[c * 3u] + p.dt * inflow / p.cell_m;
        depth = max(wet - p.dt * aux[c * 3u + 1u], 0.0);
        if (depth > H_VELOCITY) {
            u = clamp(0.5 * (west + qx[c]) / depth, -V_MAX, V_MAX);
            v = clamp(0.5 * (north + qy[c]) / depth, -V_MAX, V_MAX);
        }
    }
    h[c] = depth;
    let vw = p.nx - 2u;
    if (x >= 1u && x <= vw && y >= 1u && y <= p.ny - 2u) {
        let slot = ((y - 1u) * vw + (x - 1u)) * 3u;
        out[slot] = u;
        out[slot + 1u] = v;
        out[slot + 2u] = depth;
    }
}
