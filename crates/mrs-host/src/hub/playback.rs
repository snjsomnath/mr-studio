//! The playback room (#526): a host opened on a recording plays its log back onto a frozen copy
//! of the table, to the same table and controller pages that run live. Nothing from the pages
//! changes anything: only the log does, as the room moves through time.

use std::cell::Cell;
use std::path::{Path, PathBuf};

use super::recording::CHECKPOINT_EVERY;
use super::*;

thread_local! {
    /// Set while the playback replays the log, so those requests pass the read-only gate.
    static REPLAYING: Cell<bool> = const { Cell::new(false) };
}

/// What the pages are told about the recording being played (#526): the controller shows a
/// banner, and phones cannot join.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PlaybackInfo {
    pub id: String,
    pub name: String,
    pub date: String,
    /// Milliseconds.
    pub length: u64,
}

pub(super) struct Playback {
    pub(super) folder: PathBuf,
    catalogue: Catalogue,
    /// The log's lines, parsed.
    lines: Vec<Value>,
    /// Where the hub is now, in milliseconds, and how many log lines are applied.
    pub(super) at: u64,
    applied: usize,
    /// What the outside answered while it was recorded (#523).
    pub(super) feeds: Vec<super::feeds::FeedLine>,
}

/// One thing that happened, in words for the room's event list and timeline (#526, #527).
fn summary(event: &Value) -> String {
    let who = match (event["role"].as_str(), event["slot"].as_u64()) {
        (Some("phone"), Some(slot)) => format!("Phone {}", slot + 1),
        (Some("tv"), _) => "Controller".into(),
        (Some("guide"), _) => "Guide".into(),
        (Some("dev"), _) => "Operator".into(),
        (Some("table"), _) => "Table".into(),
        _ => "Someone".into(),
    };
    let p = &event["p"];
    let layer = p["layer"].as_str().unwrap_or("a layer");
    match (event["k"].as_str(), event["m"].as_str()) {
        (Some("join"), _) => format!("{who} joined"),
        (Some("leave"), _) => format!("{who} left"),
        (Some("chapter"), _) => format!("Chapter: {}", event["title"].as_str().unwrap_or("untitled")),
        (Some("stop"), _) => "The recording ended".into(),
        (_, Some("layer.activate")) if p["active"] == true => format!("{who} opened {layer}"),
        (_, Some("layer.activate")) => format!("{who} closed {layer}"),
        (_, Some("layer.set")) => format!("{who} changed {layer}"),
        (_, Some("layer.step")) => format!("{who} moved {layer} on"),
        (_, Some("layer.action")) => format!("{who} pressed {} on {layer}", p["action"].as_str().unwrap_or("a button")),
        (_, Some("tool.input")) => format!("{who} drew or marked on {layer}"),
        (_, Some("layers.reset")) => format!("{who} reset the table"),
        (_, Some("participant.profile")) => format!("{who} changed their name or animal"),
        (_, Some("session.language")) => format!("{who} switched the language to {}", p["language"].as_str().unwrap_or("?")),
        (_, Some(m)) => format!("{who}: {m}"),
        _ => who,
    }
}

/// The kind of an event, for the room's filters (#527).
fn kind(event: &Value) -> &'static str {
    match (event["k"].as_str(), event["m"].as_str()) {
        (Some("join" | "leave"), _) => "people",
        (Some("chapter" | "stop"), _) => "chapters",
        (_, Some("tool.input")) => "sketches",
        (_, Some(m)) if m.starts_with("layer") => "layers",
        _ => "settings",
    }
}

impl Playback {
    pub(super) fn open(folder: &Path) -> Result<(Self, Value), String> {
        let read = |name: &str| std::fs::read_to_string(folder.join(name)).map_err(|e| format!("{name} could not be read: {e}"));
        let catalogue: Catalogue = serde_json::from_str(&read("recording.json")?).map_err(|e| format!("recording.json: {e}"))?;
        let start: Value = serde_json::from_str(&read("start.json")?).map_err(|e| format!("start.json: {e}"))?;
        let lines = read("log.jsonl")?.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        let feeds = super::feeds::read(folder);
        let playback = Playback { folder: folder.to_path_buf(), catalogue, lines, at: 0, applied: 0, feeds };
        Ok((playback, start["state"].clone()))
    }

    fn info(&self) -> PlaybackInfo {
        PlaybackInfo {
            id: self.catalogue.id.clone(),
            name: self.catalogue.name.clone(),
            date: self.catalogue.date.clone(),
            length: self.length(),
        }
    }

    fn length(&self) -> u64 {
        self.catalogue.length.max(self.lines.last().and_then(|l| l["t"].as_u64()).unwrap_or(0))
    }
}

