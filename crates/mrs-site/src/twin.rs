//! The site's digital twin: the scene's mesh, with each roof and wall tagged by the
//! building footprint it stands on. Contract in `docs/contracts/model.md`.

use mrs_engine::{SceneData, TwinMesh, TwinOptions};

use crate::bake::{features, polygons, to_cells};
use crate::{Site, SiteError};

impl Site {
    /// Builds the twin of a baked scene. A building's number is its feature's position in the
    /// footprints file plus one, so surfaces can look its properties up in the same file.
    pub fn twin(&self, scene: &SceneData) -> Result<TwinMesh, SiteError> {
        let ids = self.building_numbers(scene)?;
        Ok(TwinMesh::build(scene, ids.as_deref(), TwinOptions::default()))
    }

    /// The building number of every cell, 0 where no footprint covers it. `None` without footprints.
    fn building_numbers(&self, scene: &SceneData) -> Result<Option<Vec<u32>>, SiteError> {
        let Some(buildings) = &self.manifest.scene.buildings else { return Ok(None) };
        let path = self.resolve(&buildings.path).expect("validated");
        let (grid, projection) = (scene.grid, self.projection());
        let mut ids = vec![0u32; grid.len()];
        for (index, feature) in features(&path)?.iter().enumerate() {
            for polygon in polygons(&feature["geometry"]) {
                let rings: Vec<Vec<(f64, f64)>> = polygon.iter().map(|ring| to_cells(ring, &projection, grid)).collect();
                for cell in covered(&rings, grid.width as usize, grid.height as usize) {
                    ids[cell] = index as u32 + 1;
                }
            }
        }
        Ok(Some(ids))
    }
}

/// The cells whose centres lie inside a polygon, by the even-odd rule over all its rings.
/// The same rule the bake uses to raise buildings, so numbers and roofs line up.
fn covered(rings: &[Vec<(f64, f64)>], width: usize, rows: usize) -> Vec<usize> {
    let (mut min_row, mut max_row) = (f64::MAX, f64::MIN);
    for &(_, y) in rings.iter().flatten() {
        min_row = min_row.min(y);
        max_row = max_row.max(y);
    }
    let mut cells = Vec::new();
    if min_row > max_row {
        return cells;
    }
    let first = (min_row - 0.5).ceil().max(0.0) as i64;
    let last = ((max_row - 0.5).floor() as i64).min(rows as i64 - 1);
    let mut crossings: Vec<f64> = Vec::new();
    for row in first..=last {
        let y = row as f64 + 0.5;
        crossings.clear();
        for ring in rings {
            for k in 0..ring.len() {
                let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
                if (a.1 <= y) != (b.1 <= y) {
                    crossings.push(a.0 + (y - a.1) / (b.1 - a.1) * (b.0 - a.0));
                }
            }
        }
        crossings.sort_by(|a, b| a.total_cmp(b));
        for pair in crossings.as_chunks::<2>().0.iter() {
            let from = (pair[0] - 0.5).ceil().max(0.0) as i64;
            let to = ((pair[1] - 0.5).ceil() as i64).min(width as i64);
            cells.extend((from..to).map(|col| row as usize * width + col as usize));
        }
    }
    cells
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use mrs_engine::SurfaceKind;

    use super::*;

    #[test]
    fn the_sample_site_twin_tags_every_roof_with_its_building() {
        let site = Site::load(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sites/sample")).unwrap();
        let (scene, stats) = site.bake().unwrap();
        let mesh = site.twin(&scene).unwrap();
        let roofs: Vec<u32> = mesh.kinds.iter().zip(&mesh.buildings).filter(|(k, _)| **k == SurfaceKind::Roof).map(|(_, b)| *b).collect();
        assert!(!roofs.is_empty());
        assert!(roofs.iter().all(|b| *b > 0), "every roof stands on a footprint");
        let mut distinct = roofs.clone();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(distinct.len(), stats.buildings);
        // Merging keeps a synthetic district far below one quad per cell.
        assert!(mesh.triangle_count() < 400_000, "{} triangles", mesh.triangle_count());
        assert!(mesh.kinds.contains(&SurfaceKind::Wall));
    }
}
