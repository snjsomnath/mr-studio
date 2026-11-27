//! Recorded sessions (#520): while recording is on, the host keeps a log of the session.
//!
//! A recording is a folder in the app's own data folder, never in the table's folder:
//!
//! - `recording.json`: the catalogue (name, date, facilitator, purpose, notes, tags,
//!   chapters) and what made it (app and layer versions, the table's id and name).
//! - `start.json`: the start snapshot (#521): `site.json` as it was and the whole session
//!   state every surface was sent.
//! - `log.jsonl`: one line per timed event, appended as it happens, so a crash loses at
//!   most the line being written.
//! - `checkpoints.jsonl` (#524): the session state about once a minute and at each chapter
//!   mark, with how many log lines came before it. Seeking starts from the nearest one and
//!   replays only the lines after it.
//!
//! The format is in `docs/contracts/recording.md`. Every request a surface sends passes
//! through the hub, so the log taps that: a new layer or request is recorded with no code of
//! its own.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::*;

/// The version of the files in a recording folder.
pub const RECORDING_FORMAT: u32 = 1;

/// A recording stops by itself after this long (#522) and says so.
pub const MAX_RECORDING: Duration = Duration::from_secs(8 * 60 * 60);

/// How often a checkpoint of the session state is written while requests come in (#524).
pub const CHECKPOINT_EVERY: Duration = Duration::from_secs(60);

/// Requests that only read, or that are about recording itself: not in the log.
const NOT_LOGGED: &[&str] = &["site.sources", "history.list", "phones.log"];

/// What the controller shows while a recording runs: the red dot and the time (#522).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RecordingInfo {
    pub id: String,
    pub name: String,
    /// When it started, Unix milliseconds.
    pub started: u64,
    pub chapters: Vec<Chapter>,
}

/// A chapter mark: milliseconds since the start, and an optional title.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct Chapter {
    pub t: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// `recording.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Catalogue {
    pub format: u32,
    pub id: String,
    pub name: String,
    /// The day of the session, `YYYY-MM-DD`.
    pub date: String,
    #[serde(default)]
    pub facilitator: String,
    #[serde(default)]
    pub purpose: String,
    /// Context notes from the start, and the wrap-up notes after.
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub chapters: Vec<Chapter>,
    /// Unix milliseconds.
    pub started: u64,
    /// Length in milliseconds; 0 while it runs.
    #[serde(default)]
    pub length: u64,
    /// Events in the log.
    #[serde(default)]
    pub events: u64,
    /// False until it is stopped. A recording left unfinished by a crash is offered to keep.
    #[serde(default)]
    pub finished: bool,
    /// True once the wrap-up is saved.
    #[serde(default)]
    pub wrapped: bool,
    pub table: Value,
    pub app_version: String,
    /// Each layer package's version, by id.
    pub layers: Map<String, Value>,
}

pub(super) struct Recording {
    dir: PathBuf,
    started: Instant,
    log: std::fs::File,
    checkpoints: std::fs::File,
    /// When the last checkpoint was written, in ms from the start (#524).
    last_checkpoint: u64,
    catalogue: Catalogue,
    /// Set when writing the log failed: the recording stops at the next request.
    failed: Option<String>,
}

impl Recording {
    fn ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn write(&mut self, mut line: Value) {
        line["t"] = json!(self.ms());
        let text = line.to_string() + "\n";
        if let Err(e) = self.log.write_all(text.as_bytes()) {
            self.failed.get_or_insert_with(|| format!("the session log could not be written: {e}"));
            return;
        }
        self.catalogue.events += 1;
    }

    /// Appends the session state as it is now after `events` log lines (#524).
    fn checkpoint(&mut self, state: Value) {
        let t = self.ms();
        let line = json!({ "t": t, "after": self.catalogue.events, "state": state }).to_string() + "\n";
        if let Err(e) = self.checkpoints.write_all(line.as_bytes()) {
            self.failed.get_or_insert_with(|| format!("a checkpoint could not be written: {e}"));
        }
        self.last_checkpoint = t;
    }