impl Hub {
    /// Opens the recording this host plays (#526), from `SessionOptions::playback`.
    pub(super) fn start_playback(&self) -> Result<(), String> {
        let Some(folder) = self.options.playback.clone() else { return Ok(()) };
        let (playback, start) = Playback::open(&folder)?;
        self.restore(&start);
        *self.playback.lock() = Some(playback);
        Ok(())
    }

    /// The recording being played, for the pages' banner.
    pub fn playback(&self) -> Option<PlaybackInfo> {
        self.playback.lock().as_ref().map(Playback::info)
    }

    /// Whether this request is refused because the host plays a recording (#526): only the
    /// log changes anything. The table's own reports (what it draws, its health) still come in.
    pub(super) fn refused_in_playback(&self, role: Role, method: &str) -> bool {
        if self.options.playback.is_none() || REPLAYING.with(Cell::get) || method.starts_with("playback.") {
            return false;
        }
        if role == Role::Table {
            return false;
        }
        !matches!(method, "site.sources" | "history.list" | "phones.log" | "session.guide" | "session.input" | "calibration.get")
    }

    /// `playback.*` from the room (#526).
    pub(super) fn playback_request(&self, role: Role, method: &str, p: &Value) -> Result<Value, String> {
        if !matches!(role, Role::Dev | Role::Tv) {
            return Err("only the playback room moves through a recording".into());
        }
        if self.options.playback.is_none() {
            return Err("this host is not playing a recording".into());
        }
        match method {
            "playback.info" => {
                let playback = self.playback.lock();
                let playback = playback.as_ref().ok_or("the recording could not be opened")?;
                let events: Vec<Value> = playback
                    .lines
                    .iter()
                    // The table's own requests and the controller's "someone is here" pings say nothing.
                    .filter(|e| e["k"] != "request" || !(e["role"] == "table" || e["m"] == "session.input"))
                    .map(|e| {
                        json!({
                            "t": e["t"],
                            "kind": kind(e),
                            "who": e["role"],
                            "slot": e["slot"],
                            "text": summary(e),
                        })
                    })
                    .collect();
                Ok(json!({
                    "recording": playback.catalogue,
                    "length": playback.length(),
                    "at": playback.at,
                    "events": events,
                    "notes": read_notes(&playback.folder),
                }))
            }
            "playback.note" => {
                let playback = self.playback.lock();
                let playback = playback.as_ref().ok_or("the recording could not be opened")?;
                let notes = write_note(&playback.folder, p)?;
                Ok(json!({ "notes": notes }))
            }
            "playback.seek" => {
                let t = p["t"].as_f64().ok_or("say where: t, in milliseconds")?.max(0.0) as u64;
                let replayed = self.seek_to(t)?;
                Ok(json!({ "at": t, "replayed": replayed }))
            }
            other => Err(format!("unknown method '{other}'")),
        }
    }

    /// Moves the played session to `t` milliseconds. Forwards it replays only the lines since
    /// the last move; backwards (or a long jump) it starts from the nearest checkpoint (#524).
    fn seek_to(&self, t: u64) -> Result<usize, String> {
        let (folder, at, applied, lines) = {
            let playback = self.playback.lock();
            let playback = playback.as_ref().ok_or("the recording could not be opened")?;
            (playback.folder.clone(), playback.at, playback.applied, playback.lines.clone())
        };
        let jump = t < at || t - at > CHECKPOINT_EVERY.as_millis() as u64;
        REPLAYING.with(|r| r.set(true));
        let result = if jump {
            seek(self, &folder, t).map(|n| {
                let applied = lines.iter().take_while(|l| l["t"].as_u64().unwrap_or(0) <= t).count();
                (n, applied)
            })
        } else {
            let mut n = 0;
            let mut next = applied;
            while next < lines.len() && lines[next]["t"].as_u64().unwrap_or(0) <= t {
                let event = &lines[next];
                if event["k"] == "join" || event["k"] == "leave" {
                    self.replay_seat(event);
                }
                if event["k"] == "request" {
                    if let (Some(role), Some(method)) = (event["role"].as_str().and_then(Role::parse), event["m"].as_str()) {
                        let _ = self.request(role, event["surface"].as_u64().unwrap_or(0), method, &event["p"]);
                        n += 1;
                    }
                }
                next += 1;
            }
            Ok((n, next))
        };
        REPLAYING.with(|r| r.set(false));
        let (n, applied) = result?;
        if let Some(playback) = self.playback.lock().as_mut() {
            playback.at = t;
            playback.applied = applied;
        }
        self.emit("playback.at", json!({ "at": t }));
        Ok(n)
    }
}

