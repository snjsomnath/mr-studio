//! Site rasters laid on the table's grid (#196): a dataset that is a GeoTIFF, or a folder of
//! one GeoTIFF per hour, read in any supported coordinate system and sampled at every cell centre.
//!
//! The Chalmers demo's CoolPaths study writes its thermal comfort as `pet_08.tif` .. `pet_20.tif`
//! (EPSG:3006, 2 m). A site lists that folder as a dataset (`"pet": "data/pet"`) and a layer asks
//! for one hour of it: `GET /api/data/field?name=pet&hour=14`.

use std::path::{Path, PathBuf};

use mrs_engine::Grid;

use crate::geotiff::GeoRaster;
use crate::{Projection, Site};

/// One raster on the site grid, row 0 at the top. NaN where the raster has no data.
#[derive(Debug)]
pub struct GridField {
    pub width: u32,
    pub height: u32,
    pub data: Vec<f32>,
}

impl GridField {
    /// The smallest and largest value, ignoring cells without data. `(0, 0)` when it is all empty.
    pub fn range(&self) -> (f32, f32) {
        let (lo, hi) =
            self.data.iter().filter(|v| v.is_finite()).fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| (lo.min(v), hi.max(v)));
        if lo.is_finite() {
            (lo, hi)
        } else {
            (0.0, 0.0)
        }
    }

    /// The field as a version 1 binary field frame with exact (f32) values; layout in docs/contracts/engine.md.
    pub fn to_frame(&self) -> Vec<u8> {
        let (min, max) = self.range();
        let mut out = Vec::with_capacity(40 + self.data.len() * 4);
        out.extend_from_slice(b"MRSF");
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // f32 values
        out.extend_from_slice(&0u32.to_le_bytes()); // stream: none, it is a file
        out.extend_from_slice(&0u32.to_le_bytes()); // field
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes()); // revision
        out.extend_from_slice(&min.to_le_bytes());
        out.extend_from_slice(&max.to_le_bytes());
        out.extend_from_slice(&1f32.to_le_bytes()); // progress: complete
        for v in &self.data {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }
}

/// The file of a dataset for `hour`: the dataset itself when it is a file, or in a folder
/// `pet_14.tif`, `14.tif` (any name ending in the two-digit hour). `Ok(None)` when the folder has no file for that hour.
pub fn dataset_file(site: &Site, name: &str, hour: Option<u32>) -> Result<Option<PathBuf>, String> {
    let relative = site.data().get(name).cloned().ok_or_else(|| format!("the site has no '{name}' dataset"))?;
    let path = site.resolve(&relative).ok_or_else(|| format!("'{relative}' is outside the site folder"))?;
    if path.is_file() {
        return Ok(Some(path));
    }
    if !path.is_dir() {
        return Err(format!("'{relative}' does not exist"));
    }
    let Some(hour) = hour else { return Err(format!("'{relative}' is a folder of hourly rasters; ask for an hour")) };
    Ok(hourly_file(&path, hour))
}

fn hourly_file(dir: &Path, hour: u32) -> Option<PathBuf> {
    let suffix = format!("{hour:02}");
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let tif =
                p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("tif") || e.eq_ignore_ascii_case("tiff"));
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            // `pet_14`, `pet-14`, `14`: the hour is the last two digits, not part of a longer number.
            let before = stem.len().checked_sub(3).and_then(|i| stem.as_bytes().get(i).copied());
            tif && stem.ends_with(&suffix) && before.is_none_or(|b| !b.is_ascii_digit())
        })
        .collect();
    found.sort();
    found.into_iter().next()
}

/// Samples a raster at the centre of every cell of `grid`.
pub fn on_grid(raster: &GeoRaster, grid: Grid, projection: &Projection) -> GridField {
    let width = grid.width as usize;
    let data = (0..width * grid.height as usize)
        .map(|i| {
            let (east, north) = grid.cell_to_local((i % width) as f64 + 0.5, (i / width) as f64 + 0.5);
            let p = projection.to_lonlat(east, north);
            raster.sample(p.lon, p.lat).unwrap_or(f32::NAN)
        })
        .collect();
    GridField { width: grid.width, height: grid.height, data }
}

