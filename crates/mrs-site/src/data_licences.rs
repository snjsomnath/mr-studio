//! Where a table's data came from and on what terms (#731): for every data file, its source,
//! its licence, the line it must be credited with, and whether it may travel with the table.
//!
//! Two places say it. A GeoJSON file can carry a `source` object at its top level, which
//! Add data writes when it fetches from OpenStreetMap (`{ name, licence, attribution }`). And
//! `site.json` can list `data_licences` for any file or folder, such as a terrain from
//! Lantmäteriet or SGU data under an FUK agreement, which wins over what a file says.

use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Site;

/// Whether a file may leave this computer with the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Share {
    /// Free to share.
    Open,
    /// Free to share, with its credit shown wherever the table is shown.
    Attribution,
    /// Not to be shared: it stays on this computer (an FUK agreement, a private dataset).
    Restricted,
}

/// A `site.json` `data_licences` entry: the terms of some of the table's files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DataLicence {
    /// Site-relative paths. A path ending in `/` or `*` covers everything under it.
    pub files: Vec<String>,
    /// Who it came from, such as "Lantmäteriet" or "SGU".
    pub source: String,
    /// The licence, such as "CC0", "ODbL-1.0", "CC BY 4.0" or "FUK".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub licence: Option<String>,
    /// The credit to show, such as "© Lantmäteriet".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<String>,
    /// Whether it may travel with the table. Worked out from the licence when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share: Option<Share>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// One data file of the table and what is known about its terms.
#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
pub struct DataSource {
    pub file: String,
    pub source: Option<String>,
    pub licence: Option<String>,
    pub attribution: Option<String>,
    /// None: nobody has said.
    pub share: Option<Share>,
}

/// What a licence name says about sharing.
pub fn share_of(licence: &str) -> Option<Share> {
    let l = licence.to_lowercase();
    if l.contains("fuk") || l.contains("restricted") || l.contains("private") || l.contains("not for shar") || l.contains("internal") {
        Some(Share::Restricted)
    } else if l.contains("odbl") || l.contains("cc-by") || l.contains("cc by") || l.contains("attribution") || l.contains("ogl") {
        Some(Share::Attribution)
    } else if l.contains("cc0") || l.contains("public domain") || l.contains("pddl") {
        Some(Share::Open)
    } else {
        None
    }
}

fn covers(pattern: &str, file: &str) -> bool {
    let pattern = pattern.trim_start_matches("./");
    match pattern.strip_suffix('*').or_else(|| pattern.strip_suffix('/').map(|_| pattern)) {
        Some(prefix) => file.starts_with(prefix),
        None => pattern == file,
    }
}

/// Every data file the table uses, with its terms.
pub fn data_sources(site: &Site) -> Vec<DataSource> {
    let mut files: BTreeSet<String> = site.data().into_values().collect();
    if let Some(mesh) = &site.manifest.scene.mesh {
        files.insert(mesh.path.clone());
    }
    // Files named only in data_licences (a folder of SGU data) count too, when they exist.
    for entry in &site.manifest.data_licences {
        for pattern in &entry.files {
            let plain = pattern.trim_end_matches(['*', '/']);
            if !pattern.ends_with(['*', '/']) && site.dir.join(plain).is_file() {
                files.insert(plain.to_string());
            } else if site.dir.join(plain).exists() {
                files.insert(pattern.clone());
            }
        }
    }
    files
        .into_iter()
        .map(|file| {
            let mut found = DataSource { file: file.clone(), source: None, licence: None, attribution: None, share: None };
            if file.ends_with(".geojson") || file.ends_with(".json") {
                if let Some(source) = file_source(site, &file) {
                    found.source = source["name"].as_str().map(str::to_string);
                    found.licence = source["licence"].as_str().or(source["license"].as_str()).map(str::to_string);
                    found.attribution = source["attribution"].as_str().map(str::to_string);
                }
            }
            if let Some(entry) = site.manifest.data_licences.iter().rev().find(|e| e.files.iter().any(|p| covers(p, &file))) {
                found.source = Some(entry.source.clone());
                found.licence = entry.licence.clone().or(found.licence);
                found.attribution = entry.attribution.clone().or(found.attribution);
                found.share = entry.share;
            }
            found.share = found
                .share
                .or_else(|| found.licence.as_deref().and_then(share_of))
                .or(found.attribution.as_ref().map(|_| Share::Attribution));
            found
        })
        .collect()
}

/// The `source` object at the top of a GeoJSON file, read without parsing the features.
fn file_source(site: &Site, file: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(site.dir.join(file)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("source").filter(|s| s.is_object()).cloned()
}

/// The credit lines of the table's data, each once, for the controller's Credits page.
pub fn attributions(sources: &[DataSource]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    sources.iter().filter_map(|s| s.attribution.clone()).filter(|a| seen.insert(a.clone())).collect()
}

/// The files that should not leave this computer.
pub fn restricted(sources: &[DataSource]) -> Vec<&DataSource> {
    sources.iter().filter(|s| s.share == Some(Share::Restricted)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn licence_names_say_how_to_share() {
        assert_eq!(share_of("ODbL-1.0"), Some(Share::Attribution));
        assert_eq!(share_of("CC BY 4.0"), Some(Share::Attribution));
        assert_eq!(share_of("CC0"), Some(Share::Open));
        assert_eq!(share_of("SGU FUK-avtal"), Some(Share::Restricted));
        assert_eq!(share_of("something else"), None);
    }

    #[test]
    fn patterns_cover_files_and_folders() {
        assert!(covers("data/terrain.tif", "data/terrain.tif"));
        assert!(covers("data/underground/", "data/underground/wells.geojson"));
        assert!(covers("data/underground/*", "data/underground/wells.geojson"));
        assert!(covers("./data/a.geojson", "data/a.geojson"));
        assert!(!covers("data/terrain.tif", "data/terrain.tiff"));
    }
}
