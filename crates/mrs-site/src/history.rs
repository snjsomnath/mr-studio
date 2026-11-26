//! The table's revision history (#72): every version of `site.json`, who made it and why.
//!
//! The host owns it. Each change the host writes (an edit in the editor, an import, a move)
//! and each change made outside it (the MCP server, a text editor, a `git pull`) becomes a
//! revision. Undo and redo walk the list; restore brings back any revision as a new one.
//!
//! The revisions are kept in the site folder under `.mrstudio/history/`, one file each, so
//! the history survives a restart. That folder is never part of an export or the site's
//! repository. Only the last [`KEEP`] revisions are kept.
//!
//! Every function here reads or writes `site.json`, so the caller holds one lock around
//! each call: a change the host writes and its revision then land as one step, and the
//! watcher never mistakes the host's own write for an outside edit.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How many revisions are kept. Older ones are deleted as new ones arrive.
pub const KEEP: usize = 200;

/// Where the history lives, inside the site folder.
pub const DIR: &str = ".mrstudio/history";

/// A note an outside tool leaves next to its change, so the history can say who made it.
/// It is read once, for the next outside change found within [`NOTE_FRESH_S`] seconds.
pub const NOTE: &str = ".mrstudio/next-change.json";
const NOTE_FRESH_S: u64 = 30;

/// The same change from the same surface within this many seconds joins the revision before it.
const MERGE_S: u64 = 3;

/// Who made a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum By {
    /// The editor (a `dev` surface).
    Editor,
    /// The controller (a `tv` surface).
    Controller,
    /// The MCP server, when it left a note.
    Mcp,
    /// Brought in through Add data, OpenStreetMap or the elevation service.
    Import,
    /// Undo, redo or restore in the history itself.
    History,
    /// Changed outside MR Studio: a text editor, git, another program.
    Outside,
    /// The version the history started from.
    Start,
}

/// One version of `site.json`, as the history lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Revision {
    /// Counts up from 1 and is never reused.
    pub rev: u64,
    /// Seconds since 1970, UTC.
    pub at: u64,
    pub by: By,
    /// One line in plain words: "Added Sun study", "Changed outside MR Studio: layers".
    pub summary: String,
    /// The top-level keys of `site.json` that differ from the revision before.
    #[serde(default)]
    pub keys: Vec<String>,
    /// The surface that made it, when a surface did, so that surface can tell its own changes from others'.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    #[serde(flatten)]
    revision: Revision,
    /// The whole of `site.json` as it was.
    text: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Head {
    /// The revision `site.json` holds now.
    head: u64,
}

/// What one change did: the file before and after, and the revision that records it.
#[derive(Debug, Clone)]
pub struct Change {
    pub before: String,
    pub after: String,
    /// The top-level keys that differ between `before` and `after`. For an undo these are
    /// not the keys of `revision` (the version now in place) but what the undo changed.
    pub keys: Vec<String>,
    pub revision: Revision,
}

impl Change {
    fn new(before: String, after: String, revision: Revision) -> Self {
        let keys = changed_keys(&before, &after);
        Self { before, after, keys, revision }
    }
}

