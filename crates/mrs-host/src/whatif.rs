//! What-if changes to the scene (#500): buildings and trees added or taken away from a phone, laid over
//! the baked scene while a layer asks for them. Nothing is saved; an empty list gives the baked scene back.
//!
//! The changes come in WGS84 from the table (`engine.edit`) and are drawn onto a copy of the scene's
//! surface and canopy grids, so every kernel sees them.

use std::collections::VecDeque;

use mrs_engine::SceneData;
use mrs_site::{LonLat, Projection};
use serde::Deserialize;

/// Above this, a cell's surface over the ground is a building (or a wall, a bridge) that a tap removes.
const BUILDING_M: f32 = 2.0;
/// The most cells one removal may lower, so a tap on a continuous block or a bridge stays local.
const MAX_REMOVE_CELLS: usize = 200_000;
/// The largest what-if change list the host takes.
pub const MAX_EDITS: usize = 200;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SceneEdit {
    /// A new building: its outline (WGS84 [lon, lat], closed or not) and its height over the ground.
    Building { outline: Vec<[f64; 2]>, height_m: f32 },
    /// A new tree: its trunk, the radius of its crown and its height.
    Tree { at: [f64; 2], radius_m: f32, height_m: f32 },
    /// Takes away the building under a point, or the tree canopy there when there is no building.
    Remove { at: [f64; 2] },
}

impl SceneEdit {
    /// Rejects values that can't be drawn, so a bad request is an error instead of a broken scene.
    pub fn check(&self) -> Result<(), String> {
        let finite = |p: &[f64; 2]| p[0].is_finite() && p[1].is_finite() && p[0].abs() <= 180.0 && p[1].abs() <= 90.0;
        match self {
            SceneEdit::Building { outline, height_m } => {
                if outline.len() < 3 || !outline.iter().all(finite) {
                    return Err("a building needs an outline of at least three [lon, lat] points".into());
                }
                if !(0.5..=400.0).contains(height_m) {
                    return Err("a building's height must be between 0.5 and 400 m".into());
                }
            }
            SceneEdit::Tree { at, radius_m, height_m } => {
                if !finite(at) {
                    return Err("a tree needs a place as [lon, lat]".into());
                }
                if !(0.5..=30.0).contains(radius_m) || !(1.0..=60.0).contains(height_m) {
                    return Err("a tree's crown must be 0.5 to 30 m across and 1 to 60 m tall".into());
                }
            }
            SceneEdit::Remove { at } => {
                if !finite(at) {
                    return Err("a removal needs a place as [lon, lat]".into());
                }
            }
        }
        Ok(())
    }
}

