//! A newer version of a table that arrived while that table was open or presenting (#401). The
//! file waits in the app's data folder until the show stops; the next start of a table (Stop
//! presenting, the nightly restart, opening another table or the app starting) puts it in place.
//!
//! One file waits per table: a newer one arriving replaces it. Each is two files in `dir`:
//! `<key>.mrstable`, a copy of the table file, and `<key>.json`, what it is for.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What a waiting file is for.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Waiting {
    /// The table folder the file updates.
    pub table: PathBuf,
    /// The table's name, for Home: "Lindholmen: a new version waits for the show to stop".
    pub name: String,
    /// The copy of the table file, in the waiting folder.
    #[serde(default)]
    pub file: PathBuf,
}

/// A file name for a table: its folder name, with anything unusual replaced.
fn key(table: &Path) -> String {
    let name = table.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    if clean.is_empty() {
        "table".into()
    } else {
        clean
    }
}

/// Keeps a copy of `file` to update `table` later, replacing any file already waiting for it.
pub fn keep(dir: &Path, file: &Path, table: &Path, name: &str) -> std::io::Result<Waiting> {
    std::fs::create_dir_all(dir)?;
    let key = key(table);
    let copy = dir.join(format!("{key}.mrstable"));
    std::fs::copy(file, &copy)?;
    let waiting = Waiting { table: table.to_path_buf(), name: name.to_string(), file: copy };
    // The note is written last: a copy without one is never applied.
    std::fs::write(dir.join(format!("{key}.json")), serde_json::to_vec_pretty(&waiting).map_err(std::io::Error::other)?)?;
    Ok(waiting)
}

/// Every file waiting, oldest first. Notes whose copy is missing are left out.
pub fn list(dir: &Path) -> Vec<Waiting> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<(std::time::SystemTime, Waiting)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let text = std::fs::read(e.path()).ok()?;
            let mut waiting: Waiting = serde_json::from_slice(&text).ok()?;
            waiting.file = e.path().with_extension("mrstable");
            let when = e.metadata().and_then(|m| m.modified()).ok()?;
            waiting.file.is_file().then_some((when, waiting))
        })
        .collect();
    found.sort_by_key(|(when, _)| *when);
    found.into_iter().map(|(_, w)| w).collect()
}

/// Forgets a waiting file, once it is applied or can never be.
pub fn forget(waiting: &Waiting) {
    let _ = std::fs::remove_file(waiting.file.with_extension("json"));
    let _ = std::fs::remove_file(&waiting.file);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_file_replaces_the_one_waiting_and_is_forgotten_once_applied() {
        let root = std::env::temp_dir().join(format!("mrs-waiting-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.join("waiting");
        let table = root.join("Lindholmen site");
        let (a, b) = (root.join("a.mrstable"), root.join("b.mrstable"));
        std::fs::write(&a, b"first").unwrap();
        std::fs::write(&b, b"second").unwrap();
        keep(&dir, &a, &table, "Lindholmen").unwrap();
        keep(&dir, &b, &table, "Lindholmen").unwrap();
        let all = list(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Lindholmen");
        assert_eq!(all[0].table, table);
        assert_eq!(std::fs::read(&all[0].file).unwrap(), b"second");
        forget(&all[0]);
        assert!(list(&dir).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
