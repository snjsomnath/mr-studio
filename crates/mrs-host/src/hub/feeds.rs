//! What the outside answered during a recorded session (#523), so playback shows what people
//! saw. While a session records, each answer the host passes on from outside (public transport,
//! WMS map pictures, a source's tiles and proxied requests, a table's own services) is kept in
//! the recording's folder with its time: `feeds.jsonl` says when and for which address, and
//! `feeds/` holds each different answer once. A host playing the recording answers those
//! addresses from there, as they were at that moment, and reaches nothing outside.

use std::hash::{Hash, Hasher};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::Hub;

/// The most a recording keeps of outside answers. Past it, playback shows nothing new from outside.
pub const MAX_FEED_BYTES: u64 = 512 * 1024 * 1024;

/// One kept answer, a line of `feeds.jsonl`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FeedLine {
    /// Milliseconds from the start of the recording.
    pub t: u64,
    /// The address asked, with its query: `/api/transit/vasttrafik/vehicles?bbox=...`.
    pub url: String,
    pub status: u16,
    #[serde(default)]
    pub r#type: String,
    /// The answer's file in `feeds/`.
    pub file: String,
}

/// The addresses whose answers come from outside.
pub fn is_feed(path: &str) -> bool {
    path == "/api/wms"
        || path.starts_with("/api/transit/")
        || (path.starts_with("/api/sources/") && (path.ends_with("/proxy") || path.contains("/tile/")))
        || path.starts_with("/api/services/") && path.contains("/call")
}

static WRITING: Mutex<()> = Mutex::new(());

/// Keeps one answer in a recording's folder. Errors are logged, never passed on: a recording
/// missing an answer still plays, and the live page must not suffer for it.
pub fn keep(folder: &Path, t: u64, url: &str, status: u16, content_type: &str, body: &[u8]) {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut hasher);
    let file = format!("{:016x}-{}.bin", hasher.finish(), body.len());
    let _writing = WRITING.lock();
    let written = (|| -> std::io::Result<()> {
        let dir = folder.join("feeds");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(&file);
        if !path.exists() {
            std::fs::write(&path, body)?;
        }
        let line = FeedLine { t, url: url.to_string(), status, r#type: content_type.to_string(), file };
        let mut index = std::fs::OpenOptions::new().create(true).append(true).open(folder.join("feeds.jsonl"))?;
        writeln!(index, "{}", serde_json::to_string(&line).map_err(std::io::Error::other)?)
    })();
    if let Err(e) = written {
        tracing::warn!("recording: an outside answer for {url} was not kept: {e}");
    }
}

/// A recording's kept answers, oldest first.
pub fn read(folder: &Path) -> Vec<FeedLine> {
    std::fs::read_to_string(folder.join("feeds.jsonl"))
        .map(|text| text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
        .unwrap_or_default()
}

/// The answer for `url` at `at`: the last one kept at or before it, else the first after it.
pub fn answer<'a>(feeds: &'a [FeedLine], url: &str, at: u64) -> Option<&'a FeedLine> {
    let same = || feeds.iter().filter(move |f| f.url == url);
    same().rev().find(|f| f.t <= at).or_else(|| same().next())
}

impl Hub {
    /// Whether a session is being recorded now.
    pub fn is_recording(&self) -> bool {
        self.recording.lock().is_some()
    }

    /// While a session records and has room for `bytes` more: its folder and the time now. The
    /// room is taken when this answers.
    pub fn feed_to_keep(&self, bytes: u64) -> Option<(PathBuf, u64)> {
        let mut recording = self.recording.lock();
        let recording = recording.as_mut()?;
        if recording.feed_bytes + bytes > MAX_FEED_BYTES {
            return None;
        }
        recording.feed_bytes += bytes;
        Some((recording.dir().to_path_buf(), recording.now_ms()))
    }

    /// While this host plays a recording back: the kept answer for `url` at the playback time,
    /// as (status, content type, file). `Some(None)` when it plays and has no answer for it.
    pub fn feed_played(&self, url: &str) -> Option<Option<(u16, String, PathBuf)>> {
        let playback = self.playback.lock();
        let playback = playback.as_ref()?;
        Some(answer(&playback.feeds, url, playback.at).map(|f| (f.status, f.r#type.clone(), playback.folder.join("feeds").join(&f.file))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_is_kept_once_and_found_by_its_time() {
        let dir = std::env::temp_dir().join(format!("mrs-feeds-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let url = "/api/transit/vt/vehicles";
        keep(&dir, 1000, url, 200, "application/json", b"[1]");
        keep(&dir, 5000, url, 200, "application/json", b"[2]");
        keep(&dir, 9000, url, 200, "application/json", b"[1]");
        assert_eq!(std::fs::read_dir(dir.join("feeds")).unwrap().count(), 2, "the same answer is one file");
        let feeds = read(&dir);
        let body = |at| std::fs::read(dir.join("feeds").join(&answer(&feeds, url, at).unwrap().file)).unwrap();
        assert_eq!(body(0), b"[1]", "before the first, the first");
        assert_eq!(body(6000), b"[2]");
        assert_eq!(body(9500), b"[1]");
        assert!(answer(&feeds, "/api/wms?x=1", 0).is_none());
        assert!(is_feed("/api/wms") && is_feed("/api/sources/lm/proxy") && is_feed("/api/services/x/call/now"));
        assert!(!is_feed("/api/sources") && !is_feed("/api/data/media"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
