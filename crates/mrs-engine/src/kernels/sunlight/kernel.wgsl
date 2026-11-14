// Sunlight kernel: march a ray from each cell's top surface towards the sun
// across the dsm. Must stay in step with cpu.rs, which is the reference.

struct Params {
    width: u32,
    height: u32,
    max_steps: u32,
    // 1 to add to the output, 0 to overwrite it.
    accumulate: u32,
    // Ray step in cells per step, and its rise in metres per step.
    dir_col: f32,
    dir_row: f32,
    dz: f32,
    max_height: f32,
    // Contribution of a fully lit cell.
    weight: f32,
    // Light kept per step through tree canopy, 1 to ignore trees.
    canopy_t: f32,
    // 1 when the sun is up, 0 otherwise.
    lit: f32,
    _pad: f32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> dsm: array<f32>;
@group(0) @binding(2) var<storage, read> dtm: array<f32>;
@group(0) @binding(3) var<storage, read> canopy: array<f32>;
@group(0) @binding(4) var<storage, read_write> out: array<f32>;
// Light taken by tree canopy from cells no building shades.
@group(0) @binding(5) var<storage, read_write> tree_out: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.width || id.y >= p.height) {
        return;
    }
    let i = id.y * p.width + id.x;
    var light = p.lit;
    var blocked = false;
    if (light > 0.0) {
        let h0 = dsm[i];
        let px = f32(id.x) + 0.5;
        let py = f32(id.y) + 0.5;
        for (var s = 1u; s <= p.max_steps; s++) {
            let fs = f32(s);
            let z = h0 + fs * p.dz;
            if (z > p.max_height) {
                break;
            }
            let cx = i32(floor(px + fs * p.dir_col));
            let cy = i32(floor(py + fs * p.dir_row));
            if (cx < 0 || cy < 0 || cx >= i32(p.width) || cy >= i32(p.height)) {
                break;
            }
            let j = u32(cy) * p.width + u32(cx);
            if (dsm[j] > z + 0.001) {
                light = 0.0;
                blocked = true;
                break;
            }
            if (p.canopy_t < 1.0 && canopy[j] > 0.0 && z < dtm[j] + canopy[j]) {
                light = light * p.canopy_t;
                if (light < 0.01) {
                    light = 0.0;
                    break;
                }
            }
        }
    }
    var tree = 0.0;
    if (p.lit > 0.0 && !blocked) {
        tree = 1.0 - light;
    }
    out[i] = out[i] * f32(p.accumulate) + light * p.weight;
    tree_out[i] = tree_out[i] * f32(p.accumulate) + tree * p.weight;
}
