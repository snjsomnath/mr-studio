//! Turns a site's source data into the engine's rasters.

use std::path::Path;

use mrs_engine::{Grid, SceneData};
use serde::Serialize;
use serde_json::Value;

use crate::geotiff::GeoRaster;
use crate::{mesh, Crs, Projection, Site, SiteError};

#[derive(Debug, Clone, Default, Serialize)]
pub struct BakeStats {
    pub buildings: usize,
    pub buildings_without_height: usize,
    pub buildings_outside: usize,
    pub trees: usize,
    /// Cells the terrain source does not cover; they take the lowest elevation it has.
    pub terrain_missing_cells: usize,
    pub mesh_triangles: usize,
    /// Share of cells the mesh covers.
    pub mesh_coverage: f32,
    pub solid_fraction: f32,
    pub max_height_m: f32,
    /// Terrain cells under footprints set back to the ground beside them (#344).
    pub terrain_flattened_cells: usize,
    /// Share of cells that are water (#343).
    pub water_fraction: f32,
}

pub fn bake(site: &Site) -> Result<(SceneData, BakeStats), SiteError> {
    let grid = site.grid();
    let projection = site.projection();
    let spec = &site.manifest.scene;
    let mut scene = SceneData::flat(grid);
    let mut stats = BakeStats::default();

    if let Some(terrain) = &spec.terrain {
        let path = site.resolve(&terrain.path).expect("validated");
        if terrain.is_geotiff() {
            let crs = terrain.crs.as_deref().and_then(Crs::parse);
            let raster = GeoRaster::read(&path, crs).map_err(|message| SiteError::Parse { path: path.clone(), message })?;
            let lowest = raster.data.iter().copied().filter(|v| v.is_finite()).fold(f32::INFINITY, f32::min);
            if !lowest.is_finite() {
                return Err(SiteError::Parse { path, message: "the terrain has no data".into() });
            }
            let width = grid.width as usize;
            for (i, out) in scene.dtm.iter_mut().enumerate() {
                let (east, north) = grid.cell_to_local((i % width) as f64 + 0.5, (i / width) as f64 + 0.5);
                let p = projection.to_lonlat(east, north);
                *out = raster.sample(p.lon, p.lat).unwrap_or_else(|| {
                    stats.terrain_missing_cells += 1;
                    lowest
                });
            }
        } else {
            let bytes = std::fs::read(&path).map_err(|source| SiteError::Io { path: path.clone(), source })?;
            let source: Vec<f32> = bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            if source.iter().any(|v| !v.is_finite()) {
                return Err(SiteError::Parse { path, message: "terrain contains non-finite values".into() });
            }
            let (width, height) = (terrain.width.expect("validated") as usize, terrain.height.expect("validated") as usize);
            resample(&source, width, height, grid, &mut scene.dtm);
        }
    }
    // A surface model used as terrain has the buildings in it: take them out (#344).
    if let (Some(terrain), Some(buildings)) = (&spec.terrain, &spec.buildings) {
        if terrain.flatten_buildings {
            let path = site.resolve(&buildings.path).expect("validated");
            let mut mask = vec![false; grid.len()];
            for feature in features(&path)? {
                for polygon in polygons(&feature["geometry"]) {
                    let rings: Vec<Vec<(f64, f64)>> = polygon.iter().map(|ring| to_cells(ring, &projection, grid)).collect();
                    for i in polygon_cells(&rings, grid.width as usize, grid.height as usize) {
                        mask[i] = true;
                    }
                }
            }
            // A surface model's buildings bleed a metre or two past their footprints (pixel size, resampling).
            let reach = (2.0 / grid.cell_m).ceil().max(1.0) as usize;
            let (width, rows) = (grid.width as usize, grid.height as usize);
            let mut grown = dilate(&mask, width, rows, reach);
            // Courtyards keep roof height that bleeds into them (#404): mask those too.
            courtyards(&mut grown, &scene.dtm, width, rows, f64::from(grid.cell_m));
            stats.terrain_flattened_cells = flatten(&mut scene.dtm, &grown, width);
        }
    }
    scene.dsm.copy_from_slice(&scene.dtm);

    if let Some(water) = &spec.water {
        let path = site.resolve(&water.path).expect("validated");
        if water.is_geotiff() {
            let crs = water.crs.as_deref().and_then(Crs::parse);
            let raster = GeoRaster::read(&path, crs).map_err(|message| SiteError::Parse { path: path.clone(), message })?;
            let width = grid.width as usize;
            for (i, out) in scene.water.iter_mut().enumerate() {
                let (east, north) = grid.cell_to_local((i % width) as f64 + 0.5, (i / width) as f64 + 0.5);
                let p = projection.to_lonlat(east, north);
                *out = raster.sample(p.lon, p.lat).is_some_and(|v| v > 0.5) as u8;
            }
        } else {
            for feature in features(&path)? {
                for polygon in polygons(&feature["geometry"]) {
                    let rings: Vec<Vec<(f64, f64)>> = polygon.iter().map(|ring| to_cells(ring, &projection, grid)).collect();
                    for i in polygon_cells(&rings, grid.width as usize, grid.height as usize) {
                        scene.water[i] = 1;
                    }
                }
            }
        }
        stats.water_fraction = scene.water.iter().filter(|w| **w != 0).count() as f32 / grid.len() as f32;
    }

    if let Some(spec) = &spec.mesh {
        let path = site.resolve(&spec.path).expect("validated");
        let triangles = mesh::read(&path).map_err(|message| SiteError::Parse { path: path.clone(), message })?;
        // Mesh units to local metres: +Y points along `bearing_deg`, +X a quarter turn clockwise from it.
        let (anchor_east, anchor_north) = projection.to_local(spec.anchor.lon, spec.anchor.lat);
        let (sin, cos) = spec.bearing_deg.to_radians().sin_cos();
        let to_cell = |v: [f32; 3]| {
            let [x, y, z] = spec.orient(v).map(|c| c * spec.unit_m);
            let (col, row) = grid.local_to_cell(anchor_east + x * cos + y * sin, anchor_north - x * sin + y * cos);
            (col, row, z + spec.base_m)
        };
        let mut top = vec![f32::NEG_INFINITY; grid.len()];
        mesh::rasterise(&triangles, to_cell, grid.width as usize, grid.height as usize, &mut top);
        let mut covered = 0;
        let tolerance = spec.ground_tolerance_m as f32;
        for (dsm, top) in scene.dsm.iter_mut().zip(&top) {
            if top.is_finite() {
                covered += 1;
                // `dsm` still equals the ground here.
                if *top - *dsm > tolerance {
                    *dsm = *top;
                }
            }
        }
        stats.mesh_triangles = triangles.len();
        stats.mesh_coverage = covered as f32 / grid.len() as f32;
    }

    if let Some(buildings) = &spec.buildings {
        let path = site.resolve(&buildings.path).expect("validated");
        for feature in features(&path)? {
            let height = match number(&feature["properties"][&buildings.height_property]) {
                _ if !buildings.extrude => 0.0,
                Some(h) if h > 0.0 => h,
                _ => {
                    stats.buildings_without_height += 1;
                    buildings.default_height_m
                }
            };
            let mut inside = false;
            for polygon in polygons(&feature["geometry"]) {
                let rings: Vec<Vec<(f64, f64)>> = polygon.iter().map(|ring| to_cells(ring, &projection, grid)).collect();
                inside |= fill_building(&rings, height as f32, &mut scene);
            }
            if inside {
                stats.buildings += 1
            } else {
                stats.buildings_outside += 1
            }
        }
    }

    if let Some(trees) = &spec.trees {
        let path = site.resolve(&trees.path).expect("validated");
        let radius = trees.crown_radius_m / grid.cell_m as f64;
        for feature in features(&path)? {
            let Some(point) = feature["geometry"]["coordinates"].as_array().filter(|_| feature["geometry"]["type"] == "Point") else {
                continue;
            };
            let (Some(lon), Some(lat)) = (point.first().and_then(Value::as_f64), point.get(1).and_then(Value::as_f64)) else { continue };
            let height = number(&feature["properties"][&trees.height_property]).filter(|h| *h > 0.0).unwrap_or(trees.default_height_m);
            let (east, north) = projection.to_local(lon, lat);
            let (col, row) = grid.local_to_cell(east, north);
            if fill_disc(col, row, radius, height as f32, &mut scene) {
                stats.trees += 1;
            }
        }
    }

    let solid = (0..grid.len()).filter(|&i| scene.dsm[i] - scene.dtm[i] > mrs_engine::SOLID_THRESHOLD_M).count();
    stats.solid_fraction = solid as f32 / grid.len() as f32;
    stats.max_height_m = scene.dsm.iter().copied().fold(f32::MIN, f32::max);
    Ok((scene, stats))
}

