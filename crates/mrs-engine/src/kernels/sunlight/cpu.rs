//! CPU reference for the sunlight kernel. kernel.wgsl implements the same algorithm.

use super::Ray;
use crate::Scene;

/// Evaluates one sun position for every cell and writes or accumulates into `out`.
pub fn march(scene: &Scene, ray: &Ray, out: &mut [f32], threads: usize) {
    let width = scene.grid.width as usize;
    let rows_per_chunk = (scene.grid.height as usize).div_ceil(threads.max(1)).max(1);
    std::thread::scope(|scope| {
        for (chunk_index, chunk) in out.chunks_mut(rows_per_chunk * width).enumerate() {
            scope.spawn(move || {
                let first_row = chunk_index * rows_per_chunk;
                for (offset, value) in chunk.iter_mut().enumerate() {
                    let row = first_row + offset / width;
                    let col = offset % width;
                    let light = cell_light(scene, ray, col, row);
                    *value = *value * ray.accumulate as f32 + light * ray.weight;
                }
            });
        }
    });
}

fn cell_light(scene: &Scene, ray: &Ray, col: usize, row: usize) -> f32 {
    let (width, height) = (scene.grid.width as i32, scene.grid.height as i32);
    let mut light = ray.lit;
    if light <= 0.0 {
        return 0.0;
    }
    let h0 = scene.dsm[row * width as usize + col];
    let px = col as f32 + 0.5;
    let py = row as f32 + 0.5;
    for s in 1..=ray.max_steps {
        let fs = s as f32;
        let z = h0 + fs * ray.dz;
        if z > ray.max_height {
            break;
        }
        let cx = (px + fs * ray.dir_col).floor() as i32;
        let cy = (py + fs * ray.dir_row).floor() as i32;
        if cx < 0 || cy < 0 || cx >= width || cy >= height {
            break;
        }
        let j = (cy * width + cx) as usize;
        if scene.dsm[j] > z + 0.001 {
            return 0.0;
        }
        if ray.canopy_t < 1.0 && scene.canopy[j] > 0.0 && z < scene.dtm[j] + scene.canopy[j] {
            light *= ray.canopy_t;
            if light < 0.01 {
                return 0.0;
            }
        }
    }
    light
}
