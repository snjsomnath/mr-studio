//! Session state. The hub is the only authority over it: surfaces send requests,
//! the hub validates, updates and broadcasts.
//!
//! The scene is the ordered list of layer instances, bottom first. It starts as the
//! `layers` list of `site.json`, each layer followed by its items, and the `scene.*`
//! requests edit both together.

use std::hash::{BuildHasher, Hasher};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use mrs_site::{is_instance_id, LayerButton, LayerItem, LayerRef, Reveal, Site, SiteInfo, StepMode, Steps};
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
/// How long a sequence step stays in timed mode when it gives no `duration_s`.
const STEP_SECONDS: f64 = 8.0;
/// The pause between sub-steps while a layer plays them (the Chalmers demo's).
const SUB_STEP_SECONDS: f64 = 1.4;
/// The most sub-steps a layer may report.
const MAX_SUB_STEPS: usize = 64;

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
    /// Where Next is, while the layer is on: a sequence's current step, or the sub-steps a
    /// layer reported (`layer.substeps`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<StepState>,
    /// For the layer a sequence is showing as its current step: that sequence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shown_by: Option<String>,
    /// Part of the map at rest although its package is not a base or ambient layer: a layer
    /// of the scene that site.json starts on and gives no button, such as a Map data layer
    /// colouring the streets (#204). It has no button on the controller and stays on while
    /// the button layers open and close.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub rest: bool,
}

/// Where Next is in a layer (`docs/contracts/present.md`, Steps). For a sequence, `index`
/// and `count` count its steps and `sub` is the shown layer's sub-steps. For any other
/// layer they count its sub-steps: `index` is how many are revealed, 0 to `count`.
#[derive(Debug, Clone, Serialize)]
pub struct StepState {
    pub index: usize,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<SubSteps>,
    /// Moving on by itself: timed mode, or sub-steps played one after another.
    pub playing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// For sub-steps: what each one is called, for the controller's legend.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub titles: Vec<String>,
    /// When a playing layer moves on next.
    #[serde(skip)]
    due: Option<Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SubSteps {
    pub index: usize,
    pub count: usize,
}

/// Where a `layer.step` goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StepTo {
    Next,
    /// Next as the timer sends it: it never stops at the end of a step's sub-steps.
    Auto,
    /// To the next step, whatever sub-steps are left.
    Skip,
    Previous,
    First,
    /// Every sub-step revealed.
    All,
    At(usize),
}

