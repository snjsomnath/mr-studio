//! Field walk (#445): visitors walk the place the table shows and drop spots from their phones,
//! each with a photo or a sound. A phone keeps a spot until the table can be reached, then sends
//! it over its session socket in small pieces (`field.add`, then `field.part` until done), which
//! is the only way through the join page and the relay, where phones may only GET.
//!
//! Spots live in `<site>/.mrstudio/field/`: `spots.json` and one file per spot. That folder is
//! left out of a shared `.mrstable` and is served to this computer only (`/api/field`), so a
//! phone never sees another visitor's photos. The controller removes a spot or clears the walk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hub::Role;

/// Where a table keeps its field walk, inside its folder.
pub const DIR: &str = ".mrstudio/field";
/// The layer package that shows the walk. The host takes spots only while the scene has one.
pub const PACKAGE: &str = "fieldwalk";
/// The largest photo or sound a spot may carry. Phones send photos at most 1600 px wide as JPEG
/// (a few hundred kB) and sounds of at most a minute.
pub const MAX_BYTES: u64 = 8 << 20;
/// The largest piece of a file in one `field.part`, decoded. The socket takes 1 MB messages; the
/// join page's WebRTC channel is happier with less.
pub const MAX_PART: usize = 192 << 10;
/// Spots a table keeps, all walkers together.
pub const MAX_SPOTS: usize = 600;
/// How far from the table's centre a spot may be.
const MAX_KM: f64 = 5.0;
const MAX_NOTE: usize = 140;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Walker {
    /// The phone's own id for its walker, kept on the phone, so a phone that comes back after its
    /// seat was given up is still the same walker.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mood: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colour: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Spot {
    pub id: String,
    /// `photo` or `sound`.
    pub kind: String,
    /// When it was taken, milliseconds since 1970, by the phone's clock.
    pub at: f64,
    pub lon: f64,
    pub lat: f64,
    /// Metres, from the phone's GPS. None when the visitor tapped the spot on the map.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<f64>,
    /// `gps` or `map`.
    pub placed: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The file's name in the field folder.
    pub file: String,
    pub mime: String,
    pub bytes: u64,
    /// A sound's length in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    pub walker: Walker,
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    revision: u64,
    spots: Vec<Spot>,
}

struct Pending {
    spot: Spot,
    have: u64,
}

pub struct Field {
    dir: PathBuf,
    centre: (f64, f64),
    inner: Mutex<Inner>,
}

struct Inner {
    saved: Saved,
    pending: HashMap<String, Pending>,
}

/// The file type a spot's media is kept as, by its MIME type. Anything else is refused.
fn extension(kind: &str, mime: &str) -> Option<&'static str> {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match (kind, base.as_str()) {
        ("photo", "image/jpeg") => Some("jpg"),
        ("photo", "image/png") => Some("png"),
        ("photo", "image/webp") => Some("webp"),
        ("sound", "audio/webm") => Some("webm"),
        ("sound", "audio/ogg") => Some("ogg"),
        ("sound", "audio/mp4" | "audio/x-m4a" | "audio/m4a" | "audio/aac") => Some("m4a"),
        ("sound", "audio/mpeg") => Some("mp3"),
        ("sound", "audio/wav" | "audio/x-wav" | "audio/wave") => Some("wav"),
        _ => None,
    }
}

/// The content type a field file is served with.
pub fn content_type(file: &str) -> &'static str {
    match file.rsplit('.').next().unwrap_or("") {
        "jpg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "webm" => "audio/webm",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn clean_id(value: &Value) -> Result<String, String> {
    let id = value.as_str().ok_or("missing id")?;
    if (8..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        Ok(id.to_string())
    } else {
        Err("a spot's id is 8 to 40 letters, digits and dashes".into())
    }
}

fn short_text(value: &Value, most: usize) -> Option<String> {
    let text: String = value.as_str()?.trim().chars().filter(|c| !c.is_control()).take(most).collect();
    (!text.is_empty()).then_some(text)
}

fn distance_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let rad = std::f64::consts::PI / 180.0;
    let (dlat, dlon) = ((b.1 - a.1) * rad, (b.0 - a.0) * rad);
    let h = (dlat / 2.0).sin().powi(2) + (a.1 * rad).cos() * (b.1 * rad).cos() * (dlon / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().asin()
}

