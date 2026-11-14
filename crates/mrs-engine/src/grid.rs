use serde::{Deserialize, Serialize};

/// The regular grid all engine data lives on. See `docs/contracts/engine.md`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Grid {
    /// Number of columns.
    pub width: u32,
    /// Number of rows.
    pub height: u32,
    /// Cell size in metres.
    pub cell_m: f32,
    /// Compass bearing of the grid's "up" direction (towards row 0), clockwise from north.
    pub rotation_deg: f32,
}

impl Grid {
    pub fn len(&self) -> usize {
        self.width as usize * self.height as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Local east/north metres (relative to the site origin) to fractional grid column/row.
    pub fn local_to_cell(&self, east: f64, north: f64) -> (f64, f64) {
        let r = (self.rotation_deg as f64).to_radians();
        let right = east * r.cos() - north * r.sin();
        let up = east * r.sin() + north * r.cos();
        let cell = self.cell_m as f64;
        (right / cell + self.width as f64 / 2.0, self.height as f64 / 2.0 - up / cell)
    }

    /// Fractional grid column/row to local east/north metres.
    pub fn cell_to_local(&self, col: f64, row: f64) -> (f64, f64) {
        let r = (self.rotation_deg as f64).to_radians();
        let cell = self.cell_m as f64;
        let right = (col - self.width as f64 / 2.0) * cell;
        let up = (self.height as f64 / 2.0 - row) * cell;
        (right * r.cos() + up * r.sin(), -right * r.sin() + up * r.cos())
    }

    /// Unit step in (col, row) for a compass bearing, clockwise from north.
    pub fn bearing_to_cell_dir(&self, bearing_deg: f64) -> (f64, f64) {
        let b = (bearing_deg - self.rotation_deg as f64).to_radians();
        (b.sin(), -b.cos())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_orients() {
        let g = Grid { width: 100, height: 60, cell_m: 2.0, rotation_deg: 0.0 };
        // Origin is the grid centre.
        assert_eq!(g.local_to_cell(0.0, 0.0), (50.0, 30.0));
        // North is towards row 0, east towards higher columns.
        assert_eq!(g.local_to_cell(0.0, 10.0), (50.0, 25.0));
        assert_eq!(g.local_to_cell(10.0, 0.0), (55.0, 30.0));

        let g = Grid { rotation_deg: 90.0, ..g };
        // With "up" pointing east, east is towards row 0.
        let (c, r) = g.local_to_cell(10.0, 0.0);
        assert!((c - 50.0).abs() < 1e-9 && (r - 25.0).abs() < 1e-9);
        let (e, n) = g.cell_to_local(c, r);
        assert!((e - 10.0).abs() < 1e-9 && n.abs() < 1e-9);
        // A bearing of 90 degrees (east) is "up": decreasing row.
        let (dc, dr) = g.bearing_to_cell_dir(90.0);
        assert!(dc.abs() < 1e-9 && (dr + 1.0).abs() < 1e-9);
    }
}