impl StepTo {
    fn parse(value: &Value) -> Result<Self, String> {
        match value {
            Value::String(s) => match s.as_str() {
                "next" => Ok(Self::Next),
                "skip" => Ok(Self::Skip),
                "previous" => Ok(Self::Previous),
                "first" => Ok(Self::First),
                "all" => Ok(Self::All),
                other => Err(format!("unknown step '{other}'; use next, previous, first, skip, all or a number")),
            },
            Value::Number(n) => n.as_u64().map(|n| Self::At(n as usize)).ok_or_else(|| "a step number is 0 or more".into()),
            _ => Err("missing to".into()),
        }
    }
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
    /// Works out `state.rest` again after its entry's `active`, `button` or parent changed.
    fn sync_rest(&mut self) {
        self.state.rest = self.parent.is_none() && self.saved.active && self.saved.button.is_empty();
    }

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
/// The layer the sequence `id` is showing as its current step.
fn shown(scene: &[Instance], id: &str) -> Option<usize> {
    scene.iter().position(|i| i.state.shown_by.as_deref() == Some(id))
}

/// The catalogue index of the last instance pushed, while the scene is being built.
fn parent_def(scene: &[Instance]) -> usize {
    scene.last().map_or(0, |i| i.def)
}

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
    /// Every layer that can be added to a scene. Replaced whole when a custom layer is
    /// saved or removed; instances keep their index into it, which removal recomputes.
    catalog: RwLock<Arc<Vec<LayerDef>>>,
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
            // A sequence's items come on one at a time, as its steps show them.
            let sequence = catalog[parent_def(&scene)].manifest["sequence"] == true;
            for item in &reference.items {
                let mut item = Self::instance(&catalog, find(&item.r#use)?, item_ref(item), Some(reference.id.clone()), true)?;
                item.state.active &= on && !sequence;
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
        let hub = Self {
            site: site.clone(),
            info: RwLock::new(site.info()),
            session,
            options,
            catalog: RwLock::new(Arc::new(catalog)),
            inner: Mutex::new(Inner { scene, seats: Vec::new(), next_surface: 1 }),
            events,
        };
        // A sequence that starts on shows its first step.
        {
            let mut inner = hub.inner.lock().unwrap();
            for at in 0..inner.scene.len() {
                if inner.scene[at].state.active && hub.is_sequence(&inner.scene[at]) {
                    hub.switch(&mut inner.scene, at, true);
                }
            }
        }
        Ok(hub)
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
            step: None,
            shown_by: None,
            rest: false,
        };
        let mut instance = Instance { id, def, parent, saved, state };
        instance.sync_rest();
        Ok(instance)
    }

    /// The layer catalogue as it is now.
    fn catalog(&self) -> Arc<Vec<LayerDef>> {
        self.catalog.read().unwrap().clone()
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
            "manifests": self.catalog().iter().map(|d| &d.manifest).collect::<Vec<_>>(),
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
        if method == "site.tv" {
            if !role.may_compose() {
                return Err("this surface cannot change the table's settings".into());
            }
            return self.set_tv(p);
        }
        if method == "site.display" {
            if !role.may_compose() {
                return Err("this surface cannot change the table's settings".into());
            }
            return self.set_display(p);
        }
        if method.starts_with("custom.") || method == "palette.set" {
            if !role.may_compose() {
                return Err("this surface cannot edit the table".into());
            }
            return self.author(&mut inner, method, p);
        }
        if method == "layers.reset" {
            if !role.may_activate() {
                return Err("phones cannot turn layers on or off".into());
            }
            self.reset(&mut inner.scene);
            return Ok(json!({}));
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
            // Opened from its own button, a layer a sequence is showing leaves the sequence.
            if active && inner.scene[index].state.shown_by.is_some() {
                self.release(&mut inner.scene, index, false);
            }
            self.switch(&mut inner.scene, index, active);
            return Ok(json!({}));
        }
        match method {
            "layer.step" => {
                let to = StepTo::parse(&p["to"])?;
                if to == StepTo::Auto {
                    return Err("missing to".into());
                }
                if !inner.scene[index].state.active {
                    return Err(format!("'{layer}' is off; open it first"));
                }
                self.advance(&mut inner.scene, index, to, Instant::now())?;
                return Ok(json!({}));
            }
            "layer.play" => {
                let playing = p["playing"].as_bool().ok_or("missing playing")?;
                let now = Instant::now();
                let scene = &mut inner.scene;
                let step = scene[index].state.step.as_mut().ok_or_else(|| format!("'{layer}' has no steps to play"))?;
                step.playing = playing;
                self.plan(scene, index, now);
                self.emit_layer(&scene[index].id, &scene[index].state);
                return Ok(json!({}));
            }
            "layer.substeps" => {
                if !role.may_publish() {
                    return Err("only the table reports a layer's sub-steps".into());
                }
                let count = p["count"].as_u64().ok_or("missing count")? as usize;
                if count > MAX_SUB_STEPS {
                    return Err(format!("a layer has at most {MAX_SUB_STEPS} sub-steps"));
                }
                let titles: Vec<String> = match &p["titles"] {
                    Value::Null => Vec::new(),
                    Value::Array(list) => {
                        list.iter().take(count).map(|t| t.as_str().unwrap_or_default().chars().take(80).collect()).collect()
                    }
                    _ => return Err("titles is a list of words".into()),
                };
                let scene = &mut inner.scene;
                if !scene[index].state.active {
                    return Err(format!("'{layer}' is off"));
                }
                // Every view of the table running the layer reports its sub-steps as it starts. The same
                // sub-steps again (a projector and an editor, or a view joining late) keep the reveal where it is.
                if scene[index].state.step.as_ref().is_some_and(|s| s.count == count && s.titles == titles) {
                    return Ok(json!({}));
                }
                let timed = scene[index].saved.steps.as_ref().and_then(|s| s.mode) == Some(StepMode::Timed);
                scene[index].state.step = (count > 0).then_some(StepState {
                    index: 0,
                    count,
                    sub: None,
                    playing: timed,
                    title: None,
                    description: None,
                    source: None,
                    titles,
                    due: None,
                });
                let now = Instant::now();
                self.plan(scene, index, now);
                self.emit_layer(&scene[index].id, &scene[index].state);
                self.mirror(scene, index, now);
                return Ok(json!({}));
            }
            _ => {}
        }
        let def = &self.catalog()[inner.scene[index].def];
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

    /// `site.tv { tv: { key: value | null } }`: changes the controller's table settings (theme,
    /// theme_name, rail_style, about), saves them to site.json and sends the new `tv` to every
    /// surface as `site.tv`, so a theme shows at once without a reload. `null` removes a key.
    fn set_tv(&self, p: &Value) -> Result<Value, String> {
        let patch = p["tv"].as_object().ok_or("missing tv")?;
        let mut tv = match self.info.read().unwrap().tv.clone() {
            Some(Value::Object(tv)) => tv,
            _ => Map::new(),
        };
        for (key, value) in patch {
            let fits = match key.as_str() {
                "theme" => value.as_object().is_some_and(|t| t.len() <= 64 && t.values().all(|v| v.as_str().is_some_and(|s| s.len() <= 160))),
                "theme_name" => value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 40),
                "rail_style" => matches!(value.as_str(), Some("icons" | "labelled")),
                "about" => value.is_object() && value.to_string().len() <= 8_000,
                "idle_reset_s" => value.as_f64().is_some_and(|s| (0.0..=3600.0).contains(&s)),
                "attract_s" => value.as_f64().is_some_and(|s| (2.0..=30.0).contains(&s)),
                _ => return Err(format!("'{key}' is not a controller setting that can be changed here")),
            };
            if value.is_null() {
                tv.remove(key);
            } else if fits {
                tv.insert(key.clone(), value.clone());
            } else {
                return Err(format!("'{key}' is not a valid value"));
            }
        }
        let tv = if tv.is_empty() { Value::Null } else { Value::Object(tv) };
        self.site.save_tv(tv.clone()).map_err(|e| format!("could not save site.json: {e}"))?;
        self.info.write().unwrap().tv = if tv.is_null() { None } else { Some(tv.clone()) };
        self.emit("site.tv", json!({ "tv": tv }));
        Ok(json!({ "tv": tv }))
    }

    /// `site.display { display: { quality: "draft" | "good" | "best" | null } }`: how the table's surfaces
    /// render (#134). Saved to site.json and sent to every surface as `site.display`, which apply it at once.
    fn set_display(&self, p: &Value) -> Result<Value, String> {
        let patch = p["display"].as_object().ok_or("missing display")?;
        let mut display = match self.info.read().unwrap().display.clone() {
            Some(Value::Object(display)) => display,
            _ => Map::new(),
        };
        for (key, value) in patch {
            let fits = match key.as_str() {
                "quality" => matches!(value.as_str(), Some("draft" | "good" | "best")),
                _ => return Err(format!("'{key}' is not a display setting")),
            };
            if value.is_null() {
                display.remove(key);
            } else if fits {
                display.insert(key.clone(), value.clone());
            } else {
                return Err(format!("'{key}' is not a valid value"));
            }
        }
        let display = if display.is_empty() { Value::Null } else { Value::Object(display) };
        self.site.save_display(display.clone()).map_err(|e| format!("could not save site.json: {e}"))?;
        self.info.write().unwrap().display = if display.is_null() { None } else { Some(display.clone()) };
        self.emit("site.display", json!({ "display": display }));
        Ok(json!({ "display": display }))
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
                let catalog = self.catalog();
                let def =
                    catalog.iter().position(|d| d.source == wanted || d.id == wanted).ok_or_else(|| format!("unknown layer '{wanted}'"))?;
                let parent = match &p["parent"] {
                    Value::Null => None,
                    Value::String(parent) => Some(parent.clone()),
                    _ => return Err("parent is the id of a layer in the scene".into()),
                };
                if parent.is_some() && !p["button"].is_null() {
                    return Err("an item has no button: it comes on with its layer".into());
                }
                if let Some(name) = self.catalog()[def].missing_data(&self.info.read().unwrap().data).map_err(|e| e.to_string())? {
                    return Err(format!("this site has no '{name}' dataset, which the layer needs"));
                }
                let base = &self.catalog()[def].id;
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
                    r#use: self.catalog()[def].source.clone(),
                    id: id.clone(),
                    active: p["active"].as_bool().unwrap_or(true),
                    params: match &p["params"] {
                        Value::Null => Map::new(),
                        Value::Object(params) => self.catalog()[def].validate(params, false)?,
                        _ => return Err("params must be an object".into()),
                    },
                    button: button_patch(LayerButton::default(), &p["button"])?,
                    hide: hide_list(&self.catalog()[def], &p["hide"])?.unwrap_or_default(),
                    items: Vec::new(),
                    steps: None,
                };
                let index = insert_position(&scene, parent.as_deref(), p["index"].as_u64())?;
                let mut instance = Self::instance(&self.catalog(), def, saved, parent.clone(), false).map_err(|e| e.to_string())?;
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
                first.sync_rest();
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
                        let clean = self.catalog()[instance.def].validate(patch, false)?;
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
                instance.sync_rest();
                if let Some(hide) = hide_list(&self.catalog()[instance.def], &p["hide"])? {
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
            Some((index, None)) => {
                let scene = &mut inner.scene;
                // A sequence that is on shows its steps as they are now.
                if !p["steps"].is_null() || p.get("steps").is_some() {
                    if let Some(old) = shown(scene, &scene[index].id) {
                        self.release(scene, old, true);
                    }
                    let at = scene[index].state.step.take().map_or(0, |s| s.index);
                    if scene[index].state.active && self.is_sequence(&scene[index]) {
                        let count = scene[index].saved.steps.as_ref().map_or(0, |s| s.sequence.len());
                        self.show_step(scene, index, at.min(count.saturating_sub(1)), Instant::now());
                    }
                }
                self.emit_layer(&scene[index].id, &scene[index].state)
            }
            None => self.emit("state.scene", json!({ "scene": inner.order(), "layers": inner.layers() })),
        }
        Ok(result)
    }