    fn checkpoint_due(&self) -> bool {
        self.ms().saturating_sub(self.last_checkpoint) >= CHECKPOINT_EVERY.as_millis() as u64
    }

    fn info(&self) -> RecordingInfo {
        RecordingInfo {
            id: self.catalogue.id.clone(),
            name: self.catalogue.name.clone(),
            started: self.catalogue.started,
            chapters: self.catalogue.chapters.clone(),
        }
    }
}

fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// `YYYY-MM-DD` for Unix milliseconds, in UTC.
fn day(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Where recordings are kept when nothing else is set: `MRS_RECORDINGS_DIR`, or a
/// `recordings` folder in the desktop app's data folder, the same one Home reads (#525).
pub fn default_recordings_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("MRS_RECORDINGS_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let data = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming"))
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"))
    };
    data.join("app.mrstudio.studio").join("recordings")
}

fn text(p: &Value, key: &str, max: usize) -> Result<String, String> {
    match &p[key] {
        Value::Null => Ok(String::new()),
        Value::String(s) if s.chars().count() <= max => Ok(s.trim().to_string()),
        Value::String(_) => Err(format!("{key} is longer than {max} characters")),
        _ => Err(format!("{key} is text")),
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)? + "\n";
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, text)?;
    std::fs::rename(partial, path)
}

/// Every recording in `dir`, newest first (#525).
pub fn list_recordings(dir: &Path) -> Vec<Catalogue> {
    let mut list: Vec<Catalogue> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path().join("recording.json")).ok())
        .filter_map(|text| serde_json::from_str(&text).ok())
        .collect();
    list.sort_by_key(|c| std::cmp::Reverse(c.started));
    list
}

impl Hub {
    pub(super) fn recordings_dir(&self) -> PathBuf {
        self.options.recordings_dir.clone().unwrap_or_else(default_recordings_dir)
    }

    /// The recording running now, for the controller's red dot.
    pub fn recording(&self) -> Option<RecordingInfo> {
        self.recording.lock().as_ref().map(Recording::info)
    }

    /// Writes a request to the log, while the hub's lock is held so the log keeps the order
    /// the requests were handled in.
    pub(super) fn record_request(&self, inner: &Inner, role: Role, surface: u64, method: &str, p: &Value) {
        if NOT_LOGGED.contains(&method) || method.starts_with("recording.") {
            return;
        }
        let due = {
            let mut recording = self.recording.lock();
            let Some(recording) = recording.as_mut() else { return };
            let slot = inner.seats.iter().find(|s| s.participant.surface == surface).map(|s| s.participant.slot);
            recording.write(json!({ "k": "request", "role": role.name(), "surface": surface, "slot": slot, "m": method, "p": p }));
            recording.checkpoint_due()
        };
        if due {
            self.write_checkpoint(inner);
        }
    }

    /// The state a checkpoint keeps (#524): what the start snapshot keeps, less the site.
    fn checkpoint_state(&self, inner: &Inner) -> Value {
        // session() takes the recording lock itself, so this runs before it is taken.
        let mut session = self.session();
        session.recording = None;
        json!({ "session": session, "scene": inner.order(), "layers": inner.layers(), "participants": inner.participants() })
    }

    /// Writes a checkpoint now, while the hub's lock is held so it falls between two log lines.
    fn write_checkpoint(&self, inner: &Inner) {
        let state = self.checkpoint_state(inner);
        if let Some(recording) = self.recording.lock().as_mut() {
            recording.checkpoint(state);
        }
    }

