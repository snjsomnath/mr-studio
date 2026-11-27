//! Session state. The hub is the only authority over it: surfaces send requests,
//! the hub validates, updates and broadcasts.
//!
//! The scene is the ordered list of layer instances, bottom first. It starts as the
//! `layers` list of `site.json`, each layer followed by its items, and the `scene.*`
//! requests edit both together.

use parking_lot::{Mutex, RwLock};
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mrs_site::history::{By, Change, History, Revision};
use mrs_site::{is_instance_id, LayerButton, LayerItem, LayerRef, Reveal, Site, SiteError, SiteInfo, StepMode, Steps};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, Notify};

use crate::layers::{LayerDef, ToolKind};

mod custom;
mod load;
mod recording;
mod requests;
mod scene;
mod seats;
mod settings;
mod steps;
#[cfg(test)]
mod test_support;
mod tools;

use scene::*;
use seats::*;
use settings::*;
use tools::*;

pub use recording::{default_recordings_dir, list_recordings, replay, Catalogue, Chapter, RecordingInfo, MAX_RECORDING, RECORDING_FORMAT};

pub const PROTOCOL: u32 = 1;
pub const MAX_PHONES: usize = 8;
/// More layers than this in one scene is a mistake, not a design.
pub const MAX_SCENE_LAYERS: usize = 64;
const SLOT_COLOURS: [&str; 8] = ["#ff6b6b", "#4dabf7", "#51cf66", "#fcc419", "#cc5de8", "#ff922b", "#20c997", "#f06595"];
/// The animals a phone can be (#339). Each phone gets one nobody else has, and may pick another.
pub const AVATARS: [&str; 12] =
    ["fox", "octopus", "owl", "frog", "turtle", "penguin", "butterfly", "unicorn", "otter", "hedgehog", "whale", "bee"];
/// The first half of a phone's fun name, "Sunny Fox" (#339). The pages say it in the visitor's language.
pub const MOODS: [&str; 8] = ["curious", "cosmic", "sunny", "merry", "brave", "gentle", "lucky", "swift"];
/// The longest name a visitor may give their phone, in characters.
const NAME_CHARS: usize = 32;
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
    /// The join page phones open when they cannot reach this computer (#275), such as
    /// `https://snjsomnath.github.io/mr-studio/`. A surface of the studio links it to the host
    /// over WebRTC; while it is linked the QR code points there. None turns it off.
    pub join_page: Option<String>,
    /// PeerJS options for the WebRTC link (signalling server, `config.iceServers` for a TURN
    /// server), handed to the table's bridge and, through the QR link, to the join page.
    pub peer_options: Option<serde_json::Value>,
    /// Where recorded sessions are kept (#520). None is the desktop app's data folder.
    pub recordings_dir: Option<std::path::PathBuf>,
}

/// Where phones join over the internet when nothing else is set (#275).
pub const DEFAULT_JOIN_PAGE: &str = "https://snjsomnath.github.io/mr-studio/v1/";

impl SessionOptions {
    /// The join page and PeerJS options from the environment: `MRS_JOIN_PAGE` (an address, or
    /// `off`) and `MRS_PEER_OPTIONS` (JSON). Without them, the default page.
    pub fn join_page_from_env() -> (Option<String>, Option<serde_json::Value>) {
        let page = match std::env::var("MRS_JOIN_PAGE") {
            Ok(v) if v.trim().eq_ignore_ascii_case("off") || v.trim().is_empty() => None,
            Ok(v) => Some(v.trim().to_string()),
            Err(_) => Some(DEFAULT_JOIN_PAGE.to_string()),
        };
        let options = std::env::var("MRS_PEER_OPTIONS").ok().and_then(|v| serde_json::from_str(&v).ok());
        (page, options)
    }
}

impl Default for SessionOptions {
    fn default() -> Self {
        let (join_page, peer_options) = Self::join_page_from_env();
        Self {
            max_phones: MAX_PHONES,
            resume_hold: Duration::from_secs(60),
            phone_requests_per_second: 20,
            public_url: None,
            join_page,
            peer_options,
            recordings_dir: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Table,
    Tv,
    Phone,
    Dev,
    /// The guide's phone (#98): drives a tour with Next and Previous and reads its notes.
    /// It joins with its own code and takes no visitor's seat.
    Guide,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "table" => Some(Self::Table),
            "tv" => Some(Self::Tv),
            "phone" => Some(Self::Phone),
            "dev" => Some(Self::Dev),
            "guide" => Some(Self::Guide),
            _ => None,
        }
    }