    /// The requests that change what the table can show rather than its scene: custom
    /// layers (`custom.save`, `custom.remove`) and the palette (`palette.set`). Each is
    /// written to site.json first and only then takes effect.
    fn author(&self, inner: &mut Inner, method: &str, p: &Value) -> Result<Value, String> {
        match method {
            "custom.save" => {
                let id = p["id"].as_str().ok_or("missing id")?.to_string();
                if !is_instance_id(&id) {
                    return Err("id must be lowercase letters, digits and dashes".into());
                }
                let recipe: mrs_site::CustomLayer = serde_json::from_value(p["recipe"].clone()).map_err(|e| format!("recipe: {e}"))?;
                let catalog = self.catalog();
                let source = format!("{}{id}", mrs_site::CUSTOM_PREFIX);
                if catalog.iter().any(|d| d.id == id && d.source != source) {
                    return Err(format!("'{id}' is the id of a core layer; give the custom layer another id"));
                }
                let def = crate::layers::custom_def(&id, &recipe).map_err(|e| format!("{e:#}"))?;
                let mut saved = self.site.saved_custom().map_err(|e| e.to_string())?;
                saved.insert(id.clone(), recipe);
                self.site.save_custom(&saved).map_err(|e| format!("could not save site.json: {e}"))?;
                let manifest = def.manifest.clone();
                let mut next = (*catalog).clone();
                let at = match next.iter().position(|d| d.source == source) {
                    Some(at) => {
                        next[at] = def;
                        at
                    }
                    None => {
                        next.push(def);
                        next.len() - 1
                    }
                };
                let next = Arc::new(next);
                *self.catalog.write().unwrap() = next.clone();
                self.emit("catalog.changed", json!({ "manifest": manifest }));
                // Instances of it keep the params its controls still accept.
                for instance in inner.scene.iter_mut().filter(|i| i.def == at) {
                    let mut params = next[at].defaults();
                    let kept: Map<String, Value> = instance
                        .state
                        .params
                        .iter()
                        .filter(|(k, _)| next[at].control(k).is_some())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    if let Ok(clean) = next[at].validate(&kept, false) {
                        params.extend(clean);
                    }
                    instance.state.params = params;
                    self.emit_layer(&instance.id, &instance.state);
                }
                Ok(json!({ "id": id, "use": source }))
            }
            "custom.remove" => {
                let id = p["id"].as_str().ok_or("missing id")?;
                let source = format!("{}{id}", mrs_site::CUSTOM_PREFIX);
                let catalog = self.catalog();
                let at = catalog.iter().position(|d| d.source == source).ok_or_else(|| format!("no custom layer '{id}'"))?;
                if let Some(used) = inner.scene.iter().find(|i| i.def == at) {
                    return Err(format!("'{}' on the table uses it; remove that first", used.id));
                }
                let mut saved = self.site.saved_custom().map_err(|e| e.to_string())?;
                saved.remove(id);
                self.site.save_custom(&saved).map_err(|e| format!("could not save site.json: {e}"))?;
                let mut next = (*catalog).clone();
                next.remove(at);
                for instance in &mut inner.scene {
                    if instance.def > at {
                        instance.def -= 1;
                    }
                }
                *self.catalog.write().unwrap() = Arc::new(next);
                self.emit("catalog.removed", json!({ "id": id }));
                Ok(json!({}))
            }
            "palette.set" => {
                let palette: Option<mrs_site::Palette> = match &p["palette"] {
                    Value::Null => None,
                    value => Some(serde_json::from_value(value.clone()).map_err(|e| format!("palette: {e}"))?),
                };
                self.site.save_palette(palette.as_ref()).map_err(|e| format!("could not save site.json: {e}"))?;
                self.info.write().unwrap().palette = palette.clone();
                self.emit("palette.changed", json!({ "palette": palette }));
                Ok(json!({}))
            }
            other => Err(format!("unknown method '{other}'")),
        }
    }

