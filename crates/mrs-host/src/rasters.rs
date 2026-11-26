//! Rasters laid on the table's grid, kept once they have been read (#534).
//!
//! `GET /api/data/field` reads a GeoTIFF and resamples it onto the table's grid. Cool paths
//! asks for one raster per hour of the day, and moving the hour slider back and forth asked
//! for the same hours again: each time site.json was loaded and checked, the file opened and
//! every cell resampled. Here the finished frame is kept, by dataset and hour, for as long as
//! neither the raster nor site.json (where the table is, how big, which file) has changed.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use axum::body::Bytes;
use mrs_site::Site;

/// The most that is kept, in bytes of frames. The frames used longest ago go first.
pub const LIMIT: usize = 256 * 1024 * 1024;

/// When a file was last written and how long it is: what tells a changed file from the same one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp(Option<SystemTime>, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(Stamp(meta.modified().ok(), meta.len()))
}

struct Entry {
    name: String,
    hour: Option<u32>,
    site: Stamp,
    file: PathBuf,
    raster: Stamp,
    frame: Bytes,
    used: u64,
}

/// The frames kept for one table.
#[derive(Default)]
pub struct Rasters {
    entries: parking_lot::Mutex<Vec<Entry>>,
    clock: AtomicU64,
    /// How often a raster file was opened and resampled, for the tests.
    reads: AtomicU64,
}

impl Rasters {
    /// The dataset `name` (for `hour`, when it is a folder of hourly rasters) of the site in
    /// `dir`, as a field frame on the site's grid. `Ok(None)` when there is no raster for that hour.
    pub fn frame(&self, dir: &Path, name: &str, hour: Option<u32>) -> Result<Option<Bytes>, String> {
        self.frame_within(dir, name, hour, LIMIT)
    }

    fn frame_within(&self, dir: &Path, name: &str, hour: Option<u32>, limit: usize) -> Result<Option<Bytes>, String> {
        let site_stamp = stamp(&dir.join("site.json"));
        let now = self.clock.fetch_add(1, Ordering::Relaxed);
        if let Some(site_stamp) = site_stamp {
            let mut entries = self.entries.lock();
            if let Some(entry) = entries.iter_mut().find(|e| e.name == name && e.hour == hour) {
                // Two looks at the folder, and nothing is opened.
                if entry.site == site_stamp && stamp(&entry.file) == Some(entry.raster) {
                    entry.used = now;
                    return Ok(Some(entry.frame.clone()));
                }
            }
        }
        // Read outside the lock: a large raster takes a moment, and other hours are asked for meanwhile.
        let site = Site::load(dir).map_err(|e| e.to_string())?;
        let Some(file) = mrs_site::field::dataset_file(&site, name, hour)? else { return Ok(None) };
        let raster_stamp = stamp(&file);
        let Some(field) = mrs_site::field::read(&site, name, hour)? else { return Ok(None) };
        self.reads.fetch_add(1, Ordering::Relaxed);
        let frame = Bytes::from(field.to_frame());
        if let (Some(site), Some(raster)) = (site_stamp, raster_stamp) {
            let mut entries = self.entries.lock();
            entries.retain(|e| !(e.name == name && e.hour == hour));
            entries.push(Entry { name: name.to_string(), hour, site, file, raster, frame: frame.clone(), used: now });
            // Within the limit, the newest always kept.
            let mut total: usize = entries.iter().map(|e| e.frame.len()).sum();
            while total > limit && entries.len() > 1 {
                let oldest = entries.iter().enumerate().min_by_key(|(_, e)| e.used).map(|(i, _)| i).expect("not empty");
                total -= entries.swap_remove(oldest).frame.len();
            }
        }
        Ok(Some(frame))
    }

