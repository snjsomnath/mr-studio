//! Session state. The hub is the only authority over it: surfaces send requests,
//! the hub validates, updates and broadcasts.
//!
//! The scene is the ordered list of layer instances, bottom first. It starts as the
//! `layers` list of `site.json`, each layer followed by its items, and the `scene.*`
//! requests edit both together.

use std::hash::{BuildHasher, Hasher};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use mrs_site::{is_instance_id, LayerButton, LayerItem, LayerRef, Site, SiteInfo, Steps};
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
    /// How the site offers the layer on the controller. Empty fields fall back to the layer package.
    pub button: LayerButton,
    /// Ids of the controls the controller and phones leave out.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hide: Vec<String>,
    /// For an item: the layer it belongs to. It has no button and comes on with that layer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// How Next moves through the layer, and a sequence's steps, as site.json has them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Steps>,
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

/// One layer, or one item of a layer, in the scene.
#[derive(Debug, Clone)]
struct Instance {
    id: String,
    /// Index into the catalogue.
    def: usize,
    /// The layer that owns this item. `None` for a layer of the scene.
    parent: Option<String>,
    /// The entry as site.json holds it, without its items (they follow it in the scene).
    /// For an item, `active` says whether it comes on with its layer. Live changes
    /// (`layer.set`, `layer.activate`) do not touch it.
    saved: LayerRef,
    state: LayerState,
}