    /// Puts a hub's layers and session back as a checkpoint has them (#524): which layers are
    /// on, their order, params, shared values, steps, picks and play heads, and the language,
    /// sound and ribbon. The layers themselves come from the hub's own site, so a layer the
    /// checkpoint names and the site no longer has is left out.
    pub fn restore(&self, state: &Value) {
        let mut inner = self.inner.lock();
        let order: Vec<&str> = state["scene"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        inner.scene.sort_by_key(|i| order.iter().position(|id| *id == i.id).unwrap_or(usize::MAX));
        for instance in inner.scene.iter_mut() {
            let Some(saved) = state["layers"].get(&instance.id) else { continue };
            let s = &mut instance.state;
            s.active = saved["active"].as_bool().unwrap_or(s.active);
            s.intensity = saved["intensity"].as_f64().unwrap_or(s.intensity);
            if let Some(params) = saved["params"].as_object() {
                s.params = params.clone();
            }
            s.shared = saved["shared"].as_object().cloned().unwrap_or_default();
            s.step = serde_json::from_value(saved["step"].clone()).unwrap_or(None);
            s.shown_by = saved["shown_by"].as_str().map(str::to_string);
            s.selection = saved.get("selection").filter(|v| !v.is_null()).cloned();
            s.clock = serde_json::from_value(saved["clock"].clone()).unwrap_or(None);
        }
        let session = &state["session"];
        if let Some(language) = session["language"].as_str() {
            *self.language.write() = language.to_string();
        }
        if let Some(sound) = session["sound"].as_bool() {
            *self.sound.write() = sound;
        }
        *self.ribbon.write() = session["ribbon"].as_str().map(str::to_string);
        self.emit("state.scene", json!({ "scene": inner.order(), "layers": inner.layers() }));
        drop(inner);
        self.emit("session.changed", json!({ "session": self.session() }));
    }

    /// Writes a phone joining or leaving to the log.
    pub(super) fn record_phone(&self, what: &str, surface: u64, slot: Option<usize>) {
        if let Some(recording) = self.recording.lock().as_mut() {
            recording.write(json!({ "k": what, "role": "phone", "surface": surface, "slot": slot }));
        }
    }

    /// Stops a recording that ran too long or whose log cannot be written, and says why.
    pub(super) fn recording_limits(&self) {
        let why = {
            let recording = self.recording.lock();
            match recording.as_ref() {
                Some(r) if r.failed.is_some() => r.failed.clone(),
                Some(r) if r.started.elapsed() >= MAX_RECORDING => Some("the recording reached 8 hours and stopped by itself".to_string()),
                _ => None,
            }
        };
        if let Some(why) = why {
            tracing::warn!("{why}");
            let _ = self.stop_recording();
            self.emit("recording.stopped", json!({ "why": why }));
        }
    }

    /// `recording.*` requests (#521, #522). Only the operator's screens record.
    pub(super) fn recording_request(&self, role: Role, method: &str, p: &Value) -> Result<Value, String> {
        if !matches!(role, Role::Tv | Role::Dev | Role::Guide) {
            return Err("only the operator records a session".into());
        }
        match method {
            "recording.start" => self.start_recording(p),
            "recording.chapter" => {
                let title = text(p, "title", 80)?;
                let inner = self.inner.lock();
                let state = self.checkpoint_state(&inner);
                let info = {
                    let mut recording = self.recording.lock();
                    let recording = recording.as_mut().ok_or("nothing is being recorded")?;
                    let chapter = Chapter { t: recording.ms(), title: (!title.is_empty()).then_some(title) };
                    recording.catalogue.chapters.push(chapter.clone());
                    recording.write(json!({ "k": "chapter", "title": chapter.title }));
                    // Each chapter is a place to jump to, so it gets a checkpoint (#524).
                    recording.checkpoint(state);
                    recording.info()
                };
                drop(inner);
                self.emit("session.changed", json!({ "session": self.session() }));
                Ok(json!({ "recording": info }))
            }
            "recording.stop" => {
                let catalogue = self.stop_recording()?;
                Ok(json!({ "recording": catalogue }))
            }
            "recording.wrapup" => self.wrap_up(p),
            "recording.list" => Ok(json!({ "recordings": list_recordings(&self.recordings_dir()) })),
            "recording.status" => Ok(json!({ "recording": self.recording() })),
            other => Err(format!("unknown method '{other}'")),
        }
    }

    fn start_recording(&self, p: &Value) -> Result<Value, String> {
        let name = text(p, "name", 120)?;
        let (facilitator, purpose, notes) = (text(p, "facilitator", 120)?, text(p, "purpose", 400)?, text(p, "notes", 4000)?);
        let started = unix_ms();
        let date = match text(p, "date", 10)? {
            d if d.is_empty() => day(started),
            d if d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-' => d,
            _ => return Err("date is YYYY-MM-DD".into()),
        };
        let info = self.info.read().clone();
        let name = if name.is_empty() { format!("{} {date}", info.name) } else { name };
        let site_json: Value = std::fs::read_to_string(self.site.dir.join("site.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .ok_or("site.json could not be read for the recording")?;
        let layers: Map<String, Value> = self
            .catalog()
            .iter()
            .map(|d| (d.manifest["id"].as_str().unwrap_or_default().to_string(), d.manifest["version"].clone()))
            .collect();

        // The snapshot and the switch happen under the hub's lock, so no request falls between.
        let inner = self.inner.lock();
        let mut session = self.session();
        session.recording = None;
        let mut recording = self.recording.lock();
        if recording.is_some() {
            return Err("a recording is already running; stop it first".into());
        }
        let id = format!("{}-{:06x}", date, random_u64() % 0x100_0000);
        let dir = self.recordings_dir().join(&id);
        let io = |e: std::io::Error| format!("the recording could not be started in {}: {e}", dir.display());
        std::fs::create_dir_all(&dir).map_err(io)?;
        let start = json!({
            "format": RECORDING_FORMAT,
            "site": site_json,
            "state": {
                "protocol": PROTOCOL,
                "session": session,
                "site": info,
                "scene": inner.order(),
                "layers": inner.layers(),
                "participants": inner.participants(),
            },
        });
        write_json(&dir.join("start.json"), &start).map_err(io)?;
        let catalogue = Catalogue {
            format: RECORDING_FORMAT,
            id: id.clone(),
            name,
            date,
            facilitator,
            purpose,
            notes,
            tags: Vec::new(),
            chapters: Vec::new(),
            started,
            length: 0,
            events: 0,
            finished: false,
            wrapped: false,
            table: json!({ "id": info.id, "name": info.name }),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            layers,
        };
        write_json(&dir.join("recording.json"), &catalogue).map_err(io)?;
        let open = |name: &str| std::fs::OpenOptions::new().create(true).append(true).open(dir.join(name));
        let log = open("log.jsonl").map_err(io)?;
        let checkpoints = open("checkpoints.jsonl").map_err(io)?;
        let new = Recording { dir, started: Instant::now(), log, checkpoints, last_checkpoint: 0, catalogue, failed: None };
        let info = new.info();
        *recording = Some(new);
        drop(recording);
        drop(inner);
        self.emit("session.changed", json!({ "session": self.session() }));
        Ok(json!({ "recording": info }))
    }

    /// Stops the recording and keeps it, unfinished until the wrap-up is saved.
    pub fn stop_recording(&self) -> Result<Catalogue, String> {
        let mut recording = self.recording.lock().take().ok_or("nothing is being recorded")?;
        recording.write(json!({ "k": "stop" }));
        recording.catalogue.length = recording.ms();
        recording.catalogue.finished = true;
        let _ = recording.log.flush();
        write_json(&recording.dir.join("recording.json"), &recording.catalogue)
            .map_err(|e| format!("the recording could not be saved: {e}"))?;
        self.emit("session.changed", json!({ "session": self.session() }));
        Ok(recording.catalogue)
    }

    /// `recording.wrapup`: the notes, tags and chapters after a recording stopped, or
    /// `discard: true` to delete it (#522).
    fn wrap_up(&self, p: &Value) -> Result<Value, String> {
        let id = p["id"].as_str().ok_or("say which recording: id")?;
        if id.contains(['/', '\\']) || id.starts_with('.') {
            return Err("not a recording".into());
        }
        if self.recording.lock().as_ref().is_some_and(|r| r.catalogue.id == id) {
            return Err("stop the recording first".into());
        }
        let dir = self.recordings_dir().join(id);
        let file = dir.join("recording.json");
        let mut catalogue: Catalogue = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .ok_or_else(|| format!("no recording '{id}'"))?;
        if p["discard"] == true {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("the recording could not be deleted: {e}"))?;
            return Ok(json!({ "discarded": id }));
        }
        if !p["name"].is_null() {
            let name = text(p, "name", 120)?;
            if !name.is_empty() {
                catalogue.name = name;
            }
        }
        if !p["notes"].is_null() {
            catalogue.notes = text(p, "notes", 8000)?;
        }
        if let Some(tags) = p.get("tags").filter(|t| !t.is_null()) {
            let tags: Vec<String> = serde_json::from_value(tags.clone()).map_err(|_| "tags is a list of words".to_string())?;
            catalogue.tags = tags.into_iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).take(20).collect();
        }
        if let Some(chapters) = p.get("chapters").filter(|c| !c.is_null()) {
            let chapters: Vec<Chapter> =
                serde_json::from_value(chapters.clone()).map_err(|_| "chapters is a list of { t, title }".to_string())?;
            catalogue.chapters = chapters.into_iter().filter(|c| catalogue.length == 0 || c.t <= catalogue.length).collect();
            catalogue.chapters.sort_by_key(|c| c.t);
        }
        catalogue.finished = true;
        catalogue.wrapped = true;
        write_json(&file, &catalogue).map_err(|e| format!("the recording could not be saved: {e}"))?;
        Ok(json!({ "recording": catalogue }))
    }
}

/// Replays a recording's log onto a hub started from its snapshot, as far as `until`
/// milliseconds (#521, #524). Requests that failed when they were recorded fail the same way
/// again, which changes nothing. Returns how many requests were replayed.
pub fn replay(hub: &Hub, log: &str, until: Option<u64>) -> usize {
    let mut replayed = 0;
    for line in log.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
        if until.is_some_and(|until| event["t"].as_u64().unwrap_or(0) > until) {
            break;
        }
        if event["k"] != "request" {
            continue;
        }
        let (Some(role), Some(method)) = (event["role"].as_str().and_then(Role::parse), event["m"].as_str()) else { continue };
        let _ = hub.request(role, event["surface"].as_u64().unwrap_or(0), method, &event["p"]);
        replayed += 1;
    }
    replayed
}

