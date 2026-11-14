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
}

/// Every site the picker offers: the ones added by hand, the ones in each sites folder
/// (a folder of site packages), then the ones shipped inside the app. A folder is listed once.
pub fn discover(added: &[PathBuf], folders: &[PathBuf], built_in: &Path) -> Vec<SiteEntry> {
    let mut entries: Vec<SiteEntry> = Vec::new();
    let mut push = |path: PathBuf, source: &'static str| {
        let path = path.canonicalize().map(strip_verbatim).unwrap_or(path);
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
    match Site::load(&path) {
        Ok(site) => SiteEntry { id: site.manifest.id.clone(), name: site.manifest.name.clone(), path, source, problem: None },
        Err(e) => SiteEntry { id: fallback.clone(), name: fallback, path, source, problem: Some(e.to_string()) },
    }
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
}