    /// How many times a raster file has been opened.
    pub fn reads(&self) -> u64 {
        self.reads.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiff::encoder::{colortype::Gray32Float, TiffEncoder};
    use tiff::tags::Tag;

    /// A 2 m SWEREF99 TM raster around (lon 12, lat 57), `size` pixels a side, every cell `value`.
    fn tif(path: &Path, size: u32, value: f32) {
        let (x, y) = mrs_site::Crs::parse("EPSG:3006").unwrap().forward(12.0, 57.0);
        let (left, top) = (x - f64::from(size), y + f64::from(size));
        let data = vec![value; (size * size) as usize];
        let mut encoder = TiffEncoder::new(std::fs::File::create(path).unwrap()).unwrap();
        let mut image = encoder.new_image::<Gray32Float>(size, size).unwrap();
        image.encoder().write_tag(Tag::ModelPixelScaleTag, &[2.0, 2.0, 0.0][..]).unwrap();
        image.encoder().write_tag(Tag::ModelTiepointTag, &[0.0, 0.0, 0.0, left, top, 0.0][..]).unwrap();
        let keys: [u16; 16] = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3006];
        image.encoder().write_tag(Tag::GeoKeyDirectoryTag, &keys[..]).unwrap();
        image.write_data(&data).unwrap();
    }

    fn table(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mrs-rasters-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data/pet")).unwrap();
        std::fs::write(
            dir.join("site.json"),
            r#"{ "format": 3, "id": "t", "name": "T", "origin": { "lon": 12, "lat": 57 },
                 "extent": { "width_m": 100, "height_m": 60 }, "scene": { "cell_m": 2 }, "data": { "pet": "data/pet" } }"#,
        )
        .unwrap();
        dir
    }

    #[test]
    fn the_same_hour_is_read_once_and_a_changed_file_is_read_again() {
        let dir = table("once");
        tif(&dir.join("data/pet/pet_14.tif"), 200, 20.0);
        tif(&dir.join("data/pet/pet_15.tif"), 200, 30.0);
        let rasters = Rasters::default();

        let first = rasters.frame(&dir, "pet", Some(14)).unwrap().expect("14:00 is there");
        assert_eq!(rasters.reads(), 1);
        let again = rasters.frame(&dir, "pet", Some(14)).unwrap().unwrap();
        assert_eq!(rasters.reads(), 1, "the second answer does not open the file");
        assert_eq!(first, again);

        // Another hour is its own frame, and no hour at all is still no frame.
        let other = rasters.frame(&dir, "pet", Some(15)).unwrap().unwrap();
        assert_ne!(first, other);
        assert_eq!(rasters.reads(), 2);
        assert!(rasters.frame(&dir, "pet", Some(3)).unwrap().is_none());
        assert!(rasters.frame(&dir, "roads", Some(14)).is_err());

        // The raster is written again (a different length, so the change shows whatever the
        // clock of the disk): the new data is given.
        tif(&dir.join("data/pet/pet_14.tif"), 220, 25.0);
        let changed = rasters.frame(&dir, "pet", Some(14)).unwrap().unwrap();
        assert_eq!(rasters.reads(), 3);
        assert_ne!(first, changed);
        rasters.frame(&dir, "pet", Some(14)).unwrap().unwrap();
        assert_eq!(rasters.reads(), 3);

        // site.json changes (the table could be somewhere else now): read again.
        let text = std::fs::read_to_string(dir.join("site.json")).unwrap().replace("\"width_m\": 100", "\"width_m\": 80");
        std::fs::write(dir.join("site.json"), text).unwrap();
        let narrower = rasters.frame(&dir, "pet", Some(14)).unwrap().unwrap();
        assert_eq!(rasters.reads(), 4);
        assert!(narrower.len() < changed.len());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_frames_used_longest_ago_go_first() {
        let dir = table("limit");
        for hour in 10..14 {
            tif(&dir.join(format!("data/pet/pet_{hour}.tif")), 200, hour as f32);
        }
        let rasters = Rasters::default();
        let one = rasters.frame(&dir, "pet", Some(10)).unwrap().unwrap().len();
        // Room for two frames.
        for hour in [10, 11, 10, 12] {
            rasters.frame_within(&dir, "pet", Some(hour), one * 2).unwrap().unwrap();
        }
        assert_eq!(rasters.reads(), 3);
        // 11 was used longest ago and went; 10 and 12 are still kept.
        rasters.frame_within(&dir, "pet", Some(10), one * 2).unwrap().unwrap();
        rasters.frame_within(&dir, "pet", Some(12), one * 2).unwrap().unwrap();
        assert_eq!(rasters.reads(), 3);
        rasters.frame_within(&dir, "pet", Some(11), one * 2).unwrap().unwrap();
        assert_eq!(rasters.reads(), 4);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