    /// The role's name, as a surface says it in its hello.
    pub fn name(self) -> &'static str {
        match self {
            Self::Table => "table",
            Self::Tv => "tv",
            Self::Phone => "phone",
            Self::Dev => "dev",
            Self::Guide => "guide",
        }
    }

    fn may_activate(self) -> bool {
        self != Self::Phone
    }

    fn may_publish(self) -> bool {
        matches!(self, Self::Table | Self::Dev)
    }

    /// Editing the scene rewrites site.json, so it is kept to the operator's surfaces.
    pub(crate) fn may_compose(self) -> bool {
        matches!(self, Self::Tv | Self::Dev)
    }

    pub fn may_use_engine(self) -> bool {
        matches!(self, Self::Table | Self::Tv | Self::Dev)
    }

    pub fn may_calibrate(self) -> bool {
        matches!(self, Self::Table | Self::Tv | Self::Dev)
    }

    /// Phones and the guide's phone come from the network: they never see the table's sources, keys or history.
    pub fn from_a_phone(self) -> bool {
        matches!(self, Self::Phone | Self::Guide)
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
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
    /// For an item of a revealing layer (#606): 1 the surface stack, 2 (or none) the stack underneath.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<u8>,
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
    /// The entity picked on the table or the controller (#279): `{ set, id }`. Cleared when the layer goes off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<Value>,
    /// Trouble the table reported while the layer is on (#259): it could not start or lost its
    /// data, and is trying again. Absent while it runs as it should. Cleared when it goes off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<LayerHealth>,
    /// The layer's play head (#373), kept here so every view reads the same time. Absent until
    /// the table sets one; cleared when the layer goes off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock: Option<LayerClock>,
}

/// Where a layer's time is (#373): `value`, in the units of its `clock` time control, at the
/// host's moment `at` (milliseconds since 1970), moving `rate` units a second (0 when it stands
/// still). A view works out the time now from these, so the table sends a new one only when play
/// starts, stops, jumps or changes pace.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, JsonSchema)]
pub struct LayerClock {
    pub value: f64,
    pub rate: f64,
    pub at: f64,
}

/// The JSON Schema of the state a view is welcomed with (#538): `state` of the `welcome` message,
/// with the session, the site, each layer and each phone, as the host writes them. Checked in as
/// `docs/contracts/protocol.schema.json`; the SDK's tests compare `SessionState` in
/// `packages/sdk/src/types.ts` with it, so a field renamed on one side alone fails a test.
pub fn protocol_schema() -> Value {
    let mut generator = schemars::generate::SchemaSettings::draft2020_12().for_serialize().into_generator();
    let session = generator.subschema_for::<SessionInfo>();
    let site = generator.subschema_for::<SiteInfo>();
    let layer = generator.subschema_for::<LayerState>();
    let participant = generator.subschema_for::<Participant>();
    let defs: Map<String, Value> = generator.take_definitions(true).into_iter().collect();
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://github.com/snjsomnath/mr-studio/blob/main/docs/contracts/protocol.schema.json",
        "title": "SessionState",
        "description": "The state a view is welcomed with (welcome.state), as the host writes it.",
        "type": "object",
        "properties": {
            "protocol": { "type": "integer", "const": PROTOCOL },
            "session": session,
            "site": site,
            "scene": { "type": "array", "items": { "type": "string" } },
            "layers": { "type": "object", "additionalProperties": layer },
            "participants": { "type": "array", "items": participant },
        },
        "required": ["protocol", "session", "site", "scene", "layers", "participants"],
        "$defs": defs,
    })
}

/// The fastest a play head runs, in its control's units a second.
const MAX_CLOCK_RATE: f64 = 10_000.0;

