//! Synthetic scenes for tests and benchmarks.

use crate::{Grid, SceneData};

/// A deterministic town: a sloping ground, box buildings on a street grid and a few trees.
pub fn town(width: u32, height: u32, cell_m: f32, rotation_deg: f32) -> SceneData {
    let grid = Grid { width, height, cell_m, rotation_deg };
    let mut scene = SceneData::flat(grid);
    let mut seed = 0x2545_f491u32;
    let mut rand = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as f32 / u32::MAX as f32
    };
    for row in 0..height {
        for col in 0..width {
            let i = (row * width + col) as usize;
            scene.dtm[i] = 0.01 * col as f32 * cell_m + 2.0 * ((row as f32 * cell_m) / 90.0).sin();
            scene.dsm[i] = scene.dtm[i];
        }
    }
    // Blocks of 40 m with 16 m streets.
    let block = (40.0 / cell_m).max(2.0) as u32;
    let pitch = block + (16.0 / cell_m).max(1.0) as u32;
    let mut by = pitch / 3;
    while by + block < height {
        let mut bx = pitch / 3;
        while bx + block < width {
            let roll = rand();
            if roll < 0.15 {
                // A small park: trees instead of a building.
                for _ in 0..6 {
                    let (cx, cy) = (bx + (rand() * block as f32) as u32, by + (rand() * block as f32) as u32);
                    let radius = (3.0 / cell_m).max(1.0) as i32;
                    let tree = 6.0 + rand() * 10.0;
                    for dy in -radius..=radius {
                        for dx in -radius..=radius {
                            let (x, y) = (cx as i32 + dx, cy as i32 + dy);
                            if dx * dx + dy * dy <= radius * radius && x >= 0 && y >= 0 && (x as u32) < width && (y as u32) < height {
                                let i = (y as u32 * width + x as u32) as usize;
                                scene.canopy[i] = scene.canopy[i].max(tree);
                            }
                        }
                    }
                }
            } else {
                let roof = 6.0 + rand() * 30.0;
                let base = scene.dtm[(by * width + bx) as usize];
                for y in by..by + block {
                    for x in bx..bx + block {
                        scene.dsm[(y * width + x) as usize] = base + roof;
                    }
                }
            }
            bx += pitch;
        }
        by += pitch;
    }
    scene
}