impl Hub {
    /// Seats the phones a checkpoint or the start snapshot lists (#524, #526), so what they
    /// send in the log lands in the right seat, with its colour and animal.
    pub(super) fn restore_seats(&self, participants: &Value) {
        let Some(list) = participants.as_array() else { return };
        let mut inner = self.inner.lock();
        inner.seats.clear();
        for p in list {
            if let (Some(surface), Some(slot)) = (p["surface"].as_u64(), p["slot"].as_u64()) {
                let seat = seat_for(surface, slot as usize, p, self.options.phone_requests_per_second);
                inner.seats.push(seat);
            }
        }
        self.emit("state.participants", json!({ "participants": inner.participants() }));
    }

    /// A phone joining or leaving in the log, played back (#526).
    pub(super) fn replay_seat(&self, event: &Value) {
        let (Some(surface), Some(slot)) = (event["surface"].as_u64(), event["slot"].as_u64()) else { return };
        let mut inner = self.inner.lock();
        let slot = slot as usize;
        if event["k"] == "join" {
            inner.seats.retain(|s| s.participant.slot != slot);
            let seat = seat_for(surface, slot, &Value::Null, self.options.phone_requests_per_second);
            inner.seats.push(seat);
        } else if let Some(seat) = inner.seats.iter_mut().find(|s| s.participant.slot == slot) {
            seat.participant.connected = false;
        }
        self.emit("state.participants", json!({ "participants": inner.participants() }));
    }
}

/// A seat as a snapshot lists it; an animal and mood from the slot when it names none.
fn seat_for(surface: u64, slot: usize, p: &Value, rate: u32) -> Seat {
    let pick = |list: &'static [&'static str], key: &str| -> &'static str {
        p[key].as_str().and_then(|a| list.iter().find(|x| **x == a).copied()).unwrap_or(list[slot % list.len()])
    };
    Seat {
        participant: Participant {
            surface,
            slot,
            colour: SLOT_COLOURS[slot % SLOT_COLOURS.len()],
            connected: p["connected"].as_bool().unwrap_or(true),
            avatar: pick(&AVATARS, "avatar"),
            mood: pick(&MOODS, "mood"),
            name: p["name"].as_str().map(str::to_string),
        },
        token: format!("playback-{slot}"),
        epoch: 0,
        held_since: None,
        kick: Arc::new(Notify::new()),
        allowance: rate as f64,
        refilled: Instant::now(),
    }
}