impl Field {
    /// Opens the field walk of the table in `site_dir`, whose centre is `centre` (lon, lat).
    pub fn open(site_dir: &Path, centre: (f64, f64)) -> Self {
        let dir = site_dir.join(DIR);
        let saved = std::fs::read(dir.join("spots.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { dir, centre, inner: Mutex::new(Inner { saved, pending: HashMap::new() }) }
    }

    /// Every spot, oldest first, and the walk's revision, for `GET /api/field`.
    pub fn list(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        // Spots on their way, so the controller sees who is still sending.
        let pending: Vec<Value> = inner
            .pending
            .values()
            .map(|p| json!({ "id": p.spot.id, "kind": p.spot.kind, "walker": p.spot.walker, "share": p.have as f64 / p.spot.bytes as f64 }))
            .collect();
        json!({ "revision": inner.saved.revision, "spots": inner.saved.spots, "pending": pending })
    }

    /// A field file's path, by its name as a spot has it. None for anything else.
    pub fn file(&self, name: &str) -> Option<PathBuf> {
        let inner = self.inner.lock().unwrap();
        inner.saved.spots.iter().any(|s| s.file == name).then(|| self.dir.join(name))
    }

    fn save(&self, saved: &Saved) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("could not keep the walk: {e}"))?;
        let temporary = self.dir.join("spots.json.part");
        std::fs::write(&temporary, serde_json::to_vec_pretty(saved).unwrap_or_default())
            .map_err(|e| format!("could not keep the walk: {e}"))?;
        std::fs::rename(&temporary, self.dir.join("spots.json")).map_err(|e| format!("could not keep the walk: {e}"))
    }

    /// A `field.*` request. `walker` is the phone's seat as the pages show it, if it has one.
    /// Returns the answer, and the walk's new revision when the list of spots changed.
    pub fn request(&self, role: Role, method: &str, p: &Value, seat: Option<Value>) -> Result<(Value, Option<u64>), String> {
        match method {
            "field.add" | "field.part" => {
                if !matches!(role, Role::Phone | Role::Dev) {
                    return Err("spots come from phones".into());
                }
                if method == "field.add" {
                    self.add(p, seat)
                } else {
                    self.part(p)
                }
            }
            "field.remove" | "field.clear" => {
                if !matches!(role, Role::Tv | Role::Dev) {
                    return Err("only the controller removes spots".into());
                }
                let mut inner = self.inner.lock().unwrap();
                let gone: Vec<Spot> = if method == "field.clear" {
                    inner.pending.clear();
                    std::mem::take(&mut inner.saved.spots)
                } else {
                    let id = clean_id(&p["id"])?;
                    let at = inner.saved.spots.iter().position(|s| s.id == id).ok_or("no such spot")?;
                    vec![inner.saved.spots.remove(at)]
                };
                for spot in &gone {
                    let _ = std::fs::remove_file(self.dir.join(&spot.file));
                }
                if method == "field.clear" {
                    // Pieces of spots still on their way go too.
                    if let Ok(entries) = std::fs::read_dir(&self.dir) {
                        for entry in entries.flatten() {
                            if entry.file_name().to_string_lossy().ends_with(".part") {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }
                inner.saved.revision += 1;
                self.save(&inner.saved)?;
                Ok((json!({ "removed": gone.len() }), Some(inner.saved.revision)))
            }
            other => Err(format!("unknown method '{other}'")),
        }
    }

    /// `field.add`: a spot is on its way. Answers how many bytes of it the host already has, so a
    /// phone that lost its connection goes on where it stopped. Sending a spot again is harmless.
    fn add(&self, p: &Value, seat: Option<Value>) -> Result<(Value, Option<u64>), String> {
        let id = clean_id(&p["id"])?;
        let mut inner = self.inner.lock().unwrap();
        if let Some(done) = inner.saved.spots.iter().find(|s| s.id == id) {
            return Ok((json!({ "have": done.bytes, "done": true }), None));
        }
        if let Some(pending) = inner.pending.get(&id) {
            return Ok((json!({ "have": pending.have }), None));
        }
        if inner.saved.spots.len() + inner.pending.len() >= MAX_SPOTS {
            return Err(format!("the walk is full ({MAX_SPOTS} spots); ask the guide to clear it"));
        }
        let kind = p["kind"].as_str().filter(|k| matches!(*k, "photo" | "sound")).ok_or("a spot is a photo or a sound")?;
        let mime = p["mime"].as_str().ok_or("missing mime")?;
        let ext = extension(kind, mime).ok_or_else(|| format!("a {kind} of type '{mime}' cannot be kept"))?;
        let bytes = p["bytes"].as_u64().filter(|b| (1..=MAX_BYTES).contains(b)).ok_or("a spot's file must be at most 8 MB")?;
        let lon = p["lon"].as_f64().filter(|v| (-180.0..=180.0).contains(v)).ok_or("longitude must be between -180 and 180")?;
        let lat = p["lat"].as_f64().filter(|v| (-90.0..=90.0).contains(v)).ok_or("latitude must be between -90 and 90")?;
        if distance_km(self.centre, (lon, lat)) > MAX_KM {
            return Err("that spot is too far from the table".into());
        }
        let walker_id = p["walker"]["id"].as_str().map(|w| w.to_string()).ok_or("missing walker")?;
        let walker_id = clean_id(&json!(walker_id))?;
        // The phone names its walker as its pages show it ("Sunny Fox", 🦊), in its own language;
        // the colour is the seat's, if the phone has one now, else the one it had.
        let who = &p["walker"];
        let colour = seat.as_ref().map(|s| s["colour"].clone()).filter(|c| c.is_string()).unwrap_or_else(|| who["colour"].clone());
        let walker = Walker {
            id: walker_id,
            name: short_text(&who["name"], 32),
            avatar: short_text(&who["avatar"], 8),
            mood: None,
            colour: short_text(&colour, 16).filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())),
        };
        let spot = Spot {
            file: format!("{id}.{ext}"),
            id: id.clone(),
            kind: kind.to_string(),
            at: p["at"].as_f64().filter(|t| t.is_finite() && *t > 0.0).unwrap_or(0.0),
            lon: (lon * 1e7).round() / 1e7,
            lat: (lat * 1e7).round() / 1e7,
            accuracy: p["accuracy"].as_f64().filter(|a| a.is_finite() && *a >= 0.0).map(|a| a.min(10_000.0).round()),
            placed: if p["placed"] == "map" { "map" } else { "gps" }.to_string(),
            note: short_text(&p["note"], MAX_NOTE),
            mime: mime.split(';').next().unwrap_or(mime).trim().to_string(),
            bytes,
            duration: p["duration"].as_f64().filter(|d| d.is_finite() && *d > 0.0).map(|d| d.min(600.0)),
            walker,
        };
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("could not keep the spot: {e}"))?;
        std::fs::write(self.dir.join(format!("{id}.part")), b"").map_err(|e| format!("could not keep the spot: {e}"))?;
        inner.pending.insert(id, Pending { spot, have: 0 });
        // The controller hears that a spot is on its way; the list's revision is unchanged on disk.
        inner.saved.revision += 1;
        Ok((json!({ "have": 0 }), Some(inner.saved.revision)))
    }

