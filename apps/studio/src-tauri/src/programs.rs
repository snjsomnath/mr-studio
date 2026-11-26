//! Whether a table's own programs may run on this computer (#506).
//!
//! A table can bring services the host starts and layer code every window runs
//! (`mrs_site::programs`). The app asks before those run, and remembers a yes in
//! `programs.json` in the app's config folder, never in the table's folder:
//!
//! - A table made on this computer is trusted from the start.
//! - A folder opened by hand is asked about once.
//! - A table that arrived as a `.mrstable` file is asked about once, and again whenever its
//!   programs are no longer the ones that were allowed (an update brought others).
//!
//! "Open without them" is for this run of the app only, so the question comes back next time.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use mrs_site::programs::Programs;
use serde::{Deserialize, Serialize};

use crate::config::write_json;

/// How a table came to be on this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Arrived {
    /// Made here, or a copy of one that is trusted.
    Here,
    /// A folder the person opened, and said yes to.
    Folder,
    /// A `.mrstable` file from someone.
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub arrived: Arrived,
    /// The programs that were allowed, for a table from a file. Empty: not answered yet.
    #[serde(default)]
    pub fingerprint: String,
}

/// The answers so far, by table folder.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Allowed {
    pub tables: BTreeMap<PathBuf, Record>,
}

/// What the person answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Run,
    Without,
    Cancel,
}

impl Allowed {
    pub fn read(path: &Path) -> Self {
        std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
    }

    pub fn write(&self, path: &Path) -> anyhow::Result<()> {
        write_json(path, self)
    }

    /// Whether `programs` may run for the table in `site` without asking.
    pub fn allows(&self, site: &Path, programs: &Programs) -> bool {
        if programs.is_empty() {
            return true;
        }
        match self.tables.get(site) {
            Some(Record { arrived: Arrived::Here | Arrived::Folder, .. }) => true,
            Some(Record { arrived: Arrived::File, fingerprint }) => !fingerprint.is_empty() && *fingerprint == programs.fingerprint,
            None => false,
        }
    }

    /// The table in `site` was made on this computer.
    pub fn made_here(&mut self, site: &Path) {
        self.tables.insert(site.to_path_buf(), Record { arrived: Arrived::Here, fingerprint: String::new() });
    }

    /// The table in `site` came from, or was just updated from, a table file. What was
    /// allowed before stays allowed while the programs are the same.
    pub fn came_as_file(&mut self, site: &Path) {
        let fingerprint = match self.tables.get(site) {
            Some(Record { arrived: Arrived::File, fingerprint }) => fingerprint.clone(),
            _ => String::new(),
        };
        self.tables.insert(site.to_path_buf(), Record { arrived: Arrived::File, fingerprint });
    }

    /// `copy` is a copy of `site` made on this computer: it is trusted as far as `site` is.
    pub fn copied(&mut self, site: &Path, copy: &Path) {
        if let Some(record) = self.tables.get(site).cloned() {
            self.tables.insert(copy.to_path_buf(), record);
        }
    }

    /// The person said the programs may run.
    pub fn said_run(&mut self, site: &Path, programs: &Programs) {
        let record = match self.tables.get(site) {
            Some(Record { arrived: Arrived::File, .. }) => Record { arrived: Arrived::File, fingerprint: programs.fingerprint.clone() },
            Some(known) => known.clone(),
            None => Record { arrived: Arrived::Folder, fingerprint: String::new() },
        };
        self.tables.insert(site.to_path_buf(), record);
    }

    pub fn forget(&mut self, site: &Path) {
        self.tables.remove(site);
    }
}

/// The question, in words.
pub fn question(name: &str, programs: &Programs) -> String {
    let list: Vec<String> = programs.lines().into_iter().map(|line| format!("  \u{2022} {line}")).collect();
    format!(
        "\u{201c}{name}\u{201d} would run these on this computer:\n\n{}\n\nRun them only if you trust where this table came from. Without them the table still opens, and the layers that need them show nothing.",
        list.join("\n")
    )
}

pub const TITLE: &str = "This table brings its own programs";
pub const RUN: &str = "Run them";
pub const WITHOUT: &str = "Open without them";
pub const CANCEL: &str = "Cancel";

#[cfg(test)]
mod tests {
    use super::*;

    fn programs(fingerprint: &str) -> Programs {
        Programs { services: vec!["Model (python run.py)".into()], layers: vec!["rings".into()], fingerprint: fingerprint.into() }
    }

    #[test]
    fn a_table_of_data_never_asks() {
        assert!(Allowed::default().allows(Path::new("/t/a"), &Programs::default()));
    }

    #[test]
    fn a_table_made_here_runs_and_a_folder_is_asked_once() {
        let mut allowed = Allowed::default();
        let (made, folder) = (Path::new("/t/made"), Path::new("/t/folder"));
        allowed.made_here(made);
        assert!(allowed.allows(made, &programs("a")));
        assert!(!allowed.allows(folder, &programs("a")));
        allowed.said_run(folder, &programs("a"));
        // The person works in that folder: a rebuilt layer does not ask again.
        assert!(allowed.allows(folder, &programs("b")));
        // A copy made here is trusted as its original is.
        allowed.copied(made, Path::new("/t/copy"));
        assert!(allowed.allows(Path::new("/t/copy"), &programs("c")));
    }

    #[test]
    fn a_table_from_a_file_asks_again_when_its_programs_change() {
        let mut allowed = Allowed::default();
        let table = Path::new("/t/sent");
        allowed.came_as_file(table);
        assert!(!allowed.allows(table, &programs("a")));
        allowed.said_run(table, &programs("a"));
        assert!(allowed.allows(table, &programs("a")));
        // An update with the same programs keeps the answer; one with others asks.
        allowed.came_as_file(table);
        assert!(allowed.allows(table, &programs("a")));
        assert!(!allowed.allows(table, &programs("b")));
        // A table made here and then updated from someone's file is a table from a file.
        let mine = Path::new("/t/mine");
        allowed.made_here(mine);
        allowed.came_as_file(mine);
        assert!(!allowed.allows(mine, &programs("a")));
    }

    #[test]
    fn the_question_names_every_program() {
        let text = question("Campus", &programs("a"));
        assert!(text.contains("Service: Model (python run.py)") && text.contains("Layer code: rings"), "{text}");
    }
}