    /// Turns an instance on or off and tells every surface. A layer's items follow it:
    /// on with it when they are set to come on, off with it always.
    fn switch(&self, scene: &mut [Instance], index: usize, active: bool) {
        let sequence = self.is_sequence(&scene[index]);
        if !active {
            scene[index].state.step = None;
        }
        scene[index].state.active = active;
        if sequence && !active {
            if let Some(shown) = shown(scene, &scene[index].id) {
                self.release(scene, shown, true);
            }
        }
        // A sequence opens on its first step, so every surface sees its steps as it turns on.
        if sequence && active && scene[index].state.step.is_none() {
            self.show_step(scene, index, 0, Instant::now());
        } else {
            self.emit_layer(&scene[index].id, &scene[index].state);
        }
        if scene[index].parent.is_none() {
            for n in block(scene, index).skip(1) {
                // A sequence's own items come on only as its steps show them.
                let on = active && scene[n].saved.active && !sequence;
                if scene[n].state.active != on {
                    scene[n].state.active = on;
                    self.emit_layer(&scene[n].id, &scene[n].state);
                }
            }
        }
    }

    /// Puts the table back the way site.json starts it (the controller's Reset view, #198):
    /// layers that were opened go off, the map at rest comes back on, and every layer has
    /// its saved params again. Live changes made in the editor are not saved, so they go too.
    fn reset(&self, scene: &mut [Instance]) {
        for at in 0..scene.len() {
            if scene[at].parent.is_none() && scene[at].state.active && !scene[at].saved.active {
                self.switch(scene, at, false);
            }
        }
        for at in 0..scene.len() {
            // A layer a sequence shows has the step's params until the sequence lets it go.
            if scene[at].state.shown_by.is_some() {
                continue;
            }
            let mut params = self.catalog()[scene[at].def].defaults();
            params.extend(scene[at].saved.params.clone());
            if scene[at].state.params != params {
                scene[at].state.params = params;
                self.emit_layer(&scene[at].id, &scene[at].state);
            }
        }
        for at in 0..scene.len() {
            if scene[at].parent.is_none() && !scene[at].state.active && scene[at].saved.active {
                self.switch(scene, at, true);
            }
        }
    }

    /// A layer whose package is a sequence (the slideshow) and that has steps to show.
    fn is_sequence(&self, instance: &Instance) -> bool {
        self.catalog()[instance.def].manifest["sequence"] == true && instance.saved.steps.as_ref().is_some_and(|s| !s.sequence.is_empty())
    }

