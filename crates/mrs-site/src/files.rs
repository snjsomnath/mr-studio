//! Replacing a file in one step (#515).
//!
//! `site.json` has more than one writer: the app, `mrstudio dev` on the same folder, the MCP
//! server, a text editor. A file written in place is, for a moment, empty or half there, and
//! whoever reads it then sees a broken table. So every writer here writes the new text beside
//! the file and renames it over the old one, which a reader sees as either the old file or
//! the new one. The temporary name carries the process and a counter, so two programs on one
//! folder never write into each other's half-made file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A name beside `path` that no other writer uses: `site.json.4312-7.tmp`.
fn temporary(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!("{name}.{}-{n}.tmp", std::process::id()))
}

/// Replaces `path` with `contents` in one step. On failure the file is as it was.
pub fn replace(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let temporary = temporary(path);
    let written = std::fs::write(&temporary, contents).and_then(|()| std::fs::rename(&temporary, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_replaced_whole_and_nothing_is_left_beside_it() {
        let dir = std::env::temp_dir().join(format!("mrs-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("site.json");
        replace(&path, "{ \"a\": 1 }\n").unwrap();
        replace(&path, "{ \"a\": 2 }\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ \"a\": 2 }\n");
        assert_ne!(temporary(&path), temporary(&path), "two writes never share a temporary file");
        assert!(temporary(&path).to_string_lossy().contains(&std::process::id().to_string()));
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, ["site.json"]);
        // A folder that is not there: an error, and no stray file.
        assert!(replace(&dir.join("missing/site.json"), "x").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