/// Makes the table a recording plays on (#526): a copy of `table` in `into`, with its site.json
/// as it was when the recording started. The copy leaves out the table's history and caches,
/// and the table itself is never touched.
pub fn playback_table(recording: &Path, table: &Path, into: &Path) -> Result<PathBuf, String> {
    let start: Value = std::fs::read_to_string(recording.join("start.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or("the recording has no start snapshot")?;
    fn copy(from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            if matches!(entry.file_name().to_str(), Some(".mrstudio" | ".cache" | "scene" | ".git")) {
                continue;
            }
            let target = to.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy(&entry.path(), &target)?;
            } else {
                std::fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }
    let _ = std::fs::remove_dir_all(into);
    copy(table, into).map_err(|e| format!("the table could not be copied for playback: {e}"))?;
    let site = serde_json::to_string_pretty(&start["site"]).map_err(|e| e.to_string())?;
    std::fs::write(into.join("site.json"), site).map_err(|e| format!("the recorded site.json could not be written: {e}"))?;
    Ok(into.to_path_buf())
}

/// The organiser's notes on a recording (#527), kept beside it in notes.json. The recording's
/// own files are never changed: a note is the reviewer's, not the session's.
fn read_notes(folder: &std::path::Path) -> Vec<Value> {
    std::fs::read(folder.join("notes.json")).ok().and_then(|b| serde_json::from_slice::<Vec<Value>>(&b).ok()).unwrap_or_default()
}

/// Adds ({t, text}), changes ({id, text}) or removes ({id, remove: true}) one note.
fn write_note(folder: &std::path::Path, p: &Value) -> Result<Vec<Value>, String> {
    let mut notes = read_notes(folder);
    let text = |p: &Value| -> Result<String, String> {
        let text = p["text"].as_str().unwrap_or("").trim();
        if text.is_empty() {
            return Err("a note needs some text".into());
        }
        Ok(text.chars().take(2000).collect())
    };
    match p["id"].as_str() {
        Some(id) => {
            let at = notes.iter().position(|n| n["id"] == id).ok_or("no note with that id")?;
            if p["remove"].as_bool() == Some(true) {
                notes.remove(at);
            } else {
                notes[at]["text"] = Value::String(text(p)?);
            }
        }
        None => {
            let t = p["t"].as_f64().ok_or("say when: t, in milliseconds")?.max(0.0) as u64;
            let id = format!(
                "n{}",
                notes.iter().filter_map(|n| n["id"].as_str()?.strip_prefix('n')?.parse::<u64>().ok()).max().unwrap_or(0) + 1
            );
            notes.push(json!({ "id": id, "t": t, "text": text(p)? }));
        }
    }
    notes.sort_by_key(|n| n["t"].as_u64().unwrap_or(0));
    let bytes = serde_json::to_vec_pretty(&notes).map_err(|e| e.to_string())?;
    std::fs::write(folder.join("notes.json"), bytes).map_err(|e| format!("could not save the note: {e}"))?;
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::test_support::*;

    #[test]
    fn a_recording_plays_back_read_only_forwards_and_backwards() {
        // #526: a host opened on a recording moves only by playback.seek; the pages change nothing.
        let dir = std::env::temp_dir().join(format!("mrs-playback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut live = scratch_hub("playback-live");
        live.options.recordings_dir = Some(dir.clone());
        let code = live.session().code;
        let tv = |method: &str, p: Value| {
            std::thread::sleep(Duration::from_millis(3));
            live.request(Role::Tv, 1, method, &p).unwrap()
        };
        let id = tv("recording.start", json!({ "consent": false }))["recording"]["id"].as_str().unwrap().to_string();
        let phone = live.join(Role::Phone, Some(&code), None).unwrap().surface;
        tv("layer.activate", json!({ "layer": "sunlight", "active": true }));
        tv("layer.set", json!({ "layer": "sunlight", "params": { "hour": 9.5 } }));
        std::thread::sleep(Duration::from_millis(3));
        live.request(Role::Phone, phone, "layer.activate", &json!({ "layer": "trees", "active": false })).unwrap();
        tv("recording.chapter", json!({ "title": "Morning" }));
        tv("layer.set", json!({ "layer": "sunlight", "params": { "hour": 17 } }));
        let length = tv("recording.stop", json!({}))["recording"]["length"].as_u64().unwrap();
        let folder = dir.join(&id);

        let played = hub(SessionOptions { playback: Some(folder.clone()), ..Default::default() });
        let info = played.session().playback.expect("the pages are told it is a recording");
        assert_eq!(info.id, id);
        let code = played.session().code;
        assert!(played.join(Role::Phone, Some(&code), None).err().unwrap().contains("recorded session"));
        // The controller, the guide and the operator change nothing.
        let refused = played.request(Role::Tv, 1, "layer.activate", &json!({ "layer": "wind", "active": true })).unwrap_err();
        assert!(refused.contains("read only"), "{refused}");
        assert!(played.request(Role::Dev, 0, "recording.start", &json!({})).is_err());
        assert!(played.request(Role::Phone, 9, "playback.seek", &json!({ "t": 0 })).is_err(), "only the room");

        let events = played.request(Role::Dev, 0, "playback.info", &json!({})).unwrap();
        let texts: Vec<&str> = events["events"].as_array().unwrap().iter().filter_map(|e| e["text"].as_str()).collect();
        assert!(texts.contains(&"Controller opened sunlight"), "{texts:?}");
        assert!(texts.contains(&"Phone 1 closed trees"), "{texts:?}");
        assert!(texts.contains(&"Chapter: Morning"), "{texts:?}");

        let state = |hub: &Hub| {
            (
                layer(hub, "sunlight")["active"].clone(),
                layer(hub, "sunlight")["params"]["hour"].clone(),
                layer(hub, "trees")["active"].clone(),
            )
        };
        let seek = |t: u64| played.request(Role::Dev, 0, "playback.seek", &json!({ "t": t })).unwrap();
        seek(length);
        assert_eq!(state(&played), state(&live), "the end is where the session ended");
        assert_eq!(played.welcome(0)["state"]["participants"][0]["slot"], 0, "the phone has its seat");
        seek(0);
        assert_eq!(state(&played).0, false, "back at the start");
        let chapter = events["recording"]["chapters"][0]["t"].as_u64().unwrap();
        seek(chapter);
        assert_eq!(state(&played), (json!(true), json!(9.5), json!(false)), "at the chapter");
        seek(length);
        assert_eq!(state(&played).1.as_f64(), Some(17.0));

        // #527: notes are the organiser's, kept beside the recording, never in its log.
        let note = |p: Value| played.request(Role::Dev, 0, "playback.note", &p).unwrap()["notes"].clone();
        note(json!({ "t": 4000, "text": "Second" }));
        let notes = note(json!({ "t": 1000, "text": "First" }));
        assert_eq!(notes[0]["text"], "First", "sorted by time");
        let id = notes[1]["id"].as_str().unwrap().to_string();
        note(json!({ "id": id, "text": "Second, changed" }));
        let info = played.request(Role::Dev, 0, "playback.info", &json!({})).unwrap();
        assert_eq!(info["notes"][1]["text"], "Second, changed");
        let notes = note(json!({ "id": notes[0]["id"], "remove": true }));
        assert_eq!(notes.as_array().unwrap().len(), 1);
        assert!(played.request(Role::Dev, 0, "playback.note", &json!({ "t": 1, "text": " " })).is_err());
    }
}