    /// `field.part { id, offset, data }`: the next piece of a spot's file, base64. A piece that is
    /// not the next one is ignored and the answer says where to go on from.
    fn part(&self, p: &Value) -> Result<(Value, Option<u64>), String> {
        use std::io::Write;
        let id = clean_id(&p["id"])?;
        let mut inner = self.inner.lock().unwrap();
        let pending = inner.pending.get_mut(&id).ok_or("send field.add first")?;
        let offset = p["offset"].as_u64().ok_or("missing offset")?;
        if offset != pending.have {
            return Ok((json!({ "have": pending.have }), None));
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(p["data"].as_str().ok_or("missing data")?)
            .map_err(|_| "data is not base64")?;
        if data.is_empty() || data.len() > MAX_PART || pending.have + data.len() as u64 > pending.spot.bytes {
            return Err("that piece does not fit the spot".into());
        }
        let path = self.dir.join(format!("{id}.part"));
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).map_err(|e| format!("could not keep the spot: {e}"))?;
        file.write_all(&data).map_err(|e| format!("could not keep the spot: {e}"))?;
        pending.have += data.len() as u64;
        if pending.have < pending.spot.bytes {
            return Ok((json!({ "have": pending.have }), None));
        }
        let Pending { spot, have } = inner.pending.remove(&id).expect("pending");
        std::fs::rename(&path, self.dir.join(&spot.file)).map_err(|e| format!("could not keep the spot: {e}"))?;
        inner.saved.spots.push(spot);
        inner.saved.revision += 1;
        self.save(&inner.saved)?;
        Ok((json!({ "have": have, "done": true }), Some(inner.saved.revision)))
    }
}

