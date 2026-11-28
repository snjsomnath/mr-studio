//! CPU reference for the sunlight kernel. kernel.wgsl implements the same algorithm.

use super::{Blocks, Ray, BLOCK};
use crate::Scene;

/// Evaluates one sun position for every cell and writes or accumulates into `out` (light)
/// and `tree` (light taken by canopy from cells no building shades).
pub fn march(scene: &Scene, blocks: &Blocks, ray: &Ray, out: &mut [f32], tree: &mut [f32], threads: usize) {
    let width = scene.grid.width as usize;
    let rows_per_chunk = (scene.grid.height as usize).div_ceil(threads.max(1)).max(1);
    std::thread::scope(|scope| {
        let chunks = out.chunks_mut(rows_per_chunk * width).zip(tree.chunks_mut(rows_per_chunk * width));
        for (chunk_index, (chunk, tree_chunk)) in chunks.enumerate() {
            scope.spawn(move || {
                let first_row = chunk_index * rows_per_chunk;
                for (offset, (value, tree_value)) in chunk.iter_mut().zip(tree_chunk.iter_mut()).enumerate() {
                    let row = first_row + offset / width;
                    let col = offset % width;
                    let (light, tree) = cell_light(scene, blocks, ray, col, row);
                    *value = *value * ray.accumulate as f32 + light * ray.weight;
                    *tree_value = *tree_value * ray.accumulate as f32 + tree * ray.weight;
                }
            });
        }
    });
}

/// Light reaching the cell, and the share of light that trees alone took from it.
///
/// The ray rises as it goes, so once it is above the highest point of a block of cells it
/// stays above everything in that block: it jumps to the block's far side instead of
/// visiting each cell (#533). The cells it jumps over could neither shade nor filter it, so
/// the result is the same as walking every step.
pub(super) fn cell_light(scene: &Scene, blocks: &Blocks, ray: &Ray, col: usize, row: usize) -> (f32, f32) {
    let (width, height) = (scene.grid.width as i32, scene.grid.height as i32);
    let mut light = ray.lit;
    if light <= 0.0 {
        return (0.0, 0.0);
    }
    let h0 = scene.dsm[row * width as usize + col];
    let px = col as f32 + 0.5;
    let py = row as f32 + 0.5;
    let mut s = 1u32;
    while s <= ray.max_steps {
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
        let (bx, by) = (cx as u32 / BLOCK, cy as u32 / BLOCK);
        if blocks.top[(by * blocks.width + bx) as usize] <= z {
            s = s.max(exit_step(px, py, ray.dir_col, ray.dir_row, bx, by)).max(s + 1);
            continue;
        }
        let j = (cy * width + cx) as usize;
        if scene.dsm[j] > z + 0.001 {
            return (0.0, 0.0);
        }
        if ray.canopy_t < 1.0 && scene.canopy[j] > 0.0 && z < scene.dtm[j] + scene.canopy[j] {
            light *= ray.canopy_t;
            if light < 0.01 {
                return (0.0, 1.0);
            }
        }
        s += 1;
    }
    (light, 1.0 - light)
}

/// The last step that is surely still inside block (bx, by), one short of where the ray
/// leaves it, so rounding can never jump past a cell outside. kernel.wgsl has the same.
fn exit_step(px: f32, py: f32, dc: f32, dr: f32, bx: u32, by: u32) -> u32 {
    let size = BLOCK;
    let leave = |p: f32, d: f32, b: u32| -> f32 {
        if d > 1e-6 {
            (((b + 1) * size) as f32 - p) / d
        } else if d < -1e-6 {
            (p - (b * size) as f32) / -d
        } else {
            1e9
        }
    };
    let t = leave(px, dc, bx).min(leave(py, dr, by));
    (t.floor() as u32).saturating_sub(1)
}

#[cfg(test)]
mod tests {
    use super::super::{Blocks, Ray};
    use super::*;
    use crate::solar::SunPosition;
    use crate::{Backend, Context};

    /// Every step walked, as before #533.
    fn walk(scene: &Scene, ray: &Ray, col: usize, row: usize) -> (f32, f32) {
        let (width, height) = (scene.grid.width as i32, scene.grid.height as i32);
        let mut light = ray.lit;
        if light <= 0.0 {
            return (0.0, 0.0);
        }
        let h0 = scene.dsm[row * width as usize + col];
        let (px, py) = (col as f32 + 0.5, row as f32 + 0.5);
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
                return (0.0, 0.0);
            }
            if ray.canopy_t < 1.0 && scene.canopy[j] > 0.0 && z < scene.dtm[j] + scene.canopy[j] {
                light *= ray.canopy_t;
                if light < 0.01 {
                    return (0.0, 1.0);
                }
            }
        }
        (light, 1.0 - light)
    }

    /// Jumping over blocks the ray is above gives exactly the light of walking every step (#533).
    #[test]
    fn jumping_over_blocks_changes_no_cell() {
        let ctx = Context::new(Backend::Cpu).unwrap();
        for rotation in [0.0, -92.6, 33.0] {
            let scene = Scene::new(&ctx, crate::testing::town(203, 141, 1.5, rotation), 1).unwrap();
            let blocks = Blocks::new(&scene);
            for altitude in [2.0, 6.0, 15.0, 35.0, 70.0, 89.9] {
                for azimuth in [0.0, 45.0, 90.0, 137.0, 180.0, 225.0, 270.0, 359.0] {
                    for trees in [true, false] {
                        let ray = Ray::new(&scene, SunPosition { azimuth_deg: azimuth, altitude_deg: altitude }, trees, 1.0, false);
                        for row in 0..scene.grid.height as usize {
                            for col in 0..scene.grid.width as usize {
                                assert_eq!(
                                    cell_light(&scene, &blocks, &ray, col, row),
                                    walk(&scene, &ray, col, row),
                                    "cell {col},{row}, sun {azimuth}/{altitude}, rotation {rotation}, trees {trees}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    #[ignore]
    fn timing() {
        let ctx = Context::new(Backend::Cpu).unwrap();
        for side in [1000u32, 2000] {
            let scene = Scene::new(&ctx, crate::testing::town(side, side, 1.0, 0.0), 1).unwrap();
            let blocks = Blocks::new(&scene);
            for (name, alt) in [("noon summer", 55.8), ("winter noon", 8.9), ("low sun", 3.0)] {
                let ray = Ray::new(&scene, SunPosition { azimuth_deg: 160.0, altitude_deg: alt }, true, 1.0, false);
                let t = std::time::Instant::now();
                let mut a = 0.0;
                for row in 0..side as usize {
                    for col in 0..side as usize {
                        a += walk(&scene, &ray, col, row).0;
                    }
                }
                let walked = t.elapsed();
                let t = std::time::Instant::now();
                let mut b = 0.0;
                for row in 0..side as usize {
                    for col in 0..side as usize {
                        b += cell_light(&scene, &blocks, &ray, col, row).0;
                    }
                }
                let jumped = t.elapsed();
                assert_eq!(a, b);
                println!(
                    "TIMING {side} m, {name} ({alt} deg): every step {:.0} ms, jumping {:.0} ms, {:.1}x",
                    walked.as_secs_f64() * 1e3,
                    jumped.as_secs_f64() * 1e3,
                    walked.as_secs_f64() / jumped.as_secs_f64()
                );
            }
        }
    }
}
