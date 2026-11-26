//! What a table keeps so that it works offline, and how much of it (#516).
//!
//! The host keeps every base map tile, every map picture and every answer of the table's
//! services in the table's folder. That is what lets a table run without the internet, and
//! nothing ever removed any of it: a table that ran for months, or that was moved around a
//! city, only grew. Here each kept folder has a limit; when it is passed, the files fetched
//! longest ago go first. The check runs when a table starts and once a day after that.
//!
//! - Map tiles and map pictures (`.cache/tiles`, `.cache/maps`): 500 MB together.
//! - Each service's answers (`.mrstudio/services/<id>/`): 200 MB and 2000 answers. What a
//!   layer asked to keep by name (`kept-…`, `ctx.service(id).remember`) is never removed here.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

/// Tiles and map pictures together.
pub const MAPS_LIMIT: u64 = 500 * 1024 * 1024;
/// One service's answers.
pub const SERVICE_LIMIT: u64 = 200 * 1024 * 1024;
/// One service's answers, counted: a slider sent to a service makes one small answer per value.
pub const SERVICE_ANSWERS: usize = 2000;
/// How often a running table looks again.
pub const EVERY: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// How much a table keeps for offline use.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Kept {
    /// Base map tiles and map pictures, in bytes.
    pub maps: u64,
    /// Service answers, in bytes.
    pub services: u64,
    pub files: usize,
}

/// What a trim or a clear removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Removed {
    pub bytes: u64,
    pub files: usize,
}

struct File {
    path: PathBuf,
    bytes: u64,
    fetched: SystemTime,
}

fn files_in(dir: &Path, out: &mut Vec<File>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            files_in(&entry.path(), out);
        } else if kind.is_file() {
            if let Ok(meta) = entry.metadata() {
                out.push(File { path: entry.path(), bytes: meta.len(), fetched: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH) });
            }
        }
    }
}

fn maps(site: &Path) -> Vec<File> {
    let mut files = Vec::new();
    files_in(&site.join(crate::basemap::CACHE_DIR), &mut files);
    files_in(&site.join(crate::wms::CACHE_DIR), &mut files);
    files
}

/// Whether a file in a service's folder is one a layer asked to keep by name.
fn named(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().starts_with("kept-"))
}

/// Each service's folder with the answers in it that may go.
fn services(site: &Path) -> Vec<Vec<File>> {
    let Ok(entries) = std::fs::read_dir(site.join(crate::services::CACHE_DIR)) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|k| k.is_dir()))
        .map(|e| {
            let mut files = Vec::new();
            files_in(&e.path(), &mut files);
            files
        })
        .collect()
}

/// How much the table in `site` keeps now.
pub fn measure(site: &Path) -> Kept {
    let maps = maps(site);
    let services: Vec<File> = services(site).into_iter().flatten().collect();
    Kept { maps: maps.iter().map(|f| f.bytes).sum(), services: services.iter().map(|f| f.bytes).sum(), files: maps.len() + services.len() }
}

/// Removes the files fetched longest ago until `files` is within both limits. An answer's
/// `.type` file goes with its answer.
fn trim_to(mut files: Vec<File>, bytes_limit: u64, count_limit: usize, removed: &mut Removed) {
    let is_type = |f: &File| f.path.extension().is_some_and(|e| e == "type");
    let mut bytes: u64 = files.iter().map(|f| f.bytes).sum();
    let mut count = files.iter().filter(|f| !is_type(f)).count();
    if bytes <= bytes_limit && count <= count_limit {
        return;
    }
    files.sort_by_key(|f| f.fetched);
    for file in files.iter().filter(|f| !is_type(f)) {
        if bytes <= bytes_limit && count <= count_limit {
            break;
        }
        let kind = file.path.with_extension("type");
        let kind_bytes = files.iter().find(|f| f.path == kind).map_or(0, |f| f.bytes);
        if std::fs::remove_file(&file.path).is_ok() {
            let _ = std::fs::remove_file(&kind);
            bytes = bytes.saturating_sub(file.bytes + kind_bytes);
            count -= 1;
            removed.bytes += file.bytes + kind_bytes;
            removed.files += 1;
        }
    }
}