/// Whether a path under `/site` reaches the field folder, however it is spelt (`.MRStudio`,
/// `%2e`, doubled slashes): the walk is for this computer's eyes only.
pub fn is_field_path(path: &str) -> bool {
    let decoded = percent_decode(path).to_ascii_lowercase().replace('\\', "/");
    let parts: Vec<&str> = decoded.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    parts.windows(2).any(|w| w[0] == ".mrstudio" && w[1] == "field")
}

pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mrs-field-{}-{}", std::process::id(), rand_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn rand_id() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64
    }
    fn add(id: &str, bytes: u64) -> Value {
        json!({ "id": id, "kind": "photo", "mime": "image/jpeg", "bytes": bytes, "lon": 11.97, "lat": 57.7, "at": 1.0e12,
                "walker": { "id": "walker-0001", "name": "Ada", "colour": "#ff0000" } })
    }
    fn b64(data: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(data)
    }

    #[test]
    fn a_spot_arrives_in_pieces_and_resumes() {
        let dir = temp();
        let field = Field::open(&dir, (11.97, 57.7));
        assert_eq!(field.request(Role::Phone, "field.add", &add("spot-00001", 6), None).unwrap().0["have"], 0);
        assert_eq!(field.list()["pending"][0]["walker"]["name"], "Ada");
        let (r, rev) =
            field.request(Role::Phone, "field.part", &json!({ "id": "spot-00001", "offset": 0, "data": b64(b"abc") }), None).unwrap();
        assert_eq!((r["have"].as_u64(), rev), (Some(3), None));
        // A dropped phone asks again and goes on from 3; a stale piece is ignored.
        assert_eq!(field.request(Role::Phone, "field.add", &add("spot-00001", 6), None).unwrap().0["have"], 3);
        let (r, _) =
            field.request(Role::Phone, "field.part", &json!({ "id": "spot-00001", "offset": 0, "data": b64(b"abc") }), None).unwrap();
        assert_eq!(r["have"], 3);
        let (r, rev) =
            field.request(Role::Phone, "field.part", &json!({ "id": "spot-00001", "offset": 3, "data": b64(b"def") }), None).unwrap();
        assert_eq!((r["done"].as_bool(), rev), (Some(true), Some(2)));
        assert_eq!(std::fs::read(dir.join(DIR).join("spot-00001.jpg")).unwrap(), b"abcdef");
        // Sent again after it arrived: already done.
        assert_eq!(field.request(Role::Phone, "field.add", &add("spot-00001", 6), None).unwrap().0["done"], true);
        // Kept across a restart.
        let again = Field::open(&dir, (11.97, 57.7));
        assert_eq!(again.list()["spots"][0]["walker"]["name"], "Ada");
        assert!(again.file("spot-00001.jpg").is_some() && again.file("spots.json").is_none());
        // Only the controller removes.
        assert!(again.request(Role::Phone, "field.clear", &json!({}), None).is_err());
        let (_, rev) = again.request(Role::Tv, "field.clear", &json!({}), None).unwrap();
        assert_eq!(rev, Some(3));
        assert!(!dir.join(DIR).join("spot-00001.jpg").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_what_does_not_belong() {
        let dir = temp();
        let field = Field::open(&dir, (11.97, 57.7));
        let mut far = add("spot-00002", 6);
        far["lon"] = json!(12.5);
        assert!(field.request(Role::Phone, "field.add", &far, None).is_err());
        let mut odd = add("spot-00003", 6);
        odd["mime"] = json!("text/html");
        assert!(field.request(Role::Phone, "field.add", &odd, None).is_err());
        assert!(field.request(Role::Phone, "field.add", &add("../../x", 6), None).is_err());
        assert!(field.request(Role::Phone, "field.add", &add("spot-00004", MAX_BYTES + 1), None).is_err());
        assert!(field.request(Role::Table, "field.add", &add("spot-00005", 6), None).is_err());
        field.request(Role::Phone, "field.add", &add("spot-00006", 2), None).unwrap();
        assert!(field
            .request(Role::Phone, "field.part", &json!({ "id": "spot-00006", "offset": 0, "data": b64(b"toolong") }), None)
            .is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn field_paths_are_found_however_spelt() {
        for path in
            ["/.mrstudio/field/a.jpg", "/.MRStudio/Field/spots.json", "/%2emrstudio/field/x", "//.mrstudio//field", "/./.mrstudio/./field/"]
        {
            assert!(is_field_path(path), "{path}");
        }
        for path in ["/data/field/x.tif", "/.mrstudio/history/r1.json", "/field/a.jpg"] {
            assert!(!is_field_path(path), "{path}");
        }
    }
}