/// The scene with the changes laid over it, in order.
pub fn apply(base: &SceneData, edits: &[SceneEdit], origin: LonLat) -> SceneData {
    let mut scene = base.clone();
    if edits.is_empty() {
        return scene;
    }
    let projection = Projection::new(origin);
    let cell = |lon: f64, lat: f64| {
        let (east, north) = projection.to_local(lon, lat);
        scene.grid.local_to_cell(east, north)
    };
    let (width, height) = (scene.grid.width as usize, scene.grid.height as usize);
    for edit in edits {
        match edit {
            SceneEdit::Building { outline, height_m } => {
                let ring: Vec<(f64, f64)> = outline.iter().map(|p| cell(p[0], p[1])).collect();
                for_cells_in(&ring, width, height, |i| {
                    scene.dsm[i] = scene.dsm[i].max(scene.dtm[i] + height_m);
                    scene.canopy[i] = 0.0;
                });
            }
            SceneEdit::Tree { at, radius_m, height_m } => {
                let (col, row) = cell(at[0], at[1]);
                let r = (*radius_m / scene.grid.cell_m) as f64;
                let (c0, c1) = (((col - r).floor().max(0.0)) as usize, ((col + r).ceil().max(0.0) as usize).min(width));
                let (r0, r1) = (((row - r).floor().max(0.0)) as usize, ((row + r).ceil().max(0.0) as usize).min(height));
                for y in r0..r1 {
                    for x in c0..c1 {
                        let (dx, dy) = (x as f64 + 0.5 - col, y as f64 + 0.5 - row);
                        let i = y * width + x;
                        // A crown, highest at the trunk; a tree on a roof is not planted.
                        let d = (dx * dx + dy * dy).sqrt() / r;
                        if d <= 1.0 && scene.dsm[i] - scene.dtm[i] < BUILDING_M {
                            let top = height_m * (1.0 - 0.35 * d * d) as f32;
                            scene.canopy[i] = scene.canopy[i].max(top);
                        }
                    }
                }
            }
            SceneEdit::Remove { at } => {
                let (col, row) = cell(at[0], at[1]);
                if !(0.0..width as f64).contains(&col) || !(0.0..height as f64).contains(&row) {
                    continue;
                }
                let start = row as usize * width + col as usize;
                let raised = |s: &SceneData, i: usize| s.dsm[i] - s.dtm[i] >= BUILDING_M;
                if raised(&scene, start) {
                    for i in flood(start, width, height, |i| raised(&scene, i)) {
                        scene.dsm[i] = scene.dtm[i];
                    }
                } else {
                    // The nearest canopy within a few metres: a tap rarely lands on the crown's middle.
                    let reach = (4.0 / scene.grid.cell_m).ceil().max(1.0) as i64;
                    let mut nearest: Option<(i64, usize)> = None;
                    for dy in -reach..=reach {
                        for dx in -reach..=reach {
                            let (x, y) = (col as i64 + dx, row as i64 + dy);
                            if x < 0 || y < 0 || x >= width as i64 || y >= height as i64 {
                                continue;
                            }
                            let i = y as usize * width + x as usize;
                            let d = dx * dx + dy * dy;
                            if scene.canopy[i] > 0.0 && nearest.is_none_or(|(best, _)| d < best) {
                                nearest = Some((d, i));
                            }
                        }
                    }
                    if let Some((_, i)) = nearest {
                        for i in flood(i, width, height, |i| scene.canopy[i] > 0.0) {
                            scene.canopy[i] = 0.0;
                        }
                    }
                }
            }
        }
    }
    scene
}

/// Calls `each` for every cell whose centre is inside the polygon (fractional col/row), by the even-odd rule.
fn for_cells_in(ring: &[(f64, f64)], width: usize, height: usize, mut each: impl FnMut(usize)) {
    let rows = ring.iter().map(|p| p.1);
    let (top, bottom) = rows.fold((f64::MAX, f64::MIN), |(lo, hi), y| (lo.min(y), hi.max(y)));
    let (r0, r1) = (top.floor().max(0.0) as usize, (bottom.ceil().max(0.0) as usize).min(height));
    let mut crossings = Vec::new();
    for y in r0..r1 {
        let cy = y as f64 + 0.5;
        crossings.clear();
        for k in 0..ring.len() {
            let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
            if (a.1 <= cy) != (b.1 <= cy) {
                crossings.push(a.0 + (cy - a.1) / (b.1 - a.1) * (b.0 - a.0));
            }
        }
        crossings.sort_by(|a, b| a.total_cmp(b));
        for pair in crossings.chunks(2) {
            let [from, to] = pair else { continue };
            let (c0, c1) = ((from - 0.5).ceil().max(0.0) as usize, ((to - 0.5).floor() + 1.0).clamp(0.0, width as f64) as usize);
            for x in c0..c1 {
                each(y * width + x);
            }
        }
    }
}