/// Brings every kept folder of the table within its limit.
pub fn trim(site: &Path) -> Removed {
    trim_with(site, MAPS_LIMIT, SERVICE_LIMIT, SERVICE_ANSWERS)
}

fn trim_with(site: &Path, maps_limit: u64, service_limit: u64, service_answers: usize) -> Removed {
    let mut removed = Removed::default();
    trim_to(maps(site), maps_limit, usize::MAX, &mut removed);
    for service in services(site) {
        trim_to(service.into_iter().filter(|f| !named(&f.path)).collect(), service_limit, service_answers, &mut removed);
    }
    removed
}

/// Removes everything kept for offline use: tiles, map pictures and service answers. What a
/// layer kept by name stays, as do the table's own files. The table fetches again as it shows.
pub fn clear(site: &Path) -> Removed {
    trim_with(site, 0, 0, 0)
}

/// "312 MB", "1.4 GB", "nothing".
pub fn words(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    let mb = bytes as f64 / MB;
    if bytes == 0 {
        "nothing".into()
    } else if mb < 1.0 {
        "less than 1 MB".into()
    } else if mb < 1000.0 {
        format!("{mb:.0} MB")
    } else {
        format!("{:.1} GB", mb / 1024.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn put(path: &Path, bytes: usize, age_s: u64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![0u8; bytes]).unwrap();
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(age_s)).unwrap();
    }

    #[test]
    fn the_oldest_kept_files_go_first_and_named_ones_stay() {
        let site = std::env::temp_dir().join(format!("mrs-kept-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&site);
        let tiles = site.join(crate::basemap::CACHE_DIR).join("carto-dark/14");
        let pictures = site.join(crate::wms::CACHE_DIR);
        put(&tiles.join("1/1"), 400, 3000);
        put(&tiles.join("1/2"), 400, 2000);
        put(&pictures.join("aaaa"), 400, 1000);
        put(&tiles.join("2/1"), 400, 10);
        let adder = site.join(crate::services::CACHE_DIR).join("adder");
        for n in 0..6u64 {
            put(&adder.join(format!("{n:016x}")), 100, 600 - n * 100);
            put(&adder.join(format!("{n:016x}.type")), 16, 600 - n * 100);
        }
        put(&adder.join("kept-0000000000000001"), 5000, 9000);
        std::fs::write(site.join("site.json"), "{}").unwrap();

        let before = measure(&site);
        assert_eq!((before.maps, before.files), (1600, 4 + 13));

        // Within the limits nothing goes.
        assert_eq!(trim(&site), Removed::default());

        // Maps: 1000 bytes allowed, so the two oldest tiles go. The service: 4 answers allowed.
        let removed = trim_with(&site, 1000, u64::MAX, 4);
        assert_eq!(removed, Removed { bytes: 800 + 2 * 116, files: 4 });
        assert!(!tiles.join("1/1").exists() && !tiles.join("1/2").exists());
        assert!(pictures.join("aaaa").exists() && tiles.join("2/1").exists());
        assert!(!adder.join("0000000000000000").exists() && !adder.join("0000000000000000.type").exists());
        assert!(!adder.join("0000000000000001").exists());
        assert!(adder.join("0000000000000002").exists() && adder.join("0000000000000002.type").exists());
        assert!(adder.join("kept-0000000000000001").exists(), "what a layer kept by name is not ours to remove");

        // A service over its size: the oldest answers go until it fits.
        let removed = trim_with(&site, u64::MAX, 250, usize::MAX);
        assert_eq!(removed.files, 2);

        // Clear: everything fetched goes; the named value and the table stay.
        let cleared = clear(&site);
        assert_eq!(cleared.files, 4);
        assert_eq!(measure(&site), Kept { maps: 0, services: 5000, files: 1 });
        assert!(site.join("site.json").exists());
        assert_eq!(words(0), "nothing");
        assert_eq!(words(327_155_712), "312 MB");
        assert_eq!(words(1_503_238_553), "1.4 GB");
        std::fs::remove_dir_all(&site).unwrap();
    }
}