/// Shows a recording at `until` milliseconds on a hub opened on its table (#524): puts back
/// the nearest checkpoint at or before that time (the start snapshot when there is none) and
/// replays only the log lines after it. Works forwards and backwards. A line an older or newer
/// app cannot make sense of fails and changes nothing, and the next checkpoint puts the state
/// right again. Returns how many requests were replayed.
pub fn seek(hub: &Hub, folder: &Path, until: u64) -> Result<usize, String> {
    let read = |name: &str| std::fs::read_to_string(folder.join(name)).map_err(|e| format!("{name} could not be read: {e}"));
    let start: Value = serde_json::from_str(&read("start.json")?).map_err(|e| format!("start.json: {e}"))?;
    let checkpoints = read("checkpoints.jsonl").unwrap_or_default();
    let nearest = checkpoints
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .take_while(|c| c["t"].as_u64().unwrap_or(u64::MAX) <= until)
        .last();
    let (state, after) = match &nearest {
        Some(c) => (&c["state"], c["after"].as_u64().unwrap_or(0) as usize),
        None => (&start["state"], 0),
    };
    hub.restore(state);
    let log = read("log.jsonl")?;
    let rest: String = log.lines().skip(after).map(|l| format!("{l}\n")).collect();
    Ok(replay(hub, &rest, Some(until)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::test_support::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mrs-recordings-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn days_are_written_as_dates() {
        assert_eq!(day(0), "1970-01-01");
        assert_eq!(day(1_795_788_000_000), "2026-11-27");
        assert_eq!(day(951_782_400_000), "2000-02-29");
    }

    #[test]
    fn a_recorded_session_rebuilds_its_final_state() {
        // #521's done-when: a controller and two phones, then the log alone rebuilds the state.
        let dir = scratch_dir("rebuild");
        let mut hub = scratch_hub("recording");
        hub.options.recordings_dir = Some(dir.clone());
        let code = hub.session().code;
        let phone_a = hub.join(Role::Phone, Some(&code), None).unwrap().surface;

        assert!(hub.request(Role::Phone, phone_a, "recording.start", &json!({})).is_err(), "phones do not record");
        let started = hub.request(Role::Tv, 1, "recording.start", &json!({ "facilitator": "Sanjay", "purpose": "Test" })).unwrap();
        let id = started["recording"]["id"].as_str().unwrap().to_string();
        assert!(hub.session().recording.is_some(), "the controller shows the red dot");
        assert!(hub.request(Role::Tv, 1, "recording.start", &json!({})).is_err(), "one at a time");

        let phone_b = hub.join(Role::Phone, Some(&code), None).unwrap().surface;
        hub.request(Role::Tv, 1, "layer.activate", &json!({ "layer": "sunlight", "active": true })).unwrap();
        hub.request(Role::Tv, 1, "layer.set", &json!({ "layer": "sunlight", "params": { "hour": 9.5 } })).unwrap();
        hub.request(Role::Tv, 1, "recording.chapter", &json!({ "title": "Morning" })).unwrap();
        hub.request(Role::Phone, phone_a, "layer.activate", &json!({ "layer": "trees", "active": true })).unwrap();
        let _ = hub.request(Role::Phone, phone_b, "layer.set", &json!({ "layer": "sunlight", "params": { "hour": 17 } }));
        assert!(hub.request(Role::Tv, 1, "layer.set", &json!({ "layer": "ghost", "params": {} })).is_err());
        hub.request(Role::Tv, 1, "session.language", &json!({ "language": "en" })).unwrap();
        hub.leave(phone_b);
        let stopped = hub.request(Role::Tv, 1, "recording.stop", &json!({})).unwrap();
        assert!(hub.session().recording.is_none());
        assert_eq!(stopped["recording"]["chapters"][0]["title"], "Morning");
        assert!(stopped["recording"]["events"].as_u64().unwrap() >= 8, "{stopped}");

        // A fresh hub on the snapshot's site, with the log replayed, ends where the session did.
        let folder = dir.join(&id);
        let start: Value = serde_json::from_str(&std::fs::read_to_string(folder.join("start.json")).unwrap()).unwrap();
        assert!(start["state"]["layers"]["sunlight"].is_object(), "the snapshot holds the session state");
        assert_eq!(start["site"]["id"], "sample");
        let log = std::fs::read_to_string(folder.join("log.jsonl")).unwrap();
        assert!(log.lines().any(|l| l.contains("\"k\":\"join\"")), "joins are logged");
        assert!(log.lines().any(|l| l.contains("\"k\":\"leave\"")), "leaves are logged");
        let again = scratch_hub_with("recording-again", |dir| {
            std::fs::write(dir.join("site.json"), serde_json::to_string_pretty(&start["site"]).unwrap()).unwrap();
        });
        // The phones come back as the log says, in the same seats.
        let code = again.session().code;
        let (a, b) =
            (again.join(Role::Phone, Some(&code), None).unwrap().surface, again.join(Role::Phone, Some(&code), None).unwrap().surface);
        assert_eq!((a, b), (phone_a, phone_b));
        assert!(replay(&again, &log, None) >= 6);
        assert_eq!(again.welcome(0)["state"]["layers"], hub.welcome(0)["state"]["layers"]);
        assert_eq!(again.welcome(0)["state"]["scene"], hub.welcome(0)["state"]["scene"]);

        // The wrap-up: notes, tags, a renamed chapter. Then it is in the list.
        let wrapped = hub
            .request(
                Role::Tv,
                1,
                "recording.wrapup",
                &json!({ "id": id, "notes": "Went well", "tags": ["workshop", " "], "chapters": [{ "t": 5, "title": "Start" }] }),
            )
            .unwrap();
        assert_eq!(wrapped["recording"]["tags"], json!(["workshop"]));
        assert_eq!(wrapped["recording"]["wrapped"], true);
        let list = hub.request(Role::Dev, 0, "recording.list", &json!({})).unwrap();
        assert_eq!(list["recordings"][0]["id"], id.as_str());
        assert_eq!(list["recordings"][0]["facilitator"], "Sanjay");
        assert!(hub.request(Role::Tv, 1, "recording.wrapup", &json!({ "id": "../x" })).is_err());
        hub.request(Role::Tv, 1, "recording.wrapup", &json!({ "id": id, "discard": true })).unwrap();
        assert!(!folder.exists());
    }

    #[test]
    fn seeking_to_a_checkpoint_shows_what_replaying_everything_shows() {
        // #524's done-when: the state at each checkpoint, reached by seeking forwards and
        // backwards, equals the state from replaying every event from the start to that time.
        let dir = scratch_dir("seek");
        let mut hub = scratch_hub("seek");
        hub.options.recordings_dir = Some(dir.clone());
        let tv = |method: &str, p: Value| {
            std::thread::sleep(Duration::from_millis(3));
            hub.request(Role::Tv, 1, method, &p).unwrap()
        };
        let id = tv("recording.start", json!({}))["recording"]["id"].as_str().unwrap().to_string();
        tv("layer.activate", json!({ "layer": "sunlight", "active": true }));
        tv("layer.set", json!({ "layer": "sunlight", "params": { "hour": 9.5 } }));
        tv("recording.chapter", json!({ "title": "Morning" }));
        tv("layer.set", json!({ "layer": "sunlight", "params": { "hour": 12 } }));
        tv("layer.activate", json!({ "layer": "trees", "active": false }));
        tv("session.language", json!({ "language": "sv" }));
        tv("recording.chapter", json!({ "title": "Noon" }));
        tv("layer.set", json!({ "layer": "sunlight", "params": { "hour": 17 } }));
        tv("layer.activate", json!({ "layer": "sunlight", "active": false }));
        let end = tv("recording.stop", json!({}))["recording"]["length"].as_u64().unwrap();
        let folder = dir.join(&id);
        let checkpoints: Vec<Value> =
            std::fs::read_to_string(folder.join("checkpoints.jsonl")).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(checkpoints.len(), 2, "one at each chapter");
        let log = std::fs::read_to_string(folder.join("log.jsonl")).unwrap();
        let start: Value = serde_json::from_str(&std::fs::read_to_string(folder.join("start.json")).unwrap()).unwrap();
        let site = |dir: &std::path::Path| std::fs::write(dir.join("site.json"), start["site"].to_string()).unwrap();
        let state = |hub: &Hub| {
            let w = hub.welcome(0)["state"].clone();
            (w["scene"].clone(), w["layers"].clone(), w["session"]["language"].clone())
        };

        let player = scratch_hub_with("seek-player", site);
        let mut times: Vec<u64> = checkpoints.iter().map(|c| c["t"].as_u64().unwrap()).collect();
        times.extend([end, 1, times[0] - 1, times[1], times[0], 0]);
        for (n, t) in times.into_iter().enumerate() {
            let replayed = seek(&player, &folder, t).unwrap();
            let fresh = scratch_hub_with(&format!("seek-fresh-{n}"), site);
            let everything = replay(&fresh, &log, Some(t));
            assert!(replayed <= everything, "a checkpoint saves replaying");
            assert_eq!(state(&player), state(&fresh), "at {t} ms");
        }
        assert_eq!(state(&player).2, "en", "back at the start");
        seek(&player, &folder, checkpoints[1]["t"].as_u64().unwrap()).unwrap();
        assert_eq!(state(&player).2, "sv");
        assert_eq!(layer_of(&player, "trees")["active"], false);
    }

    fn layer_of(hub: &Hub, id: &str) -> Value {
        hub.welcome(0)["state"]["layers"][id].clone()
    }
}