/// The revisions of one site, oldest first, and which one `site.json` holds now.
pub struct History {
    dir: PathBuf,
    site_json: PathBuf,
    revisions: Vec<(Revision, String)>,
    /// Index into `revisions`.
    head: usize,
    /// Where history files go; `None` keeps the history in memory only (a read-only folder).
    store: Option<PathBuf>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The top-level keys whose values differ between two versions of `site.json`.
/// A version that does not parse counts as every key changed.
pub fn changed_keys(before: &str, after: &str) -> Vec<String> {
    let (Ok(Value::Object(a)), Ok(Value::Object(b))) = (serde_json::from_str::<Value>(before), serde_json::from_str::<Value>(after)) else {
        return if before == after { Vec::new() } else { vec!["*".into()] };
    };
    let mut keys: Vec<String> = a.keys().chain(b.keys()).filter(|k| a.get(*k) != b.get(*k)).cloned().collect();
    keys.sort();
    keys.dedup();
    keys
}

/// The same JSON, ignoring spacing and key order. Text that does not parse compares as text.
fn same(a: &str, b: &str) -> bool {
    match (serde_json::from_str::<Value>(a), serde_json::from_str::<Value>(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, path)
}

impl History {
    /// Opens the history of the site in `dir`. If `site.json` changed while MR Studio was
    /// closed, or there is no history yet, the file as it is now becomes the newest revision.
    pub fn open(dir: &Path) -> Self {
        let store = dir.join(DIR);
        let site_json = dir.join("site.json");
        let mut revisions: Vec<(Revision, String)> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&store) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !(name.starts_with('r') && name.ends_with(".json")) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
                if let Ok(stored) = serde_json::from_str::<Stored>(&text) {
                    revisions.push((stored.revision, stored.text));
                }
            }
        }
        revisions.sort_by_key(|(r, _)| r.rev);
        let saved_head =
            std::fs::read_to_string(store.join("head.json")).ok().and_then(|t| serde_json::from_str::<Head>(&t).ok()).map(|h| h.head);
        let head = saved_head.and_then(|h| revisions.iter().position(|(r, _)| r.rev == h)).unwrap_or(revisions.len().saturating_sub(1));
        let writable = std::fs::create_dir_all(&store).is_ok();
        let mut history = Self { dir: dir.to_path_buf(), site_json, revisions, head, store: writable.then_some(store) };
        let current = std::fs::read_to_string(&history.site_json).unwrap_or_default();
        if history.revisions.is_empty() {
            history.push(By::Start, "Opened the table".into(), Vec::new(), None, current);
        } else if !same(&history.revisions[history.head].1, &current) {
            let keys = changed_keys(&history.revisions[history.head].1, &current);
            history.push(By::Outside, outside_summary(&keys, "while MR Studio was closed"), keys, None, current);
        }
        history
    }

    /// The revisions, oldest first.
    pub fn list(&self) -> Vec<Revision> {
        self.revisions.iter().map(|(r, _)| r.clone()).collect()
    }

    /// The text of site.json at a kept revision and at the one before it (#395), so a reader can
    /// show what that change did. The first kept revision has nothing before it.
    pub fn texts(&self, rev: u64) -> Option<(Option<String>, String)> {
        let at = self.revisions.iter().position(|(r, _)| r.rev == rev)?;
        let before = at.checked_sub(1).map(|i| self.revisions[i].1.clone());
        Some((before, self.revisions[at].1.clone()))
    }

    /// The revision `site.json` holds now.
    pub fn head(&self) -> &Revision {
        &self.revisions[self.head].0
    }

    pub fn can_undo(&self) -> bool {
        self.head > 0
    }

    pub fn can_redo(&self) -> bool {
        self.head + 1 < self.revisions.len()
    }

    /// The text of one revision.
    pub fn text(&self, rev: u64) -> Option<&str> {
        self.revisions.iter().find(|(r, _)| r.rev == rev).map(|(_, t)| t.as_str())
    }

    /// Runs `write`, which changes `site.json`, and records what it wrote as a new revision.
    /// Nothing is recorded if `write` fails or leaves the file as it was.
    pub fn write<T, E>(
        &mut self,
        by: By,
        summary: impl Into<String>,
        surface: Option<u64>,
        write: impl FnOnce() -> Result<T, E>,
    ) -> Result<(T, Option<Change>), E> {
        let value = write()?;
        let change = self.record(by, summary.into(), surface);
        if change.is_some() {
            // The table now holds what this version can make (#509).
            crate::version::stamp(&self.dir);
        }
        Ok((value, change))
    }

    /// Records `site.json` as it is now if it differs from the newest revision.
    fn record(&mut self, by: By, summary: String, surface: Option<u64>) -> Option<Change> {
        let after = std::fs::read_to_string(&self.site_json).ok()?;
        let before = self.revisions[self.head].1.clone();
        if same(&before, &after) {
            return None;
        }
        // A slider dragged across its range is one change, not fifty.
        let last = self.revisions.len() - 1;
        let (previous, _) = &self.revisions[last];
        if self.head == last
            && last > 0
            && surface.is_some()
            && previous.by == by
            && previous.surface == surface
            && previous.summary == summary
            && now().saturating_sub(previous.at) <= MERGE_S
        {
            let older = &self.revisions[last - 1].1;
            let keys = changed_keys(older, &after);
            let (revision, text) = &mut self.revisions[last];
            revision.at = now();
            revision.keys = keys;
            *text = after.clone();
            let revision = revision.clone();
            self.store_revision(&revision, &after);
            return Some(Change::new(before, after, revision));
        }
        let keys = changed_keys(&before, &after);
        let revision = self.push(by, summary, keys, surface, after.clone());
        Some(Change::new(before, after, revision))
    }

    fn store_revision(&self, revision: &Revision, text: &str) {
        if let Some(store) = &self.store {
            let stored = Stored { revision: revision.clone(), text: text.to_string() };
            if let Ok(json) = serde_json::to_string(&stored) {
                let _ = write_atomically(&store.join(format!("r{:08}.json", revision.rev)), &json);
            }
        }
    }

    /// Looks for a change made outside the host (the MCP server, a text editor, git) and records it.
    /// An outside tool may leave a note at [`NOTE`] saying who it is and what it did.
    pub fn check_outside(&mut self) -> Option<Change> {
        let after = std::fs::read_to_string(&self.site_json).ok()?;
        if same(&self.revisions[self.head].1, &after) {
            return None;
        }
        let keys = changed_keys(&self.revisions[self.head].1, &after);
        let note_path = self.dir.join(NOTE);
        let note = std::fs::read_to_string(&note_path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let _ = std::fs::remove_file(&note_path);
        let (by, summary) = match note {
            Some(note) if note["at"].as_u64().is_some_and(|at| now().saturating_sub(at) <= NOTE_FRESH_S) => {
                let by = match note["by"].as_str() {
                    Some("mcp") => By::Mcp,
                    _ => By::Outside,
                };
                let summary = note["summary"].as_str().map(|s| s.chars().take(120).collect::<String>());
                (by, summary.unwrap_or_else(|| outside_summary(&keys, "")))
            }
            _ => (By::Outside, outside_summary(&keys, "")),
        };
        self.record(by, summary, None)
    }

    /// Puts back the revision before the one `site.json` holds now.
    pub fn undo(&mut self) -> Result<Change, String> {
        if !self.can_undo() {
            return Err("there is nothing to undo".into());
        }
        self.move_head(self.head - 1)
    }

    /// Puts back the revision that was undone last.
    pub fn redo(&mut self) -> Result<Change, String> {
        if !self.can_redo() {
            return Err("there is nothing to redo".into());
        }
        self.move_head(self.head + 1)
    }

    /// Goes back to where `undo` or `redo` started, after the new version turned out not to load.
    pub fn step_back(&mut self, to: u64) -> Result<Change, String> {
        let at = self.revisions.iter().position(|(r, _)| r.rev == to).ok_or("that revision is no longer kept")?;
        self.move_head(at)
    }

    fn move_head(&mut self, to: usize) -> Result<Change, String> {
        let before = self.revisions[self.head].1.clone();
        let after = self.revisions[to].1.clone();
        write_atomically(&self.site_json, &after).map_err(|e| format!("could not write site.json: {e}"))?;
        self.head = to;
        self.save_head();
        Ok(Change::new(before, after, self.revisions[to].0.clone()))
    }

    /// Brings back any kept revision as a new revision at the top of the list, so nothing is lost.
    pub fn restore(&mut self, rev: u64, surface: Option<u64>) -> Result<Change, String> {
        let (old, text) = self.revisions.iter().find(|(r, _)| r.rev == rev).cloned().ok_or("that revision is no longer kept")?;
        let before = self.revisions[self.head].1.clone();
        if same(&before, &text) {
            return Err("the table is already like that".into());
        }
        write_atomically(&self.site_json, &text).map_err(|e| format!("could not write site.json: {e}"))?;
        // A restore keeps everything after the head as well: it goes on top.
        self.head = self.revisions.len() - 1;
        let keys = changed_keys(&before, &text);
        let when = old.summary.trim_end_matches('.').to_string();
        let revision = self.push(By::History, format!("Went back to: {when}"), keys, surface, text.clone());
        Ok(Change::new(before, text, revision))
    }

    fn push(&mut self, by: By, summary: String, keys: Vec<String>, surface: Option<u64>, text: String) -> Revision {
        // A new change after an undo drops what could have been redone.
        let from = (self.head + 1).min(self.revisions.len());
        let dropped: Vec<u64> = self.revisions.drain(from..).map(|(r, _)| r.rev).collect();
        let rev = self.revisions.last().map_or(0, |(r, _)| r.rev).max(dropped.iter().copied().max().unwrap_or(0)) + 1;
        let revision = Revision { rev, at: now(), by, summary, keys, surface };
        self.revisions.push((revision.clone(), text.clone()));
        self.head = self.revisions.len() - 1;
        let mut gone = dropped;
        while self.revisions.len() > KEEP {
            gone.push(self.revisions.remove(0).0.rev);
            self.head -= 1;
        }
        if let Some(store) = &self.store {
            for rev in gone {
                let _ = std::fs::remove_file(store.join(format!("r{rev:08}.json")));
            }
        }
        self.store_revision(&revision, &text);
        self.save_head();
        revision
    }

    fn save_head(&self) {
        if let Some(store) = &self.store {
            let head = Head { head: self.revisions[self.head].0.rev };
            let _ = write_atomically(&store.join("head.json"), &serde_json::to_string(&head).unwrap_or_default());
        }
    }
}