/// Reads a dataset (for `hour`, when it is a folder of hourly rasters) onto the site grid.
pub fn read(site: &Site, name: &str, hour: Option<u32>) -> Result<Option<GridField>, String> {
    let Some(path) = dataset_file(site, name, hour)? else { return Ok(None) };
    let raster = GeoRaster::read(&path, None).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(on_grid(&raster, site.grid(), &site.projection())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Crs;
    use tiff::encoder::{colortype::Gray32Float, TiffEncoder};
    use tiff::tags::Tag;

    /// A 2 m SWEREF99 TM raster around (lon 12, lat 57) whose value is its column number, with
    /// one hole of no data (-9999), as the demo's `pet_HH.tif` files are written.
    fn sweref_tif(path: &Path) {
        let (x, y) = Crs::parse("EPSG:3006").unwrap().forward(12.0, 57.0);
        let (width, height) = (200u32, 200u32);
        let (left, top) = (x - 200.0, y + 200.0);
        let mut data: Vec<f32> = (0..width * height).map(|i| (i % width) as f32).collect();
        data[(100 * width + 100) as usize] = -9999.0;
        let file = std::fs::File::create(path).unwrap();
        let mut encoder = TiffEncoder::new(file).unwrap();
        let mut image = encoder.new_image::<Gray32Float>(width, height).unwrap();
        image.encoder().write_tag(Tag::ModelPixelScaleTag, &[2.0, 2.0, 0.0][..]).unwrap();
        image.encoder().write_tag(Tag::ModelTiepointTag, &[0.0, 0.0, 0.0, left, top, 0.0][..]).unwrap();
        let keys: [u16; 16] = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3006];
        image.encoder().write_tag(Tag::GeoKeyDirectoryTag, &keys[..]).unwrap();
        image.encoder().write_tag(Tag::GdalNodata, "-9999").unwrap();
        image.write_data(&data).unwrap();
    }

    fn site(dir: &Path, data: &str) -> Site {
        let text = format!(
            r#"{{ "format": 3, "id": "t", "name": "T", "origin": {{ "lon": 12, "lat": 57 }},
                 "extent": {{ "width_m": 100, "height_m": 60 }}, "scene": {{ "cell_m": 2 }}, "data": {data} }}"#
        );
        Site { dir: dir.to_path_buf(), manifest: serde_json::from_str(&text).unwrap(), calibration: None }
    }

    #[test]
    fn an_hourly_folder_is_read_onto_the_grid() {
        let dir = std::env::temp_dir().join(format!("mrs-field-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("data/pet")).unwrap();
        sweref_tif(&dir.join("data/pet/pet_14.tif"));
        std::fs::write(dir.join("data/pet/pet_114.tif"), b"not this one").unwrap();
        let site = site(&dir, r#"{ "pet": "data/pet" }"#);

        let field = read(&site, "pet", Some(14)).unwrap().expect("14:00 is there");
        assert_eq!((field.width, field.height), (50, 30));
        // East is +column in the raster, so the values rise to the right across the table.
        let row = 15 * 50;
        assert!(field.data[row + 49] > field.data[row], "{} then {}", field.data[row], field.data[row + 49]);
        // 100 m wide at 2 m a pixel is about 50 columns of the source.
        let rise = field.data[row + 49] - field.data[row];
        assert!((rise - 49.0).abs() < 2.0, "rise {rise}");
        let (lo, hi) = field.range();
        assert!(lo > 50.0 && hi < 150.0);

        assert!(read(&site, "pet", Some(3)).unwrap().is_none(), "no file for 03:00");
        assert!(read(&site, "pet", None).is_err(), "a folder needs an hour");
        assert!(read(&site, "roads", Some(14)).is_err());

        let frame = field.to_frame();
        assert_eq!(&frame[0..4], b"MRSF");
        assert_eq!(frame.len(), 40 + 50 * 30 * 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_single_file_serves_every_hour() {
        let dir = std::env::temp_dir().join(format!("mrs-field-one-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("data")).unwrap();
        sweref_tif(&dir.join("data/utci.tif"));
        let site = site(&dir, r#"{ "comfort": "data/utci.tif" }"#);
        assert!(read(&site, "comfort", Some(3)).unwrap().is_some());
        assert!(read(&site, "comfort", None).unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
