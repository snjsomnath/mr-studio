//! A newer version of a table that is presenting waits here until the show stops (#401).
//!
//! Opening a table file of the table on the screens asks "Update when the show stops" or "Stop
//! and update now". The first copies the file into the app's own folder, `waiting/`, with a note
//! of which table it updates. Stop presenting, the nightly restart (#79) or the next start of the
//! app then applies it. One version waits at a time: a newer file replaces the one waiting.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

/// The version waiting to be applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Waiting {
    /// The copy of the table file, in the app's `waiting/` folder.
    pub file: PathBuf,
    /// The table folder it updates.
    pub table: PathBuf,
    /// The table's name, for Home and the operator log.
    pub name: String,
}

const NOTE: &str = "waiting.json";

/// Keeps a copy of `file` in `dir` to update `table` later, replacing any version waiting before.
pub fn hold(dir: &Path, file: &Path, table: &Path, name: &str) -> anyhow::Result<Waiting> {
    std::fs::create_dir_all(dir).with_context(|| format!("making {}", dir.display()))?;
    let copy = dir.join(format!("waiting.{}", mrs_site::package::EXTENSION));
    // The file may be the copy already (the same file opened twice).
    if file != copy {
        std::fs::copy(file, &copy).with_context(|| format!("keeping {} until the show stops", file.display()))?;
    }
    let waiting = Waiting { file: copy, table: table.to_path_buf(), name: name.to_string() };
    std::fs::write(dir.join(NOTE), serde_json::to_vec_pretty(&waiting)?)?;
    Ok(waiting)
}

/// The version waiting, if there is one and its file is still there.
pub fn read(dir: &Path) -> Option<Waiting> {
    let waiting: Waiting = serde_json::from_slice(&std::fs::read(dir.join(NOTE)).ok()?).ok()?;
    waiting.file.is_file().then_some(waiting)
}

/// Forgets the version waiting and removes its copy.
pub fn clear(dir: &Path) {
    if let Some(waiting) = read(dir) {
        let _ = std::fs::remove_file(waiting.file);
    }
    let _ = std::fs::remove_file(dir.join(NOTE));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_waits_once_and_is_cleared() {
        let root = std::env::temp_dir().join(format!("mrs-waiting-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("Lindholmen.mrstable");
        std::fs::write(&file, b"first").unwrap();
        let dir = root.join("waiting");
        assert_eq!(read(&dir), None);

        let held = hold(&dir, &file, Path::new("/tables/lindholmen"), "Lindholmen").unwrap();
        assert_eq!(read(&dir).as_ref(), Some(&held));
        assert_eq!(std::fs::read(&held.file).unwrap(), b"first");
        // The original can go: the copy is what waits.
        std::fs::remove_file(&file).unwrap();
        assert!(read(&dir).is_some());

        // A newer file replaces the one waiting.
        let newer = root.join("Lindholmen (2).mrstable");
        std::fs::write(&newer, b"second").unwrap();
        let held = hold(&dir, &newer, Path::new("/tables/lindholmen"), "Lindholmen").unwrap();
        assert_eq!(std::fs::read(&held.file).unwrap(), b"second");

        clear(&dir);
        assert_eq!(read(&dir), None);
        assert!(!held.file.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