/// The 4-connected cells from `start` for which `inside` holds, up to `MAX_REMOVE_CELLS`.
fn flood(start: usize, width: usize, height: usize, inside: impl Fn(usize) -> bool) -> Vec<usize> {
    let mut seen = vec![false; width * height];
    let mut queue = VecDeque::from([start]);
    seen[start] = true;
    let mut found = Vec::new();
    while let Some(i) = queue.pop_front() {
        found.push(i);
        if found.len() >= MAX_REMOVE_CELLS {
            break;
        }
        let (x, y) = (i % width, i / width);
        let around =
            [(x > 0).then(|| i - 1), (x + 1 < width).then(|| i + 1), (y > 0).then(|| i - width), (y + 1 < height).then(|| i + width)];
        for j in around.into_iter().flatten() {
            if !seen[j] && inside(j) {
                seen[j] = true;
                queue.push_back(j);
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use mrs_engine::Grid;

    const ORIGIN: LonLat = LonLat { lon: 11.97, lat: 57.69 };

    fn scene() -> SceneData {
        SceneData::flat(Grid { width: 20, height: 10, cell_m: 1.0, rotation_deg: 0.0 })
    }

    /// WGS84 for a fractional cell of `scene()`.
    fn at(col: f64, row: f64) -> [f64; 2] {
        let grid = scene().grid;
        let (east, north) = grid.cell_to_local(col, row);
        let p = Projection::new(ORIGIN).to_lonlat(east, north);
        [p.lon, p.lat]
    }

    #[test]
    fn a_building_raises_the_surface_inside_its_outline() {
        let outline = vec![at(2.0, 2.0), at(6.0, 2.0), at(6.0, 5.0), at(2.0, 5.0)];
        let edited = apply(&scene(), &[SceneEdit::Building { outline, height_m: 12.0 }], ORIGIN);
        let raised: Vec<usize> = (0..edited.dsm.len()).filter(|&i| edited.dsm[i] > 0.0).collect();
        assert_eq!(raised.len(), 4 * 3);
        assert!(raised.iter().all(|&i| (2..6).contains(&(i % 20)) && (2..5).contains(&(i / 20))));
        assert_eq!(edited.dsm[3 * 20 + 3], 12.0);
    }

    #[test]
    fn a_tree_adds_canopy_but_not_on_a_roof() {
        let mut base = scene();
        base.dsm[5 * 20 + 12] = 10.0;
        let edited = apply(&base, &[SceneEdit::Tree { at: at(10.5, 5.5), radius_m: 3.0, height_m: 9.0 }], ORIGIN);
        assert!(edited.canopy[5 * 20 + 10] > 8.9);
        assert!(edited.canopy[5 * 20 + 12] == 0.0, "no canopy on the building next to it");
        assert!(edited.canopy[5 * 20 + 11] > 0.0 && edited.canopy[5 * 20 + 11] < 9.0, "lower towards the crown's edge");
        assert_eq!(edited.canopy[0], 0.0);
    }

    #[test]
    fn a_remove_lowers_the_whole_building_under_the_tap_and_nothing_else() {
        let mut base = scene();
        for i in [41, 42, 61, 62, 81] {
            base.dsm[i] = 15.0;
        }
        base.dsm[50] = 20.0;
        let edited = apply(&base, &[SceneEdit::Remove { at: at(1.5, 2.5) }], ORIGIN);
        assert!([41, 42, 61, 62, 81].iter().all(|&i| edited.dsm[i] == 0.0));
        assert_eq!(edited.dsm[50], 20.0);
    }

    #[test]
    fn a_remove_off_any_building_takes_the_nearest_tree() {
        let mut base = scene();
        for i in [44, 45, 64] {
            base.canopy[i] = 7.0;
        }
        base.canopy[199] = 7.0;
        let edited = apply(&base, &[SceneEdit::Remove { at: at(3.5, 2.5) }], ORIGIN);
        assert!([44, 45, 64].iter().all(|&i| edited.canopy[i] == 0.0));
        assert_eq!(edited.canopy[199], 7.0);
    }

    #[test]
    fn no_edits_give_the_baked_scene_and_bad_ones_are_refused() {
        assert_eq!(apply(&scene(), &[], ORIGIN).dsm, scene().dsm);
        assert!(SceneEdit::Building { outline: vec![[0.0, 0.0], [1.0, 1.0]], height_m: 5.0 }.check().is_err());
        assert!(SceneEdit::Tree { at: [f64::NAN, 0.0], radius_m: 3.0, height_m: 8.0 }.check().is_err());
        assert!(SceneEdit::Tree { at: [11.0, 57.0], radius_m: 3.0, height_m: 8.0 }.check().is_ok());
        let parsed: Vec<SceneEdit> = serde_json::from_str(r#"[{"kind":"remove","at":[11.9,57.6]}]"#).unwrap();
        assert_eq!(parsed, vec![SceneEdit::Remove { at: [11.9, 57.6] }]);
    }
}