/// The host's time now, in milliseconds since 1970: what a play head's `at` counts in.
pub fn host_millis() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// A layer that is on but not running as it should (#259), as the table reported it.
#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
pub struct LayerHealth {
    /// `retrying`: it failed and starts again by itself in `retry_in` seconds. `failed`: it
    /// failed and waits for Retry.
    pub status: String,
    /// What went wrong, in words.
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_in: Option<f64>,
}

/// The longest reason a layer's trouble keeps.
const MAX_HEALTH_REASON: usize = 300;

/// Where Next is in a layer (`docs/contracts/present.md`, Steps). For a sequence, `index`
/// and `count` count its steps and `sub` is the shown layer's sub-steps. For any other
/// layer they count its sub-steps: `index` is how many are revealed, 0 to `count`.
#[derive(Debug, Clone, Serialize, JsonSchema)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
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

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct Participant {
    /// The surface currently in the slot. It changes when the phone reconnects; the slot does not.
    pub surface: u64,
    pub slot: usize,
    pub colour: &'static str,
    /// False while the slot is held for a phone that dropped.
    pub connected: bool,
    /// One of `AVATARS` (#339).
    pub avatar: &'static str,
    /// One of `MOODS`: with the avatar, the fun name the pages show ("Sunny Fox").
    pub mood: &'static str,
    /// The name the visitor gave themselves, instead of the fun name.
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SessionInfo {
    pub id: String,
    pub code: String,
    pub port: u16,
    /// What the TV's QR code points at. None when phones cannot reach the host.
    pub join_url: Option<String>,
    /// The language the visitors' screens speak now (#80): `en` or `sv`. The controller
    /// switches it; a phone may keep its own.
    pub language: String,
    /// Whether the table's layers may be heard (#282). The controller's sound switch turns it
    /// off for the session; a new session starts with sound on.
    pub sound: bool,
    /// The layer whose ribbon the table shows, chosen on the controller when more than one
    /// open layer has ribbon panels (#231). None is Auto: the layer turned on last.
    pub ribbon: Option<String>,
    /// Whether the table and the controller show their frame meter (#262): frames per second,
    /// the worst frame, and what each layer costs. Off when a session starts.
    pub performance: bool,
    /// Whether the operator paused the phones (#335): they can look but not change the table.
    pub phones_paused: bool,
    /// How many views draw the table and run its layers now (#412). With none, no layer
    /// publishes its live values and the controller says so.
    pub tables: usize,
    /// The recording running now (#522): the controller shows a red dot and its time.
    pub recording: Option<RecordingInfo>,
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
    /// For an item of a revealing layer (#606): the stack it is in, as site.json has it.
    stack: Option<u8>,
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

    /// Puts an item in a stack (#606), for the state and for site.json alike.
    fn set_stack(&mut self, stack: Option<u8>) {
        self.stack = stack;
        self.state.stack = stack;
    }

    fn item(&self) -> LayerItem {
        let s = &self.saved;
        LayerItem {
            r#use: s.r#use.clone(),
            id: s.id.clone(),
            active: s.active,
            params: s.params.clone(),
            hide: s.hide.clone(),
            stack: self.stack,
        }
    }
}

/// A phone that only watches (#462): no seat, but a request allowance like a seated one.
struct Watcher {
    surface: u64,
    allowance: f64,
    refilled: Instant,
}

struct Inner {
    /// Bottom first.
    scene: Vec<Instance>,
    seats: Vec<Seat>,
    /// Phones that joined when every seat was taken (#462): they look, change nothing, and
    /// join again for a seat when one frees up.
    watching: Vec<Watcher>,
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

/// A save to site.json left for after the request (#536).
struct Later {
    turn: u64,
    who: Who,
    summary: String,
    write: Box<dyn FnOnce() -> Result<(), SiteError> + Send>,
}

thread_local! {
    /// The saves of the request being handled on this thread. A request is handled on one
    /// thread from start to end, so they are its own.
    static LATER: std::cell::RefCell<Vec<Later>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Turns for saving site.json (#536). A turn is taken while the change is made, under the
/// hub's lock, so turns follow the order of the changes; the writes then wait for their turn.
#[derive(Default)]
struct SaveTurns {
    /// (next turn to give out, turns finished)
    state: Mutex<(u64, u64)>,
    finished: parking_lot::Condvar,
}

impl SaveTurns {
    fn take(&self) -> u64 {
        let mut state = self.state.lock();
        state.0 += 1;
        state.0 - 1
    }

    fn wait(&self, turn: u64) {
        let mut state = self.state.lock();
        while state.1 < turn {
            self.finished.wait(&mut state);
        }
    }

    fn done(&self, turn: u64) {
        let mut state = self.state.lock();
        debug_assert_eq!(state.1, turn, "saves finish in turn");
        state.1 = turn + 1;
        self.finished.notify_all();
    }
}

pub struct Hub {
    site: Site,
    /// Replaced when data is imported into the site.
    info: RwLock<SiteInfo>,
    session: SessionInfo,
    /// The address phones join at through the relay (#89), while the host is connected to one.
    /// It replaces the local network address in the QR code.
    relay_join: RwLock<Option<String>>,
    /// The join page phones open while a studio surface links it over WebRTC (#275):
    /// `https://…/mr-studio/?t=<peer>#`. Used when there is no relay.
    bridge_join: RwLock<Option<String>>,
    /// The visitors' language now (#80), one of the site's `branding.languages`.
    language: RwLock<String>,
    /// The controller's sound switch (#282): false mutes every layer for the session.
    sound: RwLock<bool>,
    /// The frame meter on the table and controller (#262).
    performance: RwLock<bool>,
    /// The operator paused the phones (#335): they look, but change nothing until resumed.
    phones_paused: RwLock<bool>,
    /// What the phones did this session (#335), newest last, for the operator's session log.
    phone_log: Mutex<std::collections::VecDeque<Value>>,
    /// Phones the operator let go (#335): their connection is told why when it closes.
    released: Mutex<Vec<u64>>,
    /// The surfaces that draw the table and run its layers (table and dev views, #412).
    drawing: Mutex<Vec<u64>>,
    /// The controller's ribbon choice (#231); None is Auto.
    ribbon: RwLock<Option<String>>,
    /// The code the guide's phone joins with (#98). Only the operator's screens are told it.
    guide_code: String,
    options: SessionOptions,
    /// Every layer that can be added to a scene. Replaced whole when a custom layer is
    /// saved or removed; instances keep their index into it, which removal recomputes.
    catalog: RwLock<Arc<Vec<LayerDef>>>,
    inner: Mutex<Inner>,
    events: broadcast::Sender<String>,
    /// Every version of site.json (#72). Held around each write so a change and its revision land as one.
    history: Arc<Mutex<History>>,
    /// The revision the request being handled wrote, announced when it is done.
    recorded: Mutex<Vec<Revision>>,
    /// Saves to site.json take turns in the order their changes were made (#536).
    saves: SaveTurns,
    /// For tests (#536): every write to site.json takes this much longer, as on a slow disk.
    slow_saves: std::sync::atomic::AtomicU64,
    /// Set by `inject_fault`: the next request fails inside the host.
    fault: std::sync::atomic::AtomicBool,
    /// When a person last did something on any surface (#604), for the idle reset.
    last_input: Mutex<Instant>,
    /// The controller screens connected now (#604): the idle reset runs only while there is one.
    controllers: Mutex<Vec<u64>>,
    /// The session being recorded (#521). Taken after `inner` when both are needed.
    recording: Mutex<Option<recording::Recording>>,
}

/// The controller goes home after this many seconds with nobody at the table (#74), unless `tv.idle_reset_s` says otherwise.
const DEFAULT_IDLE_RESET_S: f64 = 180.0;

/// Whether a request is a person doing something (#604), which holds off the idle reset. A
/// table's layers send requests of their own, so from the table only a touch counts.
fn is_input(role: Role, method: &str) -> bool {
    if role == Role::Table {
        return method == "session.input";
    }
    method.starts_with("scene.")
        || matches!(
            method,
            "session.input"
                | "layer.activate"
                | "layer.set"
                | "layer.action"
                | "layer.step"
                | "layer.select"
                | "layer.entity"
                | "tool.input"
                | "layers.reset"
                | "session.ribbon"
                | "session.language"
                | "session.sound"
        )
}

/// How the answer to a request that failed inside the host starts (#507); the operator log hears of it.
pub const FAULT: &str = "Something went wrong inside MR Studio:";

/// Who sent a request that changes site.json, for the history.
#[derive(Debug, Clone, Copy)]
struct Who {
    by: By,
    surface: Option<u64>,
}

impl Who {
    fn of(role: Role, surface: u64) -> Self {
        let by = if matches!(role, Role::Tv | Role::Guide) { By::Controller } else { By::Editor };
        Self { by, surface: Some(surface) }
    }
}

fn random_u64() -> u64 {
    std::collections::hash_map::RandomState::new().build_hasher().finish()
}

impl Hub {
    /// `join_base` is the address phones reach the host at, without a path.
    pub fn new(site: &Site, catalog: Vec<LayerDef>, port: u16, join_base: Option<String>, options: SessionOptions) -> anyhow::Result<Self> {
        let scene = Self::build_scene(&catalog, &site.manifest.layers)?;
        let code = format!("{:04}", random_u64() % 10_000);
        let join_url = join_base.map(|base| format!("{}/phone?c={code}", base.trim_end_matches('/')));
        let language = offered(&site.manifest.branding)[0].clone();
        let session = SessionInfo {
            id: format!("{:016x}", random_u64()),
            code,
            port,
            join_url,
            language: language.clone(),
            sound: true,
            ribbon: None,
            performance: false,
            phones_paused: false,
            tables: 0,
            recording: None,
        };
        // Six digits, never the phones' code.
        let guide_code = loop {
            let guide = format!("{:06}", random_u64() % 1_000_000);
            if !guide.ends_with(&session.code) {
                break guide;
            }
        };
        let (events, _) = broadcast::channel(256);
        let hub = Self {
            site: site.clone(),
            info: RwLock::new(site.info()),
            session,
            relay_join: RwLock::new(None),
            bridge_join: RwLock::new(None),
            language: RwLock::new(language),
            sound: RwLock::new(true),
            performance: RwLock::new(false),
            phones_paused: RwLock::new(false),
            phone_log: Mutex::new(std::collections::VecDeque::new()),
            released: Mutex::new(Vec::new()),
            drawing: Mutex::new(Vec::new()),
            ribbon: RwLock::new(None),
            guide_code,
            options,
            catalog: RwLock::new(Arc::new(catalog)),
            inner: Mutex::new(Inner { scene, seats: Vec::new(), watching: Vec::new(), next_surface: 1 }),
            events,
            history: Arc::new(Mutex::new(History::open(&site.dir))),
            recorded: Mutex::new(Vec::new()),
            fault: Default::default(),
            saves: SaveTurns::default(),
            slow_saves: Default::default(),
            last_input: Mutex::new(Instant::now()),
            controllers: Mutex::new(Vec::new()),
            recording: Mutex::new(None),
        };
        // A sequence that starts on shows its first step.
        {
            let mut inner = hub.inner.lock();
            for at in 0..inner.scene.len() {
                if inner.scene[at].state.active && hub.is_sequence(&inner.scene[at]) {
                    hub.switch(&mut inner.scene, at, true);
                }
            }
        }
        Ok(hub)
    }

    // ---- History (#72) ----------------------------------------------------------

    /// The site's revision history. Writers outside the hub (imports, moving the table, undo)
    /// hold it around their write, as `saving` does.
    pub fn history(&self) -> Arc<Mutex<History>> {
        self.history.clone()
    }

    /// Runs a write to site.json and records it in the history, as one step, now: for a
    /// change whose request needs what was written (#536). It waits for the saves before it,
    /// holding the hub's lock, as every save did before #536.
    fn saving(&self, who: Who, summary: impl Into<String>, write: impl FnOnce() -> Result<(), SiteError>) -> Result<(), String> {
        let turn = self.saves.take();
        self.saves.wait(turn);
        let written = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.write_now(who, summary.into(), write)));
        self.saves.done(turn);
        written.unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    }

    /// Saves top-level keys of site.json once the request is handled and the hub's lock is
    /// free (#536), so a slow disk never holds up another surface. The change is checked now,
    /// so a change site.json would refuse is still refused before the hub takes it. Saves keep
    /// the order their changes were made in, and the request is answered after its own save,
    /// so "saved" still means on disk.
    fn saving_later(&self, who: Who, summary: impl Into<String>, changes: Vec<(&'static str, Option<Value>)>) -> Result<(), String> {
        self.site.check_keys(&changes).map_err(|e| format!("could not save site.json: {e}"))?;
        let site = self.site.clone();
        let turn = self.saves.take();
        let write = move || site.save_keys(&changes);
        LATER.with(|later| later.borrow_mut().push(Later { turn, who, summary: summary.into(), write: Box::new(write) }));
        Ok(())
    }

    fn write_now(&self, who: Who, summary: String, write: impl FnOnce() -> Result<(), SiteError>) -> Result<(), String> {
        let slow = self.slow_saves.load(std::sync::atomic::Ordering::Relaxed);
        if slow > 0 {
            std::thread::sleep(std::time::Duration::from_millis(slow));
        }
        let change = {
            let mut history = self.history.lock();
            let ((), change) = history.write(who.by, summary, who.surface, write).map_err(|e| format!("could not save site.json: {e}"))?;
            change
        };
        if let Some(change) = change {
            self.recorded.lock().push(change.revision);
        }
        Ok(())
    }

    /// Writes the saves a request left for later, in turn. After a request failed inside the
    /// host, its saves are skipped, but their turns are still given up.
    fn write_later(&self, failed: bool) -> Result<(), String> {
        let later = LATER.with(|later| std::mem::take(&mut *later.borrow_mut()));
        let mut result = Ok(());
        for Later { turn, who, summary, write } in later {
            self.saves.wait(turn);
            if !failed && result.is_ok() {
                let written = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.write_now(who, summary, write)));
                result = written.unwrap_or_else(|_| Err(format!("{FAULT} site.json could not be saved.")));
            }
            self.saves.done(turn);
        }
        result
    }

    /// For tests (#536): makes every save to site.json take `ms` longer.
    pub fn slow_saves(&self, ms: u64) {
        self.slow_saves.store(ms, std::sync::atomic::Ordering::Relaxed);
    }

    /// Tells every surface the history moved on: a new revision, or an undo, redo or restore.
    /// An editor shows a notice when the change came from somewhere else.
    pub fn history_changed(&self, revision: &Revision, stepped: bool) {
        let (can_undo, can_redo, head) = {
            let history = self.history.lock();
            (history.can_undo(), history.can_redo(), history.head().clone())
        };
        self.emit(
            "history.changed",
            json!({ "revision": revision, "head": head.rev, "stepped": stepped, "can_undo": can_undo, "can_redo": can_redo }),
        );
    }

    /// `history.list`: the kept revisions, newest first, and where undo and redo go.
    pub fn history_list(&self) -> Value {
        let history = self.history.lock();
        let mut revisions = history.list();
        revisions.reverse();
        json!({
            "revisions": revisions,
            "head": history.head().rev,
            "can_undo": history.can_undo(),
            "can_redo": history.can_redo(),
        })
    }

    /// What the editor calls a layer: its button name, or its package's name.
    fn label(&self, instance: &Instance) -> String {
        instance
            .saved
            .button
            .name
            .clone()
            .unwrap_or_else(|| self.catalog()[instance.def].manifest["name"].as_str().map_or_else(|| instance.id.clone(), str::to_string))
    }

    fn label_of(&self, scene: &[Instance], id: &str) -> String {
        scene.iter().find(|i| i.id == id).map_or_else(|| id.to_string(), |i| self.label(i))
    }

    /// A control's label from layer.json, or its id.
    fn control_label(&self, instance: &Instance, control: &str) -> String {
        let manifest = &self.catalog()[instance.def].manifest;
        manifest["controls"]
            .as_array()
            .and_then(|c| c.iter().find(|c| c["id"] == control))
            .and_then(|c| c["label"].as_str())
            .map_or_else(|| control.to_string(), |l| l.to_lowercase())
    }

    /// The layer catalogue as it is now.
    fn catalog(&self) -> Arc<Vec<LayerDef>> {
        self.catalog.read().clone()
    }

    /// Phones join through the join page at `base` (`https://…/?t=<peer>#`), or not with None.
    /// A relay, when linked, still wins. Every surface gets `session.changed`.
    pub fn set_bridge(&self, base: Option<String>) {
        *self.bridge_join.write() = base;
        self.emit("session.changed", json!({ "session": self.session() }));
    }

    /// Phones join through the relay at `base` (`https://relay.example/r/<room>`), or again at
    /// the local address with None. Every surface gets `session.changed` and redraws the QR code.
    pub fn set_relay(&self, base: Option<String>) {
        *self.relay_join.write() = base;
        self.emit("session.changed", json!({ "session": self.session() }));
    }

    pub fn site(&self) -> SiteInfo {
        self.info.read().clone()
    }

    /// Every layer instance with whether it is on and how it is doing (#259), for diagnostics.
    pub fn layer_health(&self) -> Vec<Value> {
        let inner = self.inner.lock();
        inner
            .scene
            .iter()
            .map(|i| json!({ "id": i.id, "layer": i.state.layer, "active": i.state.active, "health": i.state.health }))
            .collect()
    }

    /// Takes the site as it is after its data changed, and tells every surface.
    pub fn site_changed(&self, info: SiteInfo) {
        *self.info.write() = info.clone();
        self.emit("site.changed", json!({ "site": info }));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }

    pub(crate) fn emit(&self, method: &str, payload: Value) {
        let _ = self.events.send(json!({ "t": "ev", "m": method, "p": payload }).to_string());
    }

    /// Handles a session request. Engine requests are handled by the connection.
    pub fn request(&self, role: Role, surface: u64, method: &str, p: &Value) -> Result<Value, String> {
        // A request that fails inside the host (#507) costs that request only: the surface is
        // told, the locks are free again (they do not poison), and the next request is handled.
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.handle(role, surface, method, p)));
        // The hub's lock is free again: now the request's own saves are written (#536).
        let saved = self.write_later(handled.is_err());
        let handled = handled.map(|result| result.and_then(|answer| saved.map(|()| answer)));
        let result = handled.unwrap_or_else(|panic| {
            let why =
                panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
            tracing::error!("the request '{method}' failed inside the host: {why}");
            Err(format!("{FAULT} '{method}' could not be handled. The table carries on."))
        });
        if result.is_ok() && is_input(role, method) {
            *self.last_input.lock() = Instant::now();
        }
        // A change to site.json is announced after what it did, so a surface already shows it.
        let recorded = std::mem::take(&mut *self.recorded.lock());
        for revision in recorded {
            self.history_changed(&revision, false);
        }
        result
    }

    /// Makes the next request fail inside the host, with the hub's lock held, as a mistake in
    /// its handling would. For tests and soak runs (#507), like the engine's `inject_fault`.
    pub fn inject_fault(&self) {
        self.fault.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// The layer package an instance of the scene runs, and its params.
    pub fn instance_params(&self, instance: &str) -> Option<(String, Map<String, Value>)> {
        let inner = self.inner.lock();
        inner.scene.iter().find(|i| i.id == instance).map(|i| (i.state.layer.clone(), i.state.params.clone()))
    }

    /// Whether the scene has an instance of this layer package (the field walk takes spots only then, #445).
    pub fn has_package(&self, package: &str) -> bool {
        self.inner.lock().scene.iter().any(|i| i.state.layer == package)
    }

    /// Writes a value into a state param of every instance of a layer package and tells the
    /// surfaces, so the layer's table and controller hear of a change made outside the layer:
    /// the field walk's spots (#445) bump `revision`.
    pub fn poke(&self, package: &str, key: &str, value: Value) {
        let mut inner = self.inner.lock();
        for instance in inner.scene.iter_mut().filter(|i| i.state.layer == package) {
            instance.state.params.insert(key.to_string(), value.clone());
            self.emit_layer(&instance.id, &instance.state);
        }
    }

    /// Called under the lock, so events are broadcast in the order changes were applied.
    fn emit_layer(&self, layer: &str, state: &LayerState) {
        self.emit("state.layer", json!({ "layer": layer, "state": state }));
    }
}