impl Instance {
    fn item(&self) -> LayerItem {
        let s = &self.saved;
        LayerItem { r#use: s.r#use.clone(), id: s.id.clone(), active: s.active, params: s.params.clone(), hide: s.hide.clone() }
    }
}

fn item_ref(item: &LayerItem) -> LayerRef {
    LayerRef {
        r#use: item.r#use.clone(),
        id: item.id.clone(),
        active: item.active,
        params: item.params.clone(),
        button: LayerButton::default(),
        hide: item.hide.clone(),
        items: Vec::new(),
        steps: None,
    }
}

/// The scene as site.json's `layers`: each layer with the items that follow it.
fn saved_layers(scene: &[Instance]) -> Vec<LayerRef> {
    let mut out: Vec<LayerRef> = Vec::new();
    for instance in scene {
        match (&instance.parent, out.last_mut()) {
            (Some(_), Some(layer)) => layer.items.push(instance.item()),
            _ => out.push(LayerRef { items: Vec::new(), ..instance.saved.clone() }),
        }
    }
    out
}

/// The positions of a layer and its items: the layer at `at`, then everything with it as parent.
fn block(scene: &[Instance], at: usize) -> std::ops::Range<usize> {
    let id = &scene[at].id;
    let end = at + 1 + scene[at + 1..].iter().take_while(|i| i.parent.as_ref() == Some(id)).count();
    at..end
}

/// Where the `index`th entry of a list goes: the scene's layers when `parent` is `None`,
/// otherwise that layer's items. Past the end means at the end of that list.
fn insert_position(scene: &[Instance], parent: Option<&str>, index: Option<u64>) -> Result<usize, String> {
    let index = index.map_or(usize::MAX, |i| i as usize);
    match parent {
        None => {
            let tops: Vec<usize> = scene.iter().enumerate().filter(|(_, i)| i.parent.is_none()).map(|(n, _)| n).collect();
            Ok(tops.get(index).copied().unwrap_or(scene.len()))
        }
        Some(parent) => {
            let at = scene
                .iter()
                .position(|i| i.id == parent && i.parent.is_none())
                .ok_or_else(|| format!("there is no layer '{parent}' to hold it"))?;
            let range = block(scene, at);
            Ok(range.start + 1 + index.min(range.len() - 1))
        }
    }
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
    /// Replaced when data is imported into the site.
    info: RwLock<SiteInfo>,
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
        let find = |used: &str| {
            catalog
                .iter()
                .position(|d| d.source == used)
                .ok_or_else(|| anyhow::anyhow!("site.json uses layer '{used}', which is not available"))
        };
        for reference in &site.manifest.layers {
            let layer = LayerRef { items: Vec::new(), ..reference.clone() };
            let parent = Self::instance(&catalog, find(&reference.r#use)?, layer, None, true)?;
            let on = parent.state.active;
            scene.push(parent);
            for item in &reference.items {
                let mut item = Self::instance(&catalog, find(&item.r#use)?, item_ref(item), Some(reference.id.clone()), true)?;
                item.state.active &= on;
                scene.push(item);
            }
        }
        for (n, instance) in scene.iter().enumerate() {
            if scene[..n].iter().any(|i| i.id == instance.id) {
                anyhow::bail!("'{}' names two entries of the scene in site.json; give each its own \"id\"", instance.id);
            }
        }
        let code = format!("{:04}", random_u64() % 10_000);
        let join_url = join_base.map(|base| format!("{}/phone?c={code}", base.trim_end_matches('/')));
        let session = SessionInfo { id: format!("{:016x}", random_u64()), code, port, join_url };
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            site: site.clone(),
            info: RwLock::new(site.info()),
            session,
            options,
            catalog,
            inner: Mutex::new(Inner { scene, seats: Vec::new(), next_surface: 1 }),
            events,
        })
    }

    /// Builds an instance from a site.json entry. With `lenient`, params that do not
    /// validate are ignored with a warning (a hand-edited file should still start).
    fn instance(catalog: &[LayerDef], def: usize, saved: LayerRef, parent: Option<String>, lenient: bool) -> anyhow::Result<Instance> {
        let layer = &catalog[def];
        let id = saved.id.clone();
        let mut params = layer.defaults();
        match layer.validate(&saved.params, false) {
            Ok(overrides) => params.extend(overrides),
            Err(e) if lenient => tracing::warn!("site.json params for layer '{id}' ignored: {e}"),
            Err(e) => anyhow::bail!(e),
        }
        let state = LayerState {
            layer: layer.id.clone(),
            active: saved.active,
            intensity: 1.0,
            params,
            shared: Map::new(),
            button: saved.button.clone(),
            // A control the layer package no longer has is not worth refusing the site over.
            hide: saved.hide.iter().filter(|id| layer.controls.iter().any(|c| &c.id == *id)).cloned().collect(),
            parent: parent.clone(),
            steps: saved.steps.clone(),
        };
        Ok(Instance { id, def, parent, saved, state })
    }

    pub fn session(&self) -> &SessionInfo {
        &self.session
    }

    pub fn site(&self) -> SiteInfo {
        self.info.read().unwrap().clone()
    }

    /// Takes the site as it is after its data changed, and tells every surface.
    pub fn site_changed(&self, info: SiteInfo) {
        *self.info.write().unwrap() = info.clone();
        self.emit("site.changed", json!({ "site": info }));
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
                "site": &*self.info.read().unwrap(),
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
        if method == "layer.activate" {
            if !role.may_activate() {
                return Err("phones cannot turn layers on or off".into());
            }
            let active = p["active"].as_bool().ok_or("missing active")?;
            if let Some(parent) = inner.scene[index].parent.clone() {
                if active && !inner.scene[inner.position(&parent)?].state.active {
                    return Err(format!("'{layer}' comes on with '{parent}'; open that layer first"));
                }
            }
            self.switch(&mut inner.scene, index, active);
            return Ok(json!({}));
        }
        let def = &self.catalog[inner.scene[index].def];
        let state = &mut inner.scene[index].state;
        match method {
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
                let def = self
                    .catalog
                    .iter()
                    .position(|d| d.source == wanted || d.id == wanted)
                    .ok_or_else(|| format!("unknown layer '{wanted}'"))?;
                let parent = match &p["parent"] {
                    Value::Null => None,
                    Value::String(parent) => Some(parent.clone()),
                    _ => return Err("parent is the id of a layer in the scene".into()),
                };
                if parent.is_some() && !p["button"].is_null() {
                    return Err("an item has no button: it comes on with its layer".into());
                }
                if let Some(name) = self.catalog[def].missing_data(&self.info.read().unwrap().data).map_err(|e| e.to_string())? {
                    return Err(format!("this site has no '{name}' dataset, which the layer needs"));
                }
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
                    id: id.clone(),
                    active: p["active"].as_bool().unwrap_or(true),
                    params: match &p["params"] {
                        Value::Null => Map::new(),
                        Value::Object(params) => self.catalog[def].validate(params, false)?,
                        _ => return Err("params must be an object".into()),
                    },
                    button: button_patch(LayerButton::default(), &p["button"])?,
                    hide: hide_list(&self.catalog[def], &p["hide"])?.unwrap_or_default(),
                    items: Vec::new(),
                    steps: None,
                };
                let index = insert_position(&scene, parent.as_deref(), p["index"].as_u64())?;
                let mut instance = Self::instance(&self.catalog, def, saved, parent.clone(), false).map_err(|e| e.to_string())?;
                if let Some(parent) = &parent {
                    instance.state.active &= scene.iter().any(|i| &i.id == parent && i.state.active);
                }
                scene.insert(index, instance);
                result = json!({ "id": id });
            }
            "scene.remove" => {
                let index = inner.position(p["layer"].as_str().ok_or("missing layer")?)?;
                let removed: Vec<Instance> = scene.drain(block(&scene, index)).collect();
                // A sequence step that showed a removed layer goes with it.
                let mut dropped = 0;
                for instance in &mut scene {
                    if let Some(steps) = &mut instance.saved.steps {
                        let before = steps.sequence.len();
                        steps.sequence.retain(|step| removed.iter().all(|r| r.id != step.layer));
                        if steps.sequence.len() != before {
                            dropped += before - steps.sequence.len();
                            instance.state.steps = Some(steps.clone());
                        }
                    }
                }
                if dropped > 0 {
                    result = json!({ "dropped_steps": dropped });
                }
            }
            "scene.move" => {
                let id = p["layer"].as_str().ok_or("missing layer")?;
                let index = p["index"].as_u64().ok_or("missing index")?;
                let from = inner.position(id)?;
                let mut moving: Vec<Instance> = scene.drain(block(&scene, from)).collect();
                // `parent` left out keeps the instance where it is; null makes an item a layer of the scene.
                let parent = match p.get("parent") {
                    None => moving[0].parent.clone(),
                    Some(Value::Null) => None,
                    Some(Value::String(parent)) => Some(parent.clone()),
                    Some(_) => return Err("parent is the id of a layer in the scene, or null".into()),
                };
                if let Some(parent) = &parent {
                    if parent == id {
                        return Err("a layer cannot hold itself".into());
                    }
                    if moving.len() > 1 || moving[0].saved.steps.is_some() {
                        return Err(format!("'{id}' has items or steps of its own, so it cannot become an item"));
                    }
                    if !moving[0].saved.button.is_empty() {
                        return Err(format!("'{id}' has a button; clear it first, because an item comes on with its layer"));
                    }
                }
                let first = &mut moving[0];
                if let Some(parent) = &parent {
                    let on = scene
                        .iter()
                        .find(|i| &i.id == parent)
                        .ok_or_else(|| format!("there is no layer '{parent}' to hold it"))?
                        .state
                        .active;
                    first.state.active = on && first.saved.active;
                }
                first.parent = parent.clone();
                first.state.parent = parent.clone();
                let to = insert_position(&scene, parent.as_deref(), Some(index))?;
                scene.splice(to..to, moving);
            }
            "scene.set" => {
                let index = inner.position(p["layer"].as_str().ok_or("missing layer")?)?;
                if scene[index].parent.is_some() && !p["button"].is_null() {
                    return Err("an item has no button: it comes on with its layer".into());
                }
                if let Some(steps) = p.get("steps") {
                    let steps = self.clean_steps(&scene, index, steps)?;
                    scene[index].saved.steps = steps.clone();
                    scene[index].state.steps = steps;
                }
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
                let active = p["active"].as_bool();
                if let Some(active) = active {
                    instance.saved.active = active;
                }
                let button = button_patch(instance.saved.button.clone(), &p["button"])?;
                instance.state.button = button.clone();
                instance.saved.button = button;
                if let Some(hide) = hide_list(&self.catalog[instance.def], &p["hide"])? {
                    instance.state.hide = hide.clone();
                    instance.saved.hide = hide;
                }
                changed_layer = Some((index, active));
            }
            other => return Err(format!("unknown method '{other}'")),
        }
        self.site.save_layers(&saved_layers(&scene)).map_err(|e| format!("could not save site.json: {e}"))?;
        inner.scene = scene;
        match changed_layer {
            Some((index, Some(active))) => {
                // An item comes on only while its layer is on.
                let on = match inner.scene[index].parent.clone() {
                    Some(parent) => active && inner.scene.iter().any(|i| i.id == parent && i.state.active),
                    None => active,
                };
                self.switch(&mut inner.scene, index, on);
            }
            Some((index, None)) => self.emit_layer(&inner.scene[index].id, &inner.scene[index].state),
            None => self.emit("state.scene", json!({ "scene": inner.order(), "layers": inner.layers() })),
        }
        Ok(result)
    }

