//! How fine the analysis grid is for the ground a table shows (#513).
//!
//! Sun, wind, shade and the other analyses work on a grid of square cells, `scene.cell_m` on a
//! side. One metre suits a neighbourhood; on a city-sized table it gives tens of millions of
//! cells, and every analysis crawls. So the cell follows the ground: about two million cells
//! at the normal detail, with a finer and a coarser choice either side.

use serde::{Deserialize, Serialize};

/// The number of cells the normal detail aims for.
pub const NORMAL_CELLS: f64 = 2_000_000.0;

/// The person's choice in Name and place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Detail {
    /// Cells half the normal size: four times the work.
    Fine,
    Normal,
    /// Cells twice the normal size: a quarter of the work.
    Coarse,
}

/// The cell for a ground of this size at the normal detail: 1 m up to two million cells, then
/// whole metres that keep it near that.
fn normal_cell(width_m: f64, height_m: f64) -> f64 {
    let area = width_m * height_m;
    if area > NORMAL_CELLS {
        (area / NORMAL_CELLS).sqrt().ceil()
    } else {
        1.0
    }
}

/// The cell size, in metres, for a ground of this size at this detail.
pub fn cell_for(width_m: f64, height_m: f64, detail: Detail) -> f64 {
    let normal = normal_cell(width_m, height_m);
    match detail {
        Detail::Fine => normal / 2.0,
        Detail::Normal => normal,
        Detail::Coarse => normal * 2.0,
    }
}

/// The detail a table has now, from its cell and its ground. A cell set by hand counts as the
/// nearest choice.
pub fn detail_of(width_m: f64, height_m: f64, cell_m: f64) -> Detail {
    let ratio = cell_m / normal_cell(width_m, height_m);
    if ratio < 0.75 {
        Detail::Fine
    } else if ratio > 1.5 {
        Detail::Coarse
    } else {
        Detail::Normal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cell_follows_the_ground() {
        // A neighbourhood keeps one metre.
        assert_eq!(cell_for(1000.0, 600.0, Detail::Normal), 1.0);
        assert_eq!(cell_for(1000.0, 600.0, Detail::Fine), 0.5);
        // A district and a city stay near two million cells.
        for (w, h) in [(4000.0, 2400.0), (10_000.0, 6000.0), (50_000.0, 50_000.0)] {
            let cell = cell_for(w, h, Detail::Normal);
            let cells = (w / cell) * (h / cell);
            assert!(cell.fract() == 0.0 && cells <= NORMAL_CELLS && cells > NORMAL_CELLS / 2.5, "{w} x {h}: {cell} m, {cells} cells");
            assert_eq!(detail_of(w, h, cell), Detail::Normal);
            assert_eq!(detail_of(w, h, cell_for(w, h, Detail::Fine)), Detail::Fine);
            assert_eq!(detail_of(w, h, cell_for(w, h, Detail::Coarse)), Detail::Coarse);
        }
        assert_eq!(cell_for(4000.0, 2400.0, Detail::Normal), 3.0);
        // One metre on a big table, as tables made before this had, reads as fine.
        assert_eq!(detail_of(4000.0, 2400.0, 1.0), Detail::Fine);
    }
}
