//! Session state. The hub is the only authority over it: surfaces send requests,
//! the hub validates, updates and broadcasts.
//!
//! The scene is the ordered list of layer instances, bottom first. It starts as the
//! `layers` list of `site.json`, and the `scene.*` requests edit both together.

use std::hash::{BuildHasher, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mrs_site::{is_instance_id, LayerRef, Site, SiteInfo};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, Notify};

use crate::layers::{LayerDef, ToolKind};

pub const PROTOCOL: u32 = 1;
pub const MAX_PHONES: usize = 8;
/// More layers than this in one scene is a mistake, not a design.
pub const MAX_SCENE_LAYERS: usize = 64;
const SLOT_COLOURS: [&str; 8] = ["#ff6b6b", "#4dabf7", "#51cf66", "#fcc419", "#cc5de8", "#ff922b", "#20c997", "#f06595"];
/// The most positions one tool input may carry.
const MAX_VERTICES: usize = 256;

/// How the session treats phones. The defaults are the contract's numbers.
#[derive(Debug, Clone)]
pub struct SessionOptions {
    pub max_phones: usize,
    /// How long a slot waits for its phone to come back after the connection drops.
    pub resume_hold: Duration,
    /// Requests a phone may send per second. The rest are refused.
    pub phone_requests_per_second: u32,
    /// The address phones reach the studio at, such as `http://192.168.1.20:4170`.
    /// Without it the host works it out from the address it listens on.
    pub public_url: Option<String>,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self { max_phones: MAX_PHONES, resume_hold: Duration::from_secs(60), phone_requests_per_second: 20, public_url: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Table,
    Tv,
    Phone,
    Dev,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "table" => Some(Self::Table),
            "tv" => Some(Self::Tv),
            "phone" => Some(Self::Phone),
            "dev" => Some(Self::Dev),
            _ => None,
        }
    }

    fn may_activate(self) -> bool {
        self != Self::Phone
    }

    fn may_publish(self) -> bool {
        matches!(self, Self::Table | Self::Dev)
    }

    /// Editing the scene rewrites site.json, so it is kept to the operator's surfaces.
    fn may_compose(self) -> bool {
        matches!(self, Self::Tv | Self::Dev)
    }

    pub fn may_use_engine(self) -> bool {
        self != Self::Phone
    }

    pub fn may_calibrate(self) -> bool {
        self != Self::Phone
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LayerState {
    /// The layer package this instance runs.
    pub layer: String,
    pub active: bool,
    /// How strongly the layer is drawn on the table, 0 to 2. 1 is as the layer intends.
    pub intensity: f64,
    pub params: Map<String, Value>,
    pub shared: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Participant {
    /// The surface currently in the slot. It changes when the phone reconnects; the slot does not.
    pub surface: u64,
    pub slot: usize,
    pub colour: &'static str,
    /// False while the slot is held for a phone that dropped.
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub code: String,
    pub port: u16,
    /// What the TV's QR code points at. None when phones cannot reach the host.
    pub join_url: Option<String>,
}

/// A phone's place in the session. It outlives the connection by `resume_hold`.
struct Seat {
    participant: Participant,
    /// Presented in `hello` to return to this seat.
    token: String,
    /// Bumped on every join and leave, so a stale hold timer cannot release a seat that was resumed.
    epoch: u64,
    /// When the phone dropped, while the seat is held.
    held_since: Option<Instant>,
    /// Tells the connection in this seat that another one took it over.
    kick: Arc<Notify>,
    /// Request allowance: refills at the session's rate, holds at most one second's worth.
    allowance: f64,
    refilled: Instant,
}

/// What `join` hands the connection.
pub struct Joined {
    pub surface: u64,
    /// Phones only: fires when another connection resumes this seat.
    pub kick: Option<Arc<Notify>>,
}

/// A seat that is being held. Pass it to `expire` once the hold has run out.
#[derive(Debug, Clone, Copy)]
pub struct Hold {
    slot: usize,
    epoch: u64,
}

/// One layer in the scene.
#[derive(Debug, Clone)]
struct Instance {
    id: String,
    /// Index into the catalogue.
    def: usize,
    /// The entry as site.json holds it. Live changes (`layer.set`) do not touch it.
    saved: LayerRef,
    state: LayerState,
}

struct Inner {
    /// Bottom first.
    scene: Vec<Instance>,
    seats: Vec<Seat>,
    next_surface: u64,
}

impl Inner {
    fn layers(&self) -> Map<String, Value> {
        self.scene.iter().map(|i| (i.id.clone(), json!(i.state))).collect()
    }

    fn order(&self) -> Vec<&str> {
        self.scene.iter().map(|i| i.id.as_str()).collect()
    }

    fn position(&self, id: &str) -> Result<usize, String> {
        self.scene.iter().position(|i| i.id == id).ok_or_else(|| format!("unknown layer '{id}'"))
    }

    fn participants(&self) -> Vec<Participant> {
        let mut list: Vec<Participant> = self.seats.iter().map(|s| s.participant.clone()).collect();
        list.sort_by_key(|p| p.slot);
        list
    }
}

pub struct Hub {
    site: Site,
    info: SiteInfo,
    session: SessionInfo,
    options: SessionOptions,
    /// Every layer that can be added to a scene.
    catalog: Vec<LayerDef>,
    inner: Mutex<Inner>,
    events: broadcast::Sender<String>,
}

/// 64 unpredictable bits from the operating system, by way of the standard library's hash seeds.
fn random_u64() -> u64 {
    std::collections::hash_map::RandomState::new().build_hasher().finish()
}

impl Hub {
    /// `join_base` is the address phones reach the host at, without a path.
    pub fn new(site: &Site, catalog: Vec<LayerDef>, port: u16, join_base: Option<String>, options: SessionOptions) -> anyhow::Result<Self> {
        let mut scene: Vec<Instance> = Vec::new();
        for reference in &site.manifest.layers {
            let def = catalog
                .iter()
                .position(|d| d.source == reference.r#use)
                .ok_or_else(|| anyhow::anyhow!("site.json uses layer '{}', which is not available", reference.r#use))?;
            let instance = Self::instance(&catalog, def, reference.clone(), true)?;
            if scene.iter().any(|i| i.id == instance.id) {
                anyhow::bail!("layer '{}' is listed twice in site.json; give one entry its own \"id\"", instance.id);
            }
            scene.push(instance);
        }
        let code = format!("{:04}", random_u64() % 10_000);
        let join_url = join_base.map(|base| format!("{}/phone?c={code}", base.trim_end_matches('/')));
        let session = SessionInfo { id: format!("{:016x}", random_u64()), code, port, join_url };
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            site: site.clone(),
            info: site.info(),
            session,
            options,
            catalog,
            inner: Mutex::new(Inner { scene, seats: Vec::new(), next_surface: 1 }),
            events,
        })
    }

    /// Builds an instance from a site.json entry. With `lenient`, params that do not
    /// validate are ignored with a warning (a hand-edited file should still start).
    fn instance(catalog: &[LayerDef], def: usize, saved: LayerRef, lenient: bool) -> anyhow::Result<Instance> {
        let layer = &catalog[def];
        let id = saved.id.clone().unwrap_or_else(|| layer.id.clone());
        let mut params = layer.defaults();
        match layer.validate(&saved.params, false) {
            Ok(overrides) => params.extend(overrides),
            Err(e) if lenient => tracing::warn!("site.json params for layer '{id}' ignored: {e}"),
            Err(e) => anyhow::bail!(e),
        }
        let state = LayerState { layer: layer.id.clone(), active: saved.active, intensity: 1.0, params, shared: Map::new() };
        Ok(Instance { id, def, saved, state })
    }

    pub fn session(&self) -> &SessionInfo {
        &self.session
    }

    pub fn site(&self) -> &SiteInfo {
        &self.info
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }

    pub(crate) fn emit(&self, method: &str, payload: Value) {
        let _ = self.events.send(json!({ "t": "ev", "m": method, "p": payload }).to_string());
    }

    /// Admits a surface. Phones need the session code and a seat: their own, if `resume`
    /// names one that is still held, otherwise a free one.
    pub fn join(&self, role: Role, code: Option<&str>, resume: Option<&str>) -> Result<Joined, String> {
        self.join_at(role, code, resume, Instant::now())
    }

    fn join_at(&self, role: Role, code: Option<&str>, resume: Option<&str>, now: Instant) -> Result<Joined, String> {
        let mut inner = self.inner.lock().unwrap();
        if role != Role::Phone {
            let surface = inner.next_surface;
            inner.next_surface += 1;
            return Ok(Joined { surface, kick: None });
        }
        if code != Some(self.session.code.as_str()) {
            return Err("wrong session code".into());
        }
        // Holds that ran out are free, whether or not their timer has fired yet.
        let hold = self.options.resume_hold;
        inner.seats.retain(|s| s.held_since.is_none_or(|since| now.duration_since(since) < hold));

        let surface = inner.next_surface;
        let kick = Arc::new(Notify::new());
        if let Some(seat) = resume.and_then(|token| inner.seats.iter_mut().find(|s| s.token == token)) {
            // The phone is back, or it reloaded before the host noticed the old connection die.
            if seat.participant.connected {
                seat.kick.notify_one();
            }
            seat.participant.surface = surface;
            seat.participant.connected = true;
            seat.held_since = None;
            seat.epoch += 1;
            seat.kick = kick.clone();
        } else {
            let limit = self.options.max_phones;
            let slot = (0..limit).find(|slot| inner.seats.iter().all(|s| s.participant.slot != *slot)).ok_or("session full")?;
            inner.seats.push(Seat {
                participant: Participant { surface, slot, colour: SLOT_COLOURS[slot % SLOT_COLOURS.len()], connected: true },
                token: format!("{:016x}{:016x}", random_u64(), random_u64()),
                epoch: 0,
                held_since: None,
                kick: kick.clone(),
                allowance: self.options.phone_requests_per_second as f64,
                refilled: now,
            });
        }
        inner.next_surface += 1;
        self.emit("state.participants", json!({ "participants": inner.participants() }));
        Ok(Joined { surface, kick: Some(kick) })
    }

    /// A surface's connection ended. For a phone the seat is held; call `expire` with the
    /// returned hold after `SessionOptions::resume_hold`.
    pub fn leave(&self, surface: u64) -> Option<Hold> {
        self.leave_at(surface, Instant::now())
    }

    fn leave_at(&self, surface: u64, now: Instant) -> Option<Hold> {
        let mut inner = self.inner.lock().unwrap();
        // A seat that was taken over belongs to another surface by now, so this finds nothing.
        let seat = inner.seats.iter_mut().find(|s| s.participant.surface == surface && s.participant.connected)?;
        seat.participant.connected = false;
        seat.held_since = Some(now);
        seat.epoch += 1;
        let hold = Hold { slot: seat.participant.slot, epoch: seat.epoch };
        self.emit("state.participants", json!({ "participants": inner.participants() }));
        Some(hold)
    }

    /// Releases a held seat, unless its phone came back in the meantime.
    pub fn expire(&self, hold: Hold) {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.seats.len();
        inner.seats.retain(|s| !(s.participant.slot == hold.slot && s.epoch == hold.epoch && !s.participant.connected));
        if inner.seats.len() != before {
            self.emit("state.participants", json!({ "participants": inner.participants() }));
        }
    }

    pub fn resume_hold(&self) -> Duration {
        self.options.resume_hold
    }

    /// Whether a phone may make another request now. Each phone has an allowance that
    /// refills at the session's rate and holds at most one second's worth.
    pub fn allow(&self, surface: u64) -> bool {
        self.allow_at(surface, Instant::now())
    }

    fn allow_at(&self, surface: u64, now: Instant) -> bool {
        let rate = self.options.phone_requests_per_second as f64;
        let mut inner = self.inner.lock().unwrap();
        let Some(seat) = inner.seats.iter_mut().find(|s| s.participant.surface == surface) else { return false };
        seat.allowance = (seat.allowance + now.duration_since(seat.refilled).as_secs_f64() * rate).min(rate);
        seat.refilled = now;
        if seat.allowance < 1.0 {
            return false;
        }
        seat.allowance -= 1.0;
        true
    }

    /// The `welcome` message for a surface. A phone's carries the token that resumes its seat.
    pub fn welcome(&self, surface: u64) -> Value {
        let inner = self.inner.lock().unwrap();
        let mut welcome = json!({
            "t": "welcome",
            "surface": surface,
            "state": {
                "protocol": PROTOCOL,
                "session": self.session,
                "site": self.info,
                "scene": inner.order(),
                "layers": inner.layers(),
                "participants": inner.participants(),
            },
            "manifests": self.catalog.iter().map(|d| &d.manifest).collect::<Vec<_>>(),
        });
        if let Some(seat) = inner.seats.iter().find(|s| s.participant.surface == surface) {
            welcome["resume"] = json!(seat.token);
        }
        welcome
    }

    /// Handles a session request. Engine requests are handled by the connection.
    pub fn request(&self, role: Role, surface: u64, method: &str, p: &Value) -> Result<Value, String> {
        // One lock for the whole request, so changes and their events keep one order.
        let mut inner = self.inner.lock().unwrap();
        if method.starts_with("scene.") {
            if !role.may_compose() {
                return Err("this surface cannot edit the scene".into());
            }
            return self.compose(&mut inner, method, p);
        }
        let layer = p["layer"].as_str().ok_or("missing layer")?;
        let index = inner.position(layer)?;
        let def = &self.catalog[inner.scene[index].def];
        let state = &mut inner.scene[index].state;
        match method {
            "layer.activate" => {
                if !role.may_activate() {
                    return Err("phones cannot turn layers on or off".into());
                }
                state.active = p["active"].as_bool().ok_or("missing active")?;
                self.emit_layer(layer, state);
            }
            "layer.intensity" => {
                if !role.may_activate() {
                    return Err("phones cannot change a layer's intensity".into());
                }
                state.intensity = p["intensity"].as_f64().filter(|v| v.is_finite()).ok_or("missing intensity")?.clamp(0.0, 2.0);
                self.emit_layer(layer, state);
            }
            "layer.set" => {
                let patch = p["params"].as_object().ok_or("missing params")?;
                state.params.extend(def.validate(patch, role == Role::Phone)?);
                self.emit_layer(layer, state);
            }
            "layer.publish" => {
                if !role.may_publish() {
                    return Err("only the table publishes".into());
                }
                state.shared.extend(p["values"].as_object().ok_or("missing values")?.clone());
                self.emit_layer(layer, state);
            }
            "layer.action" => {
                let action = p["action"].as_str().ok_or("missing action")?;
                let control = def.control(action).filter(|c| matches!(c.kind, crate::ControlKind::Action));
                let control = control.ok_or_else(|| format!("layer '{layer}' has no action '{action}'"))?;
                if role == Role::Phone && !control.phone {
                    return Err(format!("'{action}' cannot be used from a phone"));
                }
                self.emit("layer.action", json!({ "layer": layer, "action": action, "from": surface }));
            }
            "tool.input" => {
                let id = p["tool"].as_str().ok_or("missing tool")?;
                let tool = def.tool(id).ok_or_else(|| format!("layer '{layer}' has no tool '{id}'"))?;
                let geometry = clean_geometry(tool.kind, &p["geometry"])?;
                if !state.active {
                    return Err(format!("layer '{layer}' is off"));
                }
                let mut event = json!({ "layer": layer, "tool": id, "geometry": geometry, "from": surface });
                if let Some(seat) = inner.seats.iter().find(|s| s.participant.surface == surface) {
                    event["participant"] = json!({ "slot": seat.participant.slot, "colour": seat.participant.colour });
                }
                self.emit("tool.input", event);
            }
            other => return Err(format!("unknown method '{other}'")),
        }
        Ok(json!({}))
    }

    /// The `scene.*` requests. Each one edits a copy of the scene, saves it to
    /// site.json and only then makes it the session's scene.
    fn compose(&self, inner: &mut Inner, method: &str, p: &Value) -> Result<Value, String> {
        let mut scene = inner.scene.clone();
        let mut result = json!({});
        // `scene.set` changes one layer; the others change the list.
        let mut changed_layer = None;
        match method {
            "scene.add" => {
                if scene.len() >= MAX_SCENE_LAYERS {
                    return Err(format!("a scene holds at most {MAX_SCENE_LAYERS} layers"));
                }
                let wanted = p["use"].as_str().ok_or("missing use")?;
                let def = self.catalog.iter().position(|d| d.id == wanted).ok_or_else(|| format!("unknown layer '{wanted}'"))?;
                let base = &self.catalog[def].id;
                let id = match p["id"].as_str() {
                    Some(id) if !is_instance_id(id) => return Err("id must be lowercase letters, digits and dashes".into()),
                    Some(id) if scene.iter().any(|i| i.id == id) => return Err(format!("the scene already has a layer '{id}'")),
                    Some(id) => id.to_string(),
                    // The first copy is named after the layer, the next ones `-2`, `-3`, ...
                    None => std::iter::once(base.clone())
                        .chain((2..).map(|n| format!("{base}-{n}")))
                        .find(|id| scene.iter().all(|i| &i.id != id))
                        .expect("an unused id exists"),
                };
                let saved = LayerRef {
                    r#use: self.catalog[def].source.clone(),
                    id: (id != *base).then(|| id.clone()),
                    active: p["active"].as_bool().unwrap_or(true),
                    params: match &p["params"] {
                        Value::Null => Map::new(),
                        Value::Object(params) => self.catalog[def].validate(params, false)?,
                        _ => return Err("params must be an object".into()),
                    },
                };
                let instance = Self::instance(&self.catalog, def, saved, false).map_err(|e| e.to_string())?;
                let index = p["index"].as_u64().map_or(scene.len(), |i| (i as usize).min(scene.len()));
                scene.insert(index, instance);
                result = json!({ "id": id });
            }
            "scene.remove" => {
                let index = inner.position(p["layer"].as_str().ok_or("missing layer")?)?;
                scene.remove(index);
            }
            "scene.move" => {
                let from = inner.position(p["layer"].as_str().ok_or("missing layer")?)?;
                let to = (p["index"].as_u64().ok_or("missing index")? as usize).min(scene.len() - 1);
                let instance = scene.remove(from);
                scene.insert(to, instance);
            }
            "scene.set" => {
                let index = inner.position(p["layer"].as_str().ok_or("missing layer")?)?;
                let instance = &mut scene[index];
                match &p["params"] {
                    Value::Null => {}
                    Value::Object(patch) => {
                        let clean = self.catalog[instance.def].validate(patch, false)?;
                        instance.state.params.extend(clean.clone());
                        instance.saved.params.extend(clean);
                    }
                    _ => return Err("params must be an object".into()),
                }
                if let Some(active) = p["active"].as_bool() {
                    instance.state.active = active;
                    instance.saved.active = active;
                }
                changed_layer = Some(index);
            }
            other => return Err(format!("unknown method '{other}'")),
        }
        let saved: Vec<LayerRef> = scene.iter().map(|i| i.saved.clone()).collect();
        self.site.save_layers(&saved).map_err(|e| format!("could not save site.json: {e}"))?;
        inner.scene = scene;
        match changed_layer {
            Some(index) => self.emit_layer(&inner.scene[index].id, &inner.scene[index].state),
            None => self.emit("state.scene", json!({ "scene": inner.order(), "layers": inner.layers() })),
        }
        Ok(result)
    }

    /// Called under the lock, so events are broadcast in the order changes were applied.
    fn emit_layer(&self, layer: &str, state: &LayerState) {
        self.emit("state.layer", json!({ "layer": layer, "state": state }));
    }
}

/// One `[lon, lat]` position. Anything after the first two numbers is dropped.
fn clean_position(value: &Value) -> Result<Value, String> {
    let pair = value.as_array().filter(|a| a.len() >= 2).ok_or("a position must be [lon, lat]")?;
    let lon = pair[0].as_f64().filter(|v| (-180.0..=180.0).contains(v)).ok_or("longitude must be between -180 and 180")?;
    let lat = pair[1].as_f64().filter(|v| (-90.0..=90.0).contains(v)).ok_or("latitude must be between -90 and 90")?;
    Ok(json!([lon, lat]))
}

fn clean_path(value: &Value, least: usize, budget: &mut usize) -> Result<Vec<Value>, String> {
    let positions = value.as_array().ok_or("coordinates must be a list of positions")?;
    if positions.len() < least {
        return Err(format!("needs at least {least} positions"));
    }
    *budget = budget.checked_sub(positions.len()).ok_or(format!("more than {MAX_VERTICES} positions"))?;
    positions.iter().map(clean_position).collect()
}

/// Checks a tool's geometry against its kind and returns it as plain GeoJSON in WGS84:
/// `Point`, `LineString` or `Polygon` with closed rings, and nothing else attached.
fn clean_geometry(kind: ToolKind, geometry: &Value) -> Result<Value, String> {
    let name = match kind {
        ToolKind::Point => "Point",
        ToolKind::Line => "LineString",
        ToolKind::Polygon => "Polygon",
    };
    if geometry["type"] != name {
        return Err(format!("geometry must be a GeoJSON {name}"));
    }
    let coordinates = &geometry["coordinates"];
    let mut budget = MAX_VERTICES;
    let cleaned = match kind {
        ToolKind::Point => clean_position(coordinates)?,
        ToolKind::Line => Value::Array(clean_path(coordinates, 2, &mut budget)?),
        ToolKind::Polygon => {
            let rings = coordinates.as_array().filter(|r| !r.is_empty()).ok_or("a polygon needs a ring")?;
            let mut out = Vec::new();
            for ring in rings {
                let ring = clean_path(ring, 4, &mut budget)?;
                if ring.first() != ring.last() {
                    return Err("a polygon ring must end where it starts".into());
                }
                out.push(Value::Array(ring));
            }
            Value::Array(out)
        }
    };
    Ok(json!({ "type": name, "coordinates": cleaned }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub(options: SessionOptions) -> Hub {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sites/sample");
        let site = Site::load(dir).unwrap();
        let catalog = crate::layers::load_catalog(&site, &site.dir.join("../../packages/layers")).unwrap();
        Hub::new(&site, catalog, 4170, Some("http://10.0.0.5:4170/".into()), options).unwrap()
    }

    fn slots(hub: &Hub) -> Vec<(usize, bool)> {
        hub.inner.lock().unwrap().participants().iter().map(|p| (p.slot, p.connected)).collect()
    }

    fn token(hub: &Hub, surface: u64) -> String {
        hub.welcome(surface)["resume"].as_str().unwrap().to_string()
    }

    #[test]
    fn the_join_url_carries_the_code() {
        let hub = hub(SessionOptions::default());
        let code = hub.session().code.clone();
        assert_eq!(code.len(), 4);
        assert_eq!(hub.session().join_url.as_deref(), Some(format!("http://10.0.0.5:4170/phone?c={code}").as_str()));
    }

    #[test]
    fn a_dropped_phone_gets_its_seat_back_within_the_hold() {
        let hub = hub(SessionOptions::default());
        let code = hub.session().code.clone();
        let t0 = Instant::now();
        let first = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap();
        let second = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap();
        let ticket = token(&hub, first.surface);
        assert_ne!(ticket, token(&hub, second.surface));
        assert!(hub.welcome(999)["resume"].is_null(), "only the seat's own surface is told the token");

        // The seat stays in the list, marked as away, and nobody else is given it.
        let hold = hub.leave_at(first.surface, t0).unwrap();
        assert_eq!(slots(&hub), [(0, false), (1, true)]);
        let third = hub.join_at(Role::Phone, Some(&code), None, t0 + Duration::from_secs(1)).unwrap();
        assert_eq!(slots(&hub), [(0, false), (1, true), (2, true)]);

        // Back after 59 s: same slot, new surface, and the old hold no longer releases it.
        let back = hub.join_at(Role::Phone, Some(&code), Some(&ticket), t0 + Duration::from_secs(59)).unwrap();
        assert_ne!(back.surface, first.surface);
        assert_eq!(slots(&hub), [(0, true), (1, true), (2, true)]);
        assert_eq!(token(&hub, back.surface), ticket);
        hub.expire(hold);
        assert_eq!(slots(&hub), [(0, true), (1, true), (2, true)]);
        // The connection that was replaced leaving later changes nothing either.
        assert!(hub.leave_at(first.surface, t0).is_none());
        let _ = third;
    }

    #[test]
    fn a_seat_is_released_when_the_hold_runs_out() {
        let hub = hub(SessionOptions { max_phones: 1, ..SessionOptions::default() });
        let code = hub.session().code.clone();
        let t0 = Instant::now();
        let first = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap();
        let ticket = token(&hub, first.surface);
        let hold = hub.leave_at(first.surface, t0).unwrap();

        // While it is held the session is full for everyone else.
        assert_eq!(hub.join_at(Role::Phone, Some(&code), None, t0 + Duration::from_secs(30)).err().unwrap(), "session full");
        // After 60 s the seat is free even if the timer has not fired, and the old token is just a new join.
        let late = hub.join_at(Role::Phone, Some(&code), Some(&ticket), t0 + Duration::from_secs(61)).unwrap();
        assert_ne!(token(&hub, late.surface), ticket);
        hub.expire(hold);
        assert_eq!(slots(&hub), [(0, true)]);

        // The timer releases a seat nobody came back to.
        let hold = hub.leave_at(late.surface, t0).unwrap();
        hub.expire(hold);
        assert_eq!(slots(&hub), []);
    }

    #[test]
    fn a_second_connection_with_the_token_takes_the_seat_over() {
        let hub = hub(SessionOptions::default());
        let code = hub.session().code.clone();
        let first = hub.join(Role::Phone, Some(&code), None).unwrap();
        let ticket = token(&hub, first.surface);
        let second = hub.join(Role::Phone, Some(&code), Some(&ticket)).unwrap();
        assert_eq!(slots(&hub), [(0, true)]);
        // The first connection is told to go, and no longer counts as a phone.
        assert!(tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async { tokio::time::timeout(Duration::from_secs(1), first.kick.unwrap().notified()).await.is_ok() }));
        assert!(!hub.allow(first.surface));
        assert!(hub.allow(second.surface));
        // A token is no use without the code.
        assert!(hub.join(Role::Phone, None, Some(&ticket)).is_err());
    }

    #[test]
    fn phones_get_twenty_requests_a_second() {
        let hub = hub(SessionOptions::default());
        let code = hub.session().code.clone();
        let t0 = Instant::now();
        let phone = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap().surface;
        let other = hub.join_at(Role::Phone, Some(&code), None, t0).unwrap().surface;
        let burst = (0..50).filter(|_| hub.allow_at(phone, t0)).count();
        assert_eq!(burst, 20);
        // One phone flooding does not use up another's allowance.
        assert!(hub.allow_at(other, t0));
        // Half a second later ten more are allowed, and never more than a second's worth is saved up.
        let later = (0..50).filter(|_| hub.allow_at(phone, t0 + Duration::from_millis(500))).count();
        assert_eq!(later, 10);
        let saved = (0..50).filter(|_| hub.allow_at(phone, t0 + Duration::from_secs(60))).count();
        assert_eq!(saved, 20);
    }

    #[test]
    fn tool_geometry_is_checked_against_the_tool() {
        let point = json!({ "type": "Point", "coordinates": [11.97, 57.7, 12.0], "crs": "x" });
        assert_eq!(clean_geometry(ToolKind::Point, &point).unwrap(), json!({ "type": "Point", "coordinates": [11.97, 57.7] }));
        assert!(clean_geometry(ToolKind::Line, &point).is_err());
        assert!(clean_geometry(ToolKind::Point, &json!({ "type": "Point", "coordinates": [181, 0] })).is_err());
        assert!(clean_geometry(ToolKind::Point, &json!({ "type": "Point", "coordinates": ["a", 0] })).is_err());
        assert!(clean_geometry(ToolKind::Point, &json!({ "type": "Point", "coordinates": [1] })).is_err());

        let line =
            |n: usize| json!({ "type": "LineString", "coordinates": (0..n).map(|i| json!([i as f64 * 1e-4, 0])).collect::<Vec<_>>() });
        assert!(clean_geometry(ToolKind::Line, &line(1)).is_err());
        assert!(clean_geometry(ToolKind::Line, &line(2)).is_ok());
        assert!(clean_geometry(ToolKind::Line, &line(MAX_VERTICES)).is_ok());
        assert!(clean_geometry(ToolKind::Line, &line(MAX_VERTICES + 1)).is_err());

        let ring = json!([[0, 0], [1, 0], [1, 1], [0, 0]]);
        assert!(clean_geometry(ToolKind::Polygon, &json!({ "type": "Polygon", "coordinates": [ring] })).is_ok());
        let open = json!({ "type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1]]] });
        assert!(clean_geometry(ToolKind::Polygon, &open).is_err());
        assert!(clean_geometry(ToolKind::Polygon, &json!({ "type": "Polygon", "coordinates": [] })).is_err());
    }
}