    /// Shows step `to` of the sequence at `at`: the step's layer comes on with the step's
    /// params, and the layer the sequence showed before goes off.
    fn show_step(&self, scene: &mut [Instance], at: usize, to: usize, now: Instant) {
        let id = scene[at].id.clone();
        let steps = scene[at].saved.steps.clone().unwrap_or_default();
        let Some(step) = steps.sequence.get(to) else { return };
        if let Some(old) = shown(scene, &id) {
            self.release(scene, old, true);
        }
        let playing = match &scene[at].state.step {
            Some(state) => state.playing,
            None => steps.mode == Some(StepMode::Timed),
        };
        scene[at].state.step = Some(StepState {
            index: to,
            count: steps.sequence.len(),
            sub: None,
            playing,
            title: step.title.clone(),
            description: step.description.clone(),
            source: step.source.clone(),
            titles: Vec::new(),
            due: None,
        });
        self.plan(scene, at, now);
        self.emit_layer(&id, &scene[at].state);
        if let Some(n) = scene.iter().position(|i| i.id == step.layer) {
            let mut params = self.catalog()[scene[n].def].defaults();
            params.extend(scene[n].saved.params.clone());
            params.extend(step.params.clone());
            scene[n].state.params = params;
            scene[n].state.shown_by = Some(id);
            scene[n].state.step = None;
            self.switch(scene, n, true);
        }
    }

    /// Takes a layer back from the sequence that showed it: its own params again, and off
    /// with `off`.
    fn release(&self, scene: &mut [Instance], n: usize, off: bool) {
        let mut params = self.catalog()[scene[n].def].defaults();
        params.extend(scene[n].saved.params.clone());
        scene[n].state.params = params;
        scene[n].state.shown_by = None;
        scene[n].state.step = None;
        if off {
            self.switch(scene, n, false);
        } else {
            self.emit_layer(&scene[n].id, &scene[n].state);
        }
    }

