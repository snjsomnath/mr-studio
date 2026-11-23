//! Finding site packages for the site picker.

use std::path::{Path, PathBuf};

use mrs_site::Site;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SiteEntry {
    pub path: PathBuf,
    pub id: String,
    pub name: String,
    /// Where it was found: "built in", "sites folder" or "added".
    pub source: &'static str,
    /// Why it cannot run, if it cannot.
    pub problem: Option<String>,
    /// When its site.json last changed, in milliseconds since 1970: "Edited 10 minutes ago".
    pub edited: Option<u64>,
}

/// What Home shows on a table's card besides its name, found in the background (#131).
#[derive(Debug, Clone, Serialize)]
pub struct Details {
    /// The space the folder takes on disk, everything in it included.
    pub bytes: u64,
    /// The picture of the map from when the table was last left, as a `data:` URL.
    pub thumbnail: Option<String>,
}

/// Where the editor keeps the picture of the map; the host writes it (`mrs_host::THUMBNAIL`).
pub const THUMBNAIL: &str = ".mrstudio/thumbnail.jpg";

pub fn details(path: &Path) -> Details {
    use base64::Engine as _;
    let thumbnail = std::fs::read(path.join(THUMBNAIL))
        .ok()
        .filter(|b| b.starts_with(&[0xFF, 0xD8]))
        .map(|bytes| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
    Details { bytes: folder_size(path), thumbnail }
}

/// The bytes of every file under `path`. Links are not followed, so a link to a large
/// folder elsewhere is not counted, and cannot loop.
pub fn folder_size(path: &Path) -> u64 {
    let Ok(read) = std::fs::read_dir(path) else { return 0 };
    read.flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => folder_size(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

fn edited(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path.join("site.json")).ok()?.modified().ok()?;
    Some(modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Every site the picker offers: the ones added by hand, the ones in each sites folder
/// (a folder of site packages), then the ones shipped inside the app. A folder is listed once.
pub fn discover(added: &[PathBuf], folders: &[PathBuf], built_in: &Path) -> Vec<SiteEntry> {
    let mut entries: Vec<SiteEntry> = Vec::new();
    let mut push = |path: PathBuf, source: &'static str| {
        let path = canonical(path);
        if !entries.iter().any(|e| e.path == path) {
            entries.push(describe(path, source));
        }
    };
    for path in added {
        push(path.clone(), "added");
    }
    for folder in folders {
        for path in packages_in(folder) {
            push(path, "sites folder");
        }
    }
    for path in packages_in(built_in) {
        push(path, "built in");
    }
    entries
}

fn packages_in(folder: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(folder) else { return Vec::new() };
    let mut found: Vec<PathBuf> = read.flatten().map(|e| e.path()).filter(|p| p.join("site.json").is_file()).collect();
    found.sort();
    found
}

pub fn describe(path: PathBuf, source: &'static str) -> SiteEntry {
    let fallback = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let edited = edited(&path);
    match Site::load(&path) {
        Ok(site) => SiteEntry { id: site.manifest.id.clone(), name: site.manifest.name.clone(), path, source, problem: None, edited },
        Err(e) => SiteEntry { id: fallback.clone(), name: fallback, path, source, problem: Some(e.to_string()), edited },
    }
}

/// The one spelling of a folder's path that is stored and compared, so a folder reached
/// through a link (Documents kept in a cloud folder) is still the same site.
pub fn canonical(path: PathBuf) -> PathBuf {
    path.canonicalize().map(strip_verbatim).unwrap_or(path)
}

/// Windows canonical paths start with `\\?\`, which is noise in a picker and in a config file.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(plain) if !plain.starts_with("UNC") => PathBuf::from(plain),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_sample_site_once_and_reports_a_broken_one() {
        let sites = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../sites");
        let broken = std::env::temp_dir().join(format!("mrs-broken-site-{}", std::process::id()));
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("site.json"), "{").unwrap();

        let found = discover(&[sites.join("sample"), broken.clone()], std::slice::from_ref(&sites), &sites);
        assert_eq!(found.iter().filter(|s| s.id == "sample").count(), 1);
        let sample = found.iter().find(|s| s.id == "sample").unwrap();
        assert_eq!((sample.name.as_str(), sample.source, &sample.problem), ("Sample district", "added", &None));
        assert!(found.iter().any(|s| s.problem.is_some()), "the broken site is listed with its problem");
        std::fs::remove_dir_all(&broken).unwrap();
    }

    #[test]
    fn a_card_shows_the_folder_size_and_the_picture_from_the_last_visit() {
        let dir = std::env::temp_dir().join(format!("mrs-details-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("site.json"), "{}").unwrap();
        std::fs::write(dir.join("data/a.geojson"), vec![b' '; 1000]).unwrap();
        let before = details(&dir);
        assert_eq!((before.bytes, before.thumbnail), (1002, None));
        std::fs::create_dir_all(dir.join(".mrstudio")).unwrap();
        std::fs::write(dir.join(THUMBNAIL), [0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
        let after = details(&dir);
        assert_eq!(after.bytes, 1006);
        assert_eq!(after.thumbnail.as_deref(), Some("data:image/jpeg;base64,/9j/4A=="));
        assert!(edited(&dir).is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