/// "Changed outside MR Studio: layers and palette".
fn outside_summary(keys: &[String], when: &str) -> String {
    let words: Vec<&str> = keys.iter().map(|k| key_words(k)).collect();
    let list = match words.as_slice() {
        [] => "spacing only".to_string(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    let when = if when.is_empty() { String::new() } else { format!(" {when}") };
    format!("Changed outside MR Studio{when}: {list}")
}

/// A site.json key in the words the editor uses.
pub fn key_words(key: &str) -> &str {
    match key {
        "layers" => "the layers",
        "custom" => "custom layers",
        "palette" => "the palette",
        "tv" => "the controller",
        "display" => "display quality",
        "origin" | "extent" => "the place",
        "table" => "the table size",
        "scene" => "the ground and buildings",
        "data" => "the data",
        "branding" => "the branding",
        "basemap" => "the base map",
        "name" => "the name",
        "*" => "the whole file",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mrs-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("site.json"), r#"{"name":"A","layers":[]}"#).unwrap();
        dir
    }

    fn edit(dir: &Path, text: &str) {
        std::fs::write(dir.join("site.json"), text).unwrap();
    }

    #[test]
    fn host_edits_outside_edits_undo_and_redo_share_one_list() {
        let dir = scratch("one-list");
        let mut h = History::open(&dir);
        assert_eq!(h.list().len(), 1);
        assert_eq!(h.head().by, By::Start);

        let (_, change) = h
            .write(By::Editor, "Added Sun study", Some(3), || -> Result<(), ()> {
                edit(&dir, r#"{"name":"A","layers":[{"use":"sunlight"}]}"#);
                Ok(())
            })
            .unwrap();
        let change = change.unwrap();
        assert_eq!(change.revision.keys, vec!["layers"]);
        assert_eq!(change.revision.surface, Some(3));
        // The host's own write is not seen again as an outside edit.
        assert!(h.check_outside().is_none());

        edit(&dir, r#"{"name":"B","layers":[{"use":"sunlight"}]}"#);
        let outside = h.check_outside().unwrap();
        assert_eq!(outside.revision.by, By::Outside);
        assert_eq!(outside.revision.summary, "Changed outside MR Studio: the name");

        let undone = h.undo().unwrap();
        assert!(undone.after.contains("\"A\""));
        assert!(std::fs::read_to_string(dir.join("site.json")).unwrap().contains("\"A\""));
        assert!(h.check_outside().is_none(), "undo is not an outside edit");
        h.undo().unwrap();
        assert!(!h.can_undo());
        h.redo().unwrap();
        assert!(h.can_redo());

        // A new change drops the redo.
        h.write(By::Editor, "Changed the palette", None, || -> Result<(), ()> {
            edit(&dir, r#"{"name":"A","layers":[{"use":"sunlight"}],"palette":{}}"#);
            Ok(())
        })
        .unwrap();
        assert!(!h.can_redo());
        assert_eq!(h.list().iter().map(|r| r.rev).collect::<Vec<_>>(), vec![1, 2, 4]);
    }

    #[test]
    fn the_history_survives_a_restart_and_sees_edits_made_while_closed() {
        let dir = scratch("restart");
        {
            let mut h = History::open(&dir);
            h.write(By::Editor, "Renamed", None, || -> Result<(), ()> {
                edit(&dir, r#"{"name":"C","layers":[]}"#);
                Ok(())
            })
            .unwrap();
            h.undo().unwrap();
        }
        let h = History::open(&dir);
        assert_eq!(h.list().len(), 2);
        assert_eq!(h.head().rev, 1, "the head is kept");
        assert!(h.can_redo());
        drop(h);

        edit(&dir, r#"{"name":"D","layers":[]}"#);
        let h = History::open(&dir);
        assert_eq!(h.head().by, By::Outside);
        assert!(h.head().summary.contains("while MR Studio was closed"));
    }

    #[test]
    fn a_revision_can_be_read_with_the_one_before_it() {
        let dir = scratch("texts");
        let mut h = History::open(&dir);
        h.write(By::Editor, "Renamed to G", None, || -> Result<(), ()> {
            edit(&dir, r#"{"name":"G","layers":[]}"#);
            Ok(())
        })
        .unwrap();
        let rev = h.head().rev;
        let (before, after) = h.texts(rev).unwrap();
        assert!(after.contains("\"G\""));
        assert!(before.is_some_and(|b| !b.contains("\"G\"")));
        assert!(h.texts(h.list()[0].rev).unwrap().0.is_none());
        assert!(h.texts(9999).is_none());
    }

    #[test]
    fn restore_puts_an_old_version_on_top_and_an_outside_tool_can_name_itself() {
        let dir = scratch("restore");
        let mut h = History::open(&dir);
        for name in ["E", "F"] {
            h.write(By::Editor, format!("Renamed to {name}"), None, || -> Result<(), ()> {
                edit(&dir, &format!(r#"{{"name":"{name}","layers":[]}}"#));
                Ok(())
            })
            .unwrap();
        }
        let back = h.restore(1, None).unwrap();
        assert_eq!(back.revision.rev, 4);
        assert_eq!(back.revision.summary, "Went back to: Opened the table");
        assert_eq!(h.list().len(), 4, "nothing is lost");

        std::fs::write(dir.join(NOTE), format!(r#"{{"by":"mcp","summary":"Added trees","at":{}}}"#, now())).unwrap();
        edit(&dir, r#"{"name":"A","layers":[{"use":"trees"}]}"#);
        let change = h.check_outside().unwrap();
        assert_eq!((change.revision.by, change.revision.summary.as_str()), (By::Mcp, "Added trees"));
        assert!(!dir.join(NOTE).exists(), "a note is used once");
    }

    #[test]
    fn a_dragged_slider_is_one_revision() {
        let dir = scratch("merge");
        let mut h = History::open(&dir);
        for n in 0..5 {
            h.write(By::Editor, "Changed Sun study: hour", Some(1), || -> Result<(), ()> {
                edit(&dir, &format!(r#"{{"name":"A","layers":[{{"use":"sunlight","params":{{"hour":{n}}}}}]}}"#));
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(h.list().len(), 2);
        h.undo().unwrap();
        assert!(!std::fs::read_to_string(dir.join("site.json")).unwrap().contains("hour"));
    }

    #[test]
    fn only_the_newest_revisions_are_kept() {
        let dir = scratch("keep");
        let mut h = History::open(&dir);
        for n in 0..KEEP + 5 {
            h.write(By::Editor, "x", None, || -> Result<(), ()> {
                edit(&dir, &format!(r#"{{"name":"{n}"}}"#));
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(h.list().len(), KEEP);
        let files = std::fs::read_dir(dir.join(DIR))
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with('r'))
            .count();
        assert_eq!(files, KEEP);
    }
}