    /// Moves a layer's steps. A sequence walks the shown layer's sub-steps first, then moves
    /// to its next step unless the step says to stop. Any other layer walks its sub-steps.
    fn advance(&self, scene: &mut [Instance], at: usize, to: StepTo, now: Instant) -> Result<(), String> {
        let id = scene[at].id.clone();
        let Some(state) = scene[at].state.step.clone() else {
            return Err(format!("'{id}' has no steps"));
        };
        let looping = scene[at].saved.steps.as_ref().and_then(|s| s.r#loop).unwrap_or(true);
        if self.is_sequence(&scene[at]) {
            let steps = scene[at].saved.steps.clone().unwrap_or_default();
            let shown = shown(scene, &id);
            let sub = shown.and_then(|n| scene[n].state.step.as_ref().map(|s| (n, s.index, s.count)));
            let reveal = steps.sequence.get(state.index).and_then(|s| s.next).or(steps.reveal).unwrap_or(Reveal::ThenNext);
            let target = match to {
                StepTo::Next | StepTo::Auto => match sub {
                    Some((n, index, count)) if index < count => {
                        self.set_sub(scene, n, index + 1, now);
                        None
                    }
                    Some((_, _, count)) if count > 0 && reveal == Reveal::Stop && to == StepTo::Next => None,
                    _ => Some(state.index + 1),
                },
                StepTo::Skip => Some(state.index + 1),
                StepTo::Previous => Some(if state.index == 0 {
                    if looping {
                        state.count - 1
                    } else {
                        0
                    }
                } else {
                    state.index - 1
                }),
                StepTo::First => Some(0),
                StepTo::All => {
                    if let Some((n, _, count)) = sub {
                        self.set_sub(scene, n, count, now);
                    }
                    None
                }
                StepTo::At(n) if n >= state.count => return Err(format!("'{id}' has {} steps", state.count)),
                StepTo::At(n) => Some(n),
            };
            match target {
                Some(n) if n >= state.count && !looping => {
                    // The end: a playing sequence stops there.
                    if let Some(step) = scene[at].state.step.as_mut() {
                        step.playing = false;
                        step.due = None;
                    }
                    self.emit_layer(&id, &scene[at].state);
                }
                Some(n) => self.show_step(scene, at, n % state.count.max(1), now),
                None => {}
            }
            return Ok(());
        }
        let index = match to {
            StepTo::Next | StepTo::Auto | StepTo::Skip if state.index < state.count => state.index + 1,
            StepTo::Next | StepTo::Skip if looping => 0,
            StepTo::Next | StepTo::Auto | StepTo::Skip => {
                if let Some(step) = scene[at].state.step.as_mut() {
                    step.playing = false;
                }
                state.index
            }
            StepTo::Previous => state.index.saturating_sub(1),
            StepTo::First => 0,
            StepTo::All => state.count,
            StepTo::At(n) => n.min(state.count),
        };
        self.set_sub(scene, at, index, now);
        Ok(())
    }

    /// Reveals the first `index` sub-steps of a layer, and tells the sequence showing it.
    fn set_sub(&self, scene: &mut [Instance], n: usize, index: usize, now: Instant) {
        if let Some(step) = scene[n].state.step.as_mut() {
            step.index = index;
        }
        self.plan(scene, n, now);
        self.emit_layer(&scene[n].id, &scene[n].state);
        self.mirror(scene, n, now);
    }

    /// Copies a shown layer's sub-steps into the sequence showing it, for the controller.
    fn mirror(&self, scene: &mut [Instance], n: usize, now: Instant) {
        let Some(by) = scene[n].state.shown_by.clone() else { return };
        let Some(at) = scene.iter().position(|i| i.id == by) else { return };
        let sub = scene[n].state.step.as_ref().map(|s| SubSteps { index: s.index, count: s.count });
        let titles = scene[n].state.step.as_ref().map(|s| s.titles.clone()).unwrap_or_default();
        if let Some(step) = scene[at].state.step.as_mut() {
            step.sub = sub;
            step.titles = titles;
        }
        self.plan(scene, at, now);
        self.emit_layer(&by, &scene[at].state);
    }

    /// Sets when a playing layer moves on: the next sub-step after a short pause, otherwise
    /// the next step after the step's duration.
    fn plan(&self, scene: &mut [Instance], at: usize, now: Instant) {
        let sequence = self.is_sequence(&scene[at]);
        let duration = scene[at]
            .state
            .step
            .as_ref()
            .and_then(|s| scene[at].saved.steps.as_ref()?.sequence.get(s.index)?.duration_s)
            .filter(|d| d.is_finite() && *d > 0.0)
            .unwrap_or(STEP_SECONDS);
        let Some(step) = scene[at].state.step.as_mut() else { return };
        let left = match (sequence, step.sub) {
            (true, Some(sub)) => sub.index < sub.count,
            (true, None) => false,
            (false, _) => step.index < step.count,
        };
        let seconds = if left { SUB_STEP_SECONDS } else { duration };
        // Sub-steps are played by the sequence showing the layer, not by the layer itself.
        let shown = scene[at].state.shown_by.is_some();
        step.due = (step.playing && !shown && (sequence || left)).then(|| now + Duration::from_secs_f64(seconds));
    }

    /// Moves on every playing layer whose time has come. The host calls it a few times a second.
    pub fn tick(&self) {
        self.tick_at(Instant::now());
    }

    fn tick_at(&self, now: Instant) {
        let mut inner = self.inner.lock().unwrap();
        let scene = &mut inner.scene;
        let due: Vec<String> = scene
            .iter()
            .filter(|i| i.state.active && i.state.step.as_ref().is_some_and(|s| s.playing && s.due.is_some_and(|d| d <= now)))
            .map(|i| i.id.clone())
            .collect();
        for id in due {
            if let Some(at) = scene.iter().position(|i| i.id == id) {
                if let Err(e) = self.advance(scene, at, StepTo::Auto, now) {
                    tracing::warn!("{id}: {e}");
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
        let def = &self.catalog()[scene[index].def];
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
                self.catalog()[shown.def].validate(&step.params, false).map_err(|e| format!("a step showing '{}': {e}", step.layer))?;
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

    /// A hub on a private copy of the sample site, for tests that edit the scene.
    fn scratch_hub(name: &str) -> Hub {
        fn copy(from: &std::path::Path, to: &std::path::Path) {
            std::fs::create_dir_all(to).unwrap();
            for entry in std::fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                let target = to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy(&entry.path(), &target);
                } else {
                    std::fs::copy(entry.path(), target).unwrap();
                }
            }
        }
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let dir = std::env::temp_dir().join(format!("mrs-hub-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        copy(&root.join("sites/sample"), &dir);
        let site = Site::load(&dir).unwrap();
        let catalog = crate::layers::load_catalog(&site, &root.join("packages/layers")).unwrap();
        Hub::new(&site, catalog, 4170, None, SessionOptions::default()).unwrap()
    }

    fn layer(hub: &Hub, id: &str) -> Value {
        hub.welcome(0)["state"]["layers"][id].clone()
    }

    #[test]
    fn reset_puts_the_table_back_the_way_it_starts() {
        let hub = scratch_hub("reset");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("layer.activate", json!({ "layer": "sunlight", "active": true })).unwrap();
        dev("layer.set", json!({ "layer": "sunlight", "params": { "hour": 9 } })).unwrap();
        dev("layer.activate", json!({ "layer": "trees", "active": false })).unwrap();
        hub.request(Role::Tv, 0, "layers.reset", &json!({})).unwrap();
        let sun = layer(&hub, "sunlight");
        assert_eq!((sun["active"].clone(), sun["params"]["hour"].clone()), (json!(false), json!(15)));
        assert_eq!(layer(&hub, "trees")["active"], true, "the map at rest comes back");
        assert!(hub.request(Role::Phone, 0, "layers.reset", &json!({})).is_err(), "not from a phone");
    }

    #[test]
    fn a_layer_on_at_start_without_a_button_is_part_of_the_map_at_rest() {
        let hub = scratch_hub("rest");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        // The sample's wind starts off: it is a button layer.
        assert_eq!(layer(&hub, "wind")["rest"], Value::Null);
        dev("scene.add", json!({ "use": "wind", "id": "breeze", "active": true })).unwrap();
        assert_eq!(layer(&hub, "breeze")["rest"], true, "on at start and no button: the map at rest (#204)");
        dev("scene.set", json!({ "layer": "breeze", "button": { "name": "Breeze" } })).unwrap();
        assert_eq!(layer(&hub, "breeze")["rest"], Value::Null, "a button makes it a layer of the controller");
        dev("scene.set", json!({ "layer": "breeze", "button": { "name": null }, "active": false })).unwrap();
        assert_eq!(layer(&hub, "breeze")["rest"], Value::Null, "off at start: still a layer to open");
        // An item comes on with its layer, never at rest.
        dev("scene.add", json!({ "use": "trees", "parent": "slideshow", "id": "slide-trees" })).unwrap();
        assert_eq!(layer(&hub, "slide-trees")["rest"], Value::Null);
    }

    #[test]
    fn a_sequence_shows_its_steps_and_next_walks_sub_steps_first() {
        let hub = scratch_hub("steps");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("layer.activate", json!({ "layer": "trees", "active": false })).unwrap();
        dev("scene.add", json!({ "use": "trees", "parent": "slideshow", "id": "slide-trees" })).unwrap();
        let steps = json!({ "mode": "manual", "loop": false, "sequence": [
            { "layer": "sunlight", "params": { "hour": 9 }, "title": "Morning" },
            { "layer": "slide-trees", "params": { "size": 2 } },
            { "layer": "trees", "next": "stop" }
        ] });
        dev("scene.set", json!({ "layer": "slideshow", "steps": steps })).unwrap();
        assert_eq!(layer(&hub, "slide-trees")["active"], false, "a sequence's item waits for its step");

        // Opening the slideshow shows the first step at once, with that step's params.
        dev("layer.activate", json!({ "layer": "slideshow", "active": true })).unwrap();
        let show = layer(&hub, "slideshow");
        assert_eq!(show["step"], json!({ "index": 0, "count": 3, "playing": false, "title": "Morning" }));
        let sun = layer(&hub, "sunlight");
        assert_eq!(
            (sun["active"].clone(), sun["params"]["hour"].clone(), sun["shown_by"].clone()),
            (json!(true), json!(9.0), json!("slideshow"))
        );

        // Next: the sun study goes off with its own params back, the slideshow's own trees come on.
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        let sun = layer(&hub, "sunlight");
        assert_eq!((sun["active"].clone(), sun["params"]["hour"].clone(), sun["shown_by"].clone()), (json!(false), json!(15), Value::Null));
        assert_eq!(layer(&hub, "slide-trees")["active"], true);
        assert_eq!(layer(&hub, "slide-trees")["params"]["size"], 2.0);

        // A step's layer reports sub-steps: Next reveals them one by one, then moves on.
        assert!(dev("layer.substeps", json!({ "layer": "slide-trees", "count": 2 })).is_ok());
        assert!(
            hub.request(Role::Phone, 0, "layer.substeps", &json!({ "layer": "slide-trees", "count": 2 })).is_err(),
            "only the table reports"
        );
        assert_eq!(layer(&hub, "slideshow")["step"]["sub"], json!({ "index": 0, "count": 2 }));
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "slide-trees")["step"]["index"], 1);
        // A second view of the table starting the layer reports the same sub-steps: the reveal stays.
        dev("layer.substeps", json!({ "layer": "slide-trees", "count": 2 })).unwrap();
        assert_eq!(layer(&hub, "slide-trees")["step"]["index"], 1);
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["sub"], json!({ "index": 2, "count": 2 }));
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 2);
        assert_eq!(layer(&hub, "slide-trees")["active"], false);

        // The last step says stop: once its sub-steps are revealed, Next stays; skip moves on.
        dev("layer.substeps", json!({ "layer": "trees", "count": 1, "titles": ["Oaks"] })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["titles"], json!(["Oaks"]));
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 2, "stop holds the step");
        // Without loop, skipping past the end stays on the last step.
        dev("layer.step", json!({ "layer": "slideshow", "to": "skip" })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 2);
        dev("layer.step", json!({ "layer": "slideshow", "to": "first" })).unwrap();
        assert_eq!(layer(&hub, "sunlight")["active"], true);
        assert_eq!(layer(&hub, "trees")["active"], false);
        assert!(dev("layer.step", json!({ "layer": "slideshow", "to": 7 })).is_err());

        // Opening a shown layer from its own button leaves the slideshow: closing the slideshow keeps it.
        dev("layer.activate", json!({ "layer": "sunlight", "active": true })).unwrap();
        assert_eq!(layer(&hub, "sunlight")["shown_by"], Value::Null);
        assert_eq!(layer(&hub, "sunlight")["params"]["hour"], 15);
        dev("layer.activate", json!({ "layer": "slideshow", "active": false })).unwrap();
        assert_eq!(layer(&hub, "sunlight")["active"], true);
        assert_eq!(layer(&hub, "slideshow")["step"], Value::Null);
        assert!(dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).is_err(), "closed");
    }

    #[test]
    fn the_home_screen_timings_are_table_settings() {
        let hub = scratch_hub("home-timings");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let tv = dev("site.tv", json!({ "tv": { "idle_reset_s": 60, "attract_s": 6 } })).unwrap();
        assert_eq!((tv["tv"]["idle_reset_s"].clone(), tv["tv"]["attract_s"].clone()), (json!(60), json!(6)));
        assert!(dev("site.tv", json!({ "tv": { "idle_reset_s": 0 } })).is_ok(), "0 is never");
        assert!(dev("site.tv", json!({ "tv": { "idle_reset_s": -1 } })).is_err());
        assert!(dev("site.tv", json!({ "tv": { "attract_s": 1 } })).is_err(), "too quick to read");
    }

    #[test]
    fn a_timed_sequence_moves_on_by_itself() {
        let hub = scratch_hub("timed");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let steps = json!({ "mode": "timed", "sequence": [
            { "layer": "sunlight", "duration_s": 5 },
            { "layer": "wind" }
        ] });
        dev("scene.set", json!({ "layer": "slideshow", "steps": steps })).unwrap();
        dev("layer.activate", json!({ "layer": "slideshow", "active": true })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["playing"], true);
        let t0 = Instant::now();
        hub.tick_at(t0 + Duration::from_secs(4));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 0);
        hub.tick_at(t0 + Duration::from_secs(6));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 1);
        assert_eq!(layer(&hub, "wind")["active"], true);
        // The default step is eight seconds, and the sequence loops by default.
        hub.tick_at(t0 + Duration::from_secs(13));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 1);
        hub.tick_at(t0 + Duration::from_secs(15));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 0);
        // Paused, it stays.
        dev("layer.play", json!({ "layer": "slideshow", "playing": false })).unwrap();
        hub.tick_at(t0 + Duration::from_secs(60));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 0);
    }

    #[test]
    fn a_layer_of_its_own_walks_its_sub_steps() {
        let hub = scratch_hub("substeps");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        assert!(dev("layer.step", json!({ "layer": "trees", "to": "next" })).is_err(), "no sub-steps reported");
        dev("layer.substeps", json!({ "layer": "trees", "count": 3 })).unwrap();
        dev("layer.step", json!({ "layer": "trees", "to": "next" })).unwrap();
        dev("layer.step", json!({ "layer": "trees", "to": "all" })).unwrap();
        assert_eq!(layer(&hub, "trees")["step"]["index"], 3);
        dev("layer.step", json!({ "layer": "trees", "to": "previous" })).unwrap();
        assert_eq!(layer(&hub, "trees")["step"]["index"], 2);
        dev("layer.activate", json!({ "layer": "trees", "active": false })).unwrap();
        assert_eq!(layer(&hub, "trees")["step"], Value::Null, "reported again when it opens");
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
    #[test]
    fn a_custom_layer_is_saved_offered_added_and_restyled_live() {
        let hub = scratch_hub("custom");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let mut events = hub.subscribe();
        let recipe = |colour: &str| {
            json!({ "name": "Heat walk", "icon": "route",
            "data": [ { "id": "paths", "dataset": "buildings" } ],
            "look": [ { "id": "lines", "block": "lines", "data": "paths", "props": { "color": colour, "width_mm": 2 } } ],
            "controls": [ { "id": "width", "type": "range", "label": "Width", "min": 1, "max": 8, "step": 1, "default": 3, "bind": "look.lines.width_mm" } ] })
        };
        assert_eq!(dev("custom.save", json!({ "id": "heat-walk", "recipe": recipe("@warm") })).unwrap()["use"], "custom:heat-walk");
        let event: Value = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
        assert_eq!(event["m"], "catalog.changed");
        assert_eq!(event["p"]["manifest"]["custom"]["look"][0]["props"]["color"], "@warm");
        assert!(hub.welcome(0)["manifests"].as_array().unwrap().iter().any(|m| m["id"] == "heat-walk"), "offered to new surfaces");

        let added = dev("scene.add", json!({ "use": "custom:heat-walk" })).unwrap();
        assert_eq!(added["id"], "heat-walk");
        dev("scene.set", json!({ "layer": "heat-walk", "params": { "width": 6 } })).unwrap();
        // Restyling keeps the instance and the params its controls still take.
        dev("custom.save", json!({ "id": "heat-walk", "recipe": recipe("#ff8800") })).unwrap();
        assert_eq!(layer(&hub, "heat-walk")["params"]["width"], 6.0);
        let saved = Site::load(&hub.site.dir).unwrap();
        assert_eq!(saved.manifest.custom["heat-walk"].look[0].props["color"], "#ff8800");

        assert!(dev("custom.remove", json!({ "id": "heat-walk" })).unwrap_err().contains("uses it"));
        dev("scene.remove", json!({ "layer": "heat-walk" })).unwrap();
        dev("custom.remove", json!({ "id": "heat-walk" })).unwrap();
        assert!(Site::load(&hub.site.dir).unwrap().manifest.custom.is_empty());
        assert!(dev("custom.save", json!({ "id": "sunlight", "recipe": recipe("#ffffff") })).unwrap_err().contains("core layer"));
        assert!(dev("custom.save", json!({ "id": "bad", "recipe": { "name": "Bad", "data": [ { "id": "x", "dataset": "nothing" } ] } }))
            .is_err());
        assert!(hub.request(Role::Phone, 0, "custom.save", &json!({ "id": "x", "recipe": recipe("#fff000") })).is_err());
    }

    #[test]
    fn the_palette_is_saved_and_sent() {
        let hub = scratch_hub("palette");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("palette.set", json!({ "palette": { "set": "night", "slots": { "accent": "#ff8800" } } })).unwrap();
        assert_eq!(hub.site().palette.unwrap().slots["accent"], "#ff8800");
        assert_eq!(Site::load(&hub.site.dir).unwrap().manifest.palette.unwrap().set.as_deref(), Some("night"));
        assert!(dev("palette.set", json!({ "palette": { "slots": { "accent": "orange" } } })).is_err());
        dev("palette.set", json!({ "palette": null })).unwrap();
        assert!(Site::load(&hub.site.dir).unwrap().manifest.palette.is_none());
    }

    #[test]
    fn display_quality_is_saved_and_checked() {
        let hub = scratch_hub("display");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("site.display", json!({ "display": { "quality": "best" } })).unwrap();
        assert_eq!(hub.site().display.unwrap()["quality"], "best");
        assert_eq!(Site::load(&hub.site.dir).unwrap().manifest.display.unwrap()["quality"], "best");
        assert!(dev("site.display", json!({ "display": { "quality": "ultra" } })).is_err());
        assert!(dev("site.display", json!({ "display": { "fps": 60 } })).is_err());
        assert!(hub.request(Role::Phone, 0, "site.display", &json!({ "display": { "quality": "draft" } })).is_err());
        dev("site.display", json!({ "display": { "quality": null } })).unwrap();
        assert!(Site::load(&hub.site.dir).unwrap().manifest.display.is_none());
    }
}