pub(crate) fn features(path: &Path) -> Result<Vec<Value>, SiteError> {
    let text = std::fs::read_to_string(path).map_err(|source| SiteError::Io { path: path.to_path_buf(), source })?;
    let mut doc: Value = serde_json::from_str(&text).map_err(|e| SiteError::Parse { path: path.to_path_buf(), message: e.to_string() })?;
    match doc["features"].take() {
        Value::Array(features) => Ok(features),
        _ => Err(SiteError::Parse { path: path.to_path_buf(), message: "expected a GeoJSON FeatureCollection".into() }),
    }
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|v| v.is_finite())
}

/// The polygons of a Polygon or MultiPolygon geometry, each a list of rings.
pub(crate) fn polygons(geometry: &Value) -> Vec<&Vec<Value>> {
    let coordinates = geometry["coordinates"].as_array();
    match (geometry["type"].as_str(), coordinates) {
        (Some("Polygon"), Some(rings)) => vec![rings],
        (Some("MultiPolygon"), Some(polygons)) => polygons.iter().filter_map(Value::as_array).collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn to_cells(ring: &Value, projection: &Projection, grid: Grid) -> Vec<(f64, f64)> {
    ring.as_array()
        .map(|points| {
            points
                .iter()
                .filter_map(|p| {
                    let (east, north) = projection.to_local(p.get(0)?.as_f64()?, p.get(1)?.as_f64()?);
                    Some(grid.local_to_cell(east, north))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Raises the dsm under a polygon to a flat roof `height` above the lowest ground it covers.
/// Uses the even-odd rule over all rings, so holes (courtyards) stay open.
/// Returns whether any cell was covered.
fn fill_building(rings: &[Vec<(f64, f64)>], height: f32, scene: &mut SceneData) -> bool {
    let cells = polygon_cells(rings, scene.grid.width as usize, scene.grid.height as usize);
    let Some(base) = cells.iter().map(|&i| scene.dtm[i]).reduce(f32::min) else { return false };
    for i in cells {
        scene.dsm[i] = scene.dsm[i].max(base + height);
    }
    true
}

/// The cells whose centres a polygon (rings in cell coordinates, even-odd) covers.
fn polygon_cells(rings: &[Vec<(f64, f64)>], width: usize, rows: usize) -> Vec<usize> {
    let (mut min_row, mut max_row) = (f64::MAX, f64::MIN);
    for &(_, y) in rings.iter().flatten() {
        min_row = min_row.min(y);
        max_row = max_row.max(y);
    }
    if min_row > max_row {
        return Vec::new();
    }
    let first = (min_row - 0.5).ceil().max(0.0) as usize;
    let last = ((max_row - 0.5).floor() as i64).min(rows as i64 - 1);
    let mut cells: Vec<usize> = Vec::new();
    let mut crossings: Vec<f64> = Vec::new();
    for row in first as i64..=last {
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
            let from = (pair[0] - 0.5).ceil().max(0.0) as usize;
            let to = ((pair[1] - 0.5).ceil() as i64).min(width as i64);
            for col in from as i64..to {
                cells.push(row as usize * width + col as usize);
            }
        }
    }
    cells
}

/// The mask grown by `reach` cells in every direction (a square around each cell).
fn dilate(mask: &[bool], width: usize, rows: usize, reach: usize) -> Vec<bool> {
    let mut out = mask.to_vec();
    for row in 0..rows {
        for col in 0..width {
            if !mask[row * width + col] {
                continue;
            }
            for y in row.saturating_sub(reach)..=(row + reach).min(rows - 1) {
                for x in col.saturating_sub(reach)..=(col + reach).min(width - 1) {
                    out[y * width + x] = true;
                }
            }
        }
    }
    out
}

/// Courtyards narrower than this (metres across) are taken out whole: a surface model's roofs fill them.
const NARROW_COURT_M: f64 = 8.0;
/// Wider courtyards up to this size (square metres) are flattened where they stand higher than
/// their own ground by more than `COURT_RISE_M`; larger enclosed ground is left as it is.
const COURT_MAX_M2: f64 = 10_000.0;
const COURT_RISE_M: f32 = 1.0;

/// Grows `mask` (the footprints and their margin) into the courtyards a surface model raised
/// (#404). A courtyard is unmasked ground the mask encloses (not reaching the grid's edge). One
/// narrower than `NARROW_COURT_M` is masked whole, so it takes the ground outside the building;
/// in a wider one only the cells standing above its own low ground (its 20th percentile) are.
fn courtyards(mask: &mut [bool], dtm: &[f32], width: usize, rows: usize, cell_m: f64) {
    let n = mask.len();
    // Cells that are within half the narrow width of the mask: a courtyard made only of these is narrow.
    let half = ((NARROW_COURT_M / 2.0) / cell_m).floor().max(1.0) as usize;
    let near = dilate(mask, width, rows, half);
    let mut seen = vec![false; n];
    for start in 0..n {
        if mask[start] || seen[start] {
            continue;
        }
        // One piece of unmasked ground, four neighbours at a time.
        let mut cells = vec![start];
        seen[start] = true;
        let mut edge = false;
        let mut k = 0;
        while k < cells.len() {
            let i = cells[k];
            k += 1;
            let (col, row) = (i % width, i / width);
            if col == 0 || row == 0 || col + 1 == width || row + 1 == rows {
                edge = true;
            }
            let mut visit = |j: usize| {
                if !mask[j] && !seen[j] {
                    seen[j] = true;
                    cells.push(j);
                }
            };
            if col > 0 {
                visit(i - 1);
            }
            if col + 1 < width {
                visit(i + 1);
            }
            if row > 0 {
                visit(i - width);
            }
            if row + 1 < rows {
                visit(i + width);
            }
        }
        if edge || cells.len() as f64 * cell_m * cell_m > COURT_MAX_M2 {
            continue;
        }
        if cells.iter().all(|&i| near[i]) {
            for &i in &cells {
                mask[i] = true;
            }
            continue;
        }
        let mut heights: Vec<f32> = cells.iter().map(|&i| dtm[i]).collect();
        heights.sort_by(f32::total_cmp);
        let ground = heights[heights.len() / 5];
        for &i in &cells {
            if dtm[i] > ground + COURT_RISE_M {
                mask[i] = true;
            }
        }
    }
}

/// Sets every masked cell to the nearest unmasked ground (spreading out from the edges of the
/// masked areas, four neighbours at a time). Answers how many cells it changed.
fn flatten(dtm: &mut [f32], mask: &[bool], width: usize) -> usize {
    let n = dtm.len();
    let rows = n / width.max(1);
    let mut done: Vec<bool> = mask.iter().map(|m| !m).collect();
    let mut queue: std::collections::VecDeque<usize> = (0..n).filter(|&i| done[i]).collect();
    let mut changed = 0;
    while let Some(i) = queue.pop_front() {
        let (col, row) = (i % width, i / width);
        let mut visit = |j: usize| {
            if !done[j] {
                done[j] = true;
                dtm[j] = dtm[i];
                changed += 1;
                queue.push_back(j);
            }
        };
        if col > 0 {
            visit(i - 1);
        }
        if col + 1 < width {
            visit(i + 1);
        }
        if row > 0 {
            visit(i - width);
        }
        if row + 1 < rows {
            visit(i + width);
        }
    }
    changed
}

fn fill_disc(col: f64, row: f64, radius: f64, height: f32, scene: &mut SceneData) -> bool {
    let (width, rows) = (scene.grid.width as i64, scene.grid.height as i64);
    let mut any = false;
    let reach = radius.max(0.5);
    for y in (row - reach).floor() as i64..=(row + reach).ceil() as i64 {
        for x in (col - reach).floor() as i64..=(col + reach).ceil() as i64 {
            if x < 0 || y < 0 || x >= width || y >= rows {
                continue;
            }
            let (dx, dy) = (x as f64 + 0.5 - col, y as f64 + 0.5 - row);
            if dx * dx + dy * dy <= reach * reach {
                let i = (y * width + x) as usize;
                scene.canopy[i] = scene.canopy[i].max(height);
                any = true;
            }
        }
    }
    any
}

/// Bilinear resample of a raster covering the extent onto the grid.
fn resample(source: &[f32], sw: usize, sh: usize, grid: Grid, out: &mut [f32]) {
    let (width, height) = (grid.width as usize, grid.height as usize);
    for row in 0..height {
        let fy = ((row as f32 + 0.5) / height as f32 * sh as f32 - 0.5).clamp(0.0, sh as f32 - 1.0);
        let (y0, ty) = (fy.floor() as usize, fy.fract());
        let y1 = (y0 + 1).min(sh - 1);
        for col in 0..width {
            let fx = ((col as f32 + 0.5) / width as f32 * sw as f32 - 0.5).clamp(0.0, sw as f32 - 1.0);
            let (x0, tx) = (fx.floor() as usize, fx.fract());
            let x1 = (x0 + 1).min(sw - 1);
            let top = source[y0 * sw + x0] * (1.0 - tx) + source[y0 * sw + x1] * tx;
            let bottom = source[y1 * sw + x0] * (1.0 - tx) + source[y1 * sw + x1] * tx;
            out[row * width + col] = top * (1.0 - ty) + bottom * ty;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(width: u32, height: u32) -> SceneData {
        SceneData::flat(Grid { width, height, cell_m: 1.0, rotation_deg: 0.0 })
    }

    #[test]
    fn fills_a_square_with_a_courtyard() {
        let mut s = scene(20, 20);
        let outer = vec![(5.0, 5.0), (15.0, 5.0), (15.0, 15.0), (5.0, 15.0)];
        let hole = vec![(8.0, 8.0), (12.0, 8.0), (12.0, 12.0), (8.0, 12.0)];
        assert!(fill_building(&[outer, hole], 10.0, &mut s));
        let solid = s.dsm.iter().filter(|h| **h > 0.0).count();
        assert_eq!(solid, 10 * 10 - 4 * 4);
        assert_eq!(s.dsm[10 * 20 + 10], 0.0, "courtyard stays open");
        assert_eq!(s.dsm[6 * 20 + 6], 10.0);
        assert_eq!(s.dsm[4 * 20 + 6], 0.0);
    }

    #[test]
    fn roof_is_flat_above_lowest_ground() {
        let mut s = scene(10, 10);
        for (i, h) in s.dtm.iter_mut().enumerate() {
            *h = (i % 10) as f32;
        }
        s.dsm.copy_from_slice(&s.dtm);
        fill_building(&[vec![(2.0, 2.0), (6.0, 2.0), (6.0, 6.0), (2.0, 6.0)]], 5.0, &mut s);
        assert_eq!(s.dsm[3 * 10 + 2], 7.0);
        assert_eq!(s.dsm[3 * 10 + 5], 7.0);
    }

    #[test]
    fn flatten_sets_raised_footprints_to_the_ground_beside_them() {
        // A 10 x 10 terrain at 2 m with a 30 m "building" in it.
        let mut dtm = vec![2.0f32; 100];
        for row in 4..6 {
            for col in 4..6 {
                dtm[row * 10 + col] = 30.0;
            }
        }
        let mut mask = vec![false; 100];
        mask[44] = true;
        let grown = dilate(&mask, 10, 10, 1);
        assert_eq!(grown.iter().filter(|m| **m).count(), 9);
        let mut footprint = vec![false; 100];
        for i in [44, 45, 54, 55] {
            footprint[i] = true;
        }
        assert_eq!(flatten(&mut dtm, &dilate(&footprint, 10, 10, 1), 10), 16);
        assert!(dtm.iter().all(|h| *h == 2.0));
    }

    #[test]
    fn courtyards_in_a_surface_model_flatten_too() {
        // 40 x 20 cells at 1 m on 2 m ground. Two buildings with a 15 m roof, each a ring:
        // on the left a 3 m courtyard the roof bled into (6 m), on the right a 12 m one whose
        // edge cells kept 4 m and whose middle is ground.
        let (w, h) = (40usize, 20usize);
        let mut dtm = vec![2.0f32; w * h];
        let mut footprint = vec![false; w * h];
        let mut ring = |x0: usize, y0: usize, x1: usize, y1: usize, court: (usize, usize, usize, usize)| {
            for y in y0..y1 {
                for x in x0..x1 {
                    let inside = x >= court.0 && x < court.2 && y >= court.1 && y < court.3;
                    if !inside {
                        footprint[y * w + x] = true;
                        dtm[y * w + x] = 15.0;
                    }
                }
            }
        };
        ring(2, 2, 13, 13, (6, 6, 9, 9));
        ring(16, 1, 38, 19, (20, 4, 32, 16));
        for y in 6..9 {
            for x in 6..9 {
                dtm[y * w + x] = 6.0;
            }
        }
        for y in 4..16 {
            for x in 20..32 {
                if x == 20 || x == 31 || y == 4 || y == 15 {
                    dtm[y * w + x] = 4.0;
                }
            }
        }
        let mut grown = footprint.clone();
        courtyards(&mut grown, &dtm, w, h, 1.0);
        assert!((6..9).all(|y| (6..9).all(|x| grown[y * w + x])), "the narrow courtyard is masked whole");
        assert!(grown[4 * w + 25] && !grown[10 * w + 25], "the wide one only where it is raised");
        flatten(&mut dtm, &grown, w);
        assert!(dtm.iter().all(|v| *v == 2.0), "{:?}", dtm.iter().copied().fold(0.0f32, f32::max));
    }

    #[test]
    fn polygons_partly_outside_are_clipped() {
        let mut s = scene(10, 10);
        assert!(fill_building(&[vec![(-5.0, -5.0), (3.0, -5.0), (3.0, 3.0), (-5.0, 3.0)]], 4.0, &mut s));
        assert_eq!(s.dsm.iter().filter(|h| **h > 0.0).count(), 9);
        assert!(!fill_building(&[vec![(20.0, 20.0), (30.0, 20.0), (30.0, 30.0)]], 4.0, &mut s));
    }
}