    /// Turns an instance on or off and tells every surface. A layer's items follow it:
    /// on with it when they are set to come on, off with it always.
    fn switch(&self, scene: &mut [Instance], index: usize, active: bool) {
        scene[index].state.active = active;
        self.emit_layer(&scene[index].id, &scene[index].state);
        if scene[index].parent.is_none() {
            for n in block(scene, index).skip(1) {
                let on = active && scene[n].saved.active;
                if scene[n].state.active != on {
                    scene[n].state.active = on;
                    self.emit_layer(&scene[n].id, &scene[n].state);
                }
            }
        }
    }

    /// Reads the `steps` of a `scene.set`; null clears them. Steps that show other layers are
    /// only for a sequence layer, and each step's params are checked against the layer it
    /// shows. Whether each step's layer may be shown is checked with the rest of the site.
    fn clean_steps(&self, scene: &[Instance], index: usize, value: &Value) -> Result<Option<Steps>, String> {
        if value.is_null() {
            return Ok(None);
        }
        if scene[index].parent.is_some() {
            return Err("an item has no steps: it comes on with its layer".into());
        }
        let mut steps: Steps = serde_json::from_value(value.clone()).map_err(|e| format!("steps: {e}"))?;
        let def = &self.catalog[scene[index].def];
        if !steps.sequence.is_empty() && def.manifest["sequence"] != true {
            return Err(format!("only a sequence, such as the slideshow, has steps that show other layers; '{}' is not one", def.id));
        }
        for step in &mut steps.sequence {
            if step.params.is_empty() {
                continue;
            }
            let shown = scene
                .iter()
                .find(|i| i.id == step.layer)
                .ok_or_else(|| format!("a step shows '{}', which is not in the scene", step.layer))?;
            step.params =
                self.catalog[shown.def].validate(&step.params, false).map_err(|e| format!("a step showing '{}': {e}", step.layer))?;
        }
        Ok(Some(steps))
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

/// Reads the `hide` of a `scene.*` request: the whole list of control ids to leave off the
/// controller and phones. Absent keeps what is there.
fn hide_list(layer: &LayerDef, value: &Value) -> Result<Option<Vec<String>>, String> {
    let list = match value {
        Value::Null => return Ok(None),
        Value::Array(list) => list,
        _ => return Err("hide must be a list of control ids".into()),
    };
    let mut hide: Vec<String> = Vec::new();
    for id in list {
        let id = id.as_str().ok_or("hide must be a list of control ids")?;
        if !layer.controls.iter().any(|c| c.id == id) {
            return Err(format!("layer '{}' has no control '{id}'", layer.id));
        }
        if !hide.iter().any(|h| h == id) {
            hide.push(id.to_string());
        }
    }
    Ok(Some(hide))
}

/// Applies a `button` patch from a `scene.*` request: a string sets a field, `null` clears it,
/// and a field that is left out stays as it is.
fn button_patch(mut button: LayerButton, patch: &Value) -> Result<LayerButton, String> {
    let patch = match patch {
        Value::Null => return Ok(button),
        Value::Object(patch) => patch,
        _ => return Err("button must be an object".into()),
    };
    for (key, value) in patch {
        if key == "order" {
            button.order = match value {
                Value::Null => None,
                Value::Number(n) => n.as_f64(),
                _ => return Err("button.order must be a number or null".into()),
            };
            continue;
        }
        let text = match value {
            Value::Null => None,
            Value::String(text) => Some(text.trim().to_string()).filter(|t| !t.is_empty()),
            _ => return Err(format!("button.{key} must be text or null")),
        };
        match key.as_str() {
            "group" => button.group = text,
            "name" => button.name = text,
            "description" => button.description = text,
            "icon" => button.icon = text,
            "side" => {
                button.side = match text.as_deref() {
                    None => None,
                    Some("left") => Some(mrs_site::ButtonSide::Left),
                    Some("right") => Some(mrs_site::ButtonSide::Right),
                    Some(other) => return Err(format!("button.side is 'left' or 'right', not '{other}'")),
                }
            }
            other => return Err(format!("a button has no '{other}'")),
        }
    }
    match button.problem() {
        Some(problem) => Err(problem),
        None => Ok(button),
    }
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
