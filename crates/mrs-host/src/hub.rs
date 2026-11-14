//! Session state. The hub is the only authority over it: surfaces send requests,
//! the hub validates, updates and broadcasts.

use std::collections::BTreeMap;
use std::sync::Mutex;

use mrs_site::{Site, SiteInfo};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::broadcast;

use crate::layers::LayerDef;

pub const PROTOCOL: u32 = 1;
pub const MAX_PHONES: usize = 8;
const SLOT_COLOURS: [&str; MAX_PHONES] = ["#ff6b6b", "#4dabf7", "#51cf66", "#fcc419", "#cc5de8", "#ff922b", "#20c997", "#f06595"];

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

    pub fn may_use_engine(self) -> bool {
        self != Self::Phone
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LayerState {
    pub active: bool,
    /// How strongly the layer is drawn on the table, 0 to 2. 1 is as the layer intends.
    pub intensity: f64,
    pub params: Map<String, Value>,
    pub shared: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Participant {
    pub surface: u64,
    pub slot: usize,
    pub colour: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub code: String,
    pub port: u16,
}

struct Inner {
    layers: BTreeMap<String, LayerState>,
    participants: Vec<Participant>,
    next_surface: u64,
}

pub struct Hub {
    site: SiteInfo,
    session: SessionInfo,
    defs: Vec<LayerDef>,
    inner: Mutex<Inner>,
    events: broadcast::Sender<String>,
}

impl Hub {
    pub fn new(site: &Site, defs: Vec<LayerDef>, port: u16) -> Self {
        let mut layers = BTreeMap::new();
        for def in &defs {
            let mut params = def.defaults();
            let reference = site.manifest.layers.iter().find(|l| l.r#use == def.id || l.r#use.ends_with(&format!("/{}", def.id)));
            let mut active = false;
            if let Some(reference) = reference {
                active = reference.active;
                match def.validate(&reference.params, false) {
                    Ok(overrides) => params.extend(overrides),
                    Err(e) => tracing::warn!("site.json params for layer '{}' ignored: {e}", def.id),
                }
            }
            layers.insert(def.id.clone(), LayerState { active, intensity: 1.0, params, shared: Map::new() });
        }
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let session = SessionInfo { id: format!("{:x}", nanos), code: format!("{:04}", (nanos / 7919) % 10_000), port };
        let (events, _) = broadcast::channel(256);
        Self { site: site.info(), session, defs, inner: Mutex::new(Inner { layers, participants: Vec::new(), next_surface: 1 }), events }
    }

    pub fn session(&self) -> &SessionInfo {
        &self.session
    }

    pub fn site(&self) -> &SiteInfo {
        &self.site
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }

    fn emit(&self, method: &str, payload: Value) {
        let _ = self.events.send(json!({ "t": "ev", "m": method, "p": payload }).to_string());
    }

    /// Admits a surface. Phones need the session code and a free slot.
    pub fn join(&self, role: Role, code: Option<&str>) -> Result<u64, String> {
        let mut inner = self.inner.lock().unwrap();
        if role == Role::Phone {
            if code != Some(self.session.code.as_str()) {
                return Err("wrong session code".into());
            }
            let slot = (0..MAX_PHONES).find(|s| inner.participants.iter().all(|p| p.slot != *s)).ok_or("session full")?;
            let surface = inner.next_surface;
            inner.participants.push(Participant { surface, slot, colour: SLOT_COLOURS[slot] });
        }
        let surface = inner.next_surface;
        inner.next_surface += 1;
        let participants = inner.participants.clone();
        drop(inner);
        if role == Role::Phone {
            self.emit("state.participants", json!({ "participants": participants }));
        }
        Ok(surface)
    }

    pub fn leave(&self, surface: u64) {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.participants.len();
        inner.participants.retain(|p| p.surface != surface);
        let changed = inner.participants.len() != before;
        let participants = inner.participants.clone();
        drop(inner);
        if changed {
            self.emit("state.participants", json!({ "participants": participants }));
        }
    }

    /// The `welcome` message for a surface.
    pub fn welcome(&self, surface: u64) -> Value {
        let inner = self.inner.lock().unwrap();
        json!({
            "t": "welcome",
            "surface": surface,
            "state": {
                "protocol": PROTOCOL,
                "session": self.session,
                "site": self.site,
                "layers": inner.layers,
                "participants": inner.participants,
            },
            "manifests": self.defs.iter().map(|d| &d.manifest).collect::<Vec<_>>(),
        })
    }

    fn def(&self, layer: &str) -> Result<&LayerDef, String> {
        self.defs.iter().find(|d| d.id == layer).ok_or_else(|| format!("unknown layer '{layer}'"))
    }

    /// Handles a session request. Engine requests are handled by the connection.
    pub fn request(&self, role: Role, surface: u64, method: &str, p: &Value) -> Result<Value, String> {
        let layer = p["layer"].as_str().ok_or("missing layer")?;
        let def = self.def(layer)?;
        match method {
            "layer.activate" => {
                if !role.may_activate() {
                    return Err("phones cannot turn layers on or off".into());
                }
                let active = p["active"].as_bool().ok_or("missing active")?;
                self.update(layer, |state| state.active = active);
            }
            "layer.intensity" => {
                if !role.may_activate() {
                    return Err("phones cannot change a layer's intensity".into());
                }
                let intensity = p["intensity"].as_f64().filter(|v| v.is_finite()).ok_or("missing intensity")?.clamp(0.0, 2.0);
                self.update(layer, |state| state.intensity = intensity);
            }
            "layer.set" => {
                let patch = p["params"].as_object().ok_or("missing params")?;
                let clean = def.validate(patch, role == Role::Phone)?;
                self.update(layer, |state| state.params.extend(clean));
            }
            "layer.publish" => {
                if !role.may_publish() {
                    return Err("only the table publishes".into());
                }
                let values = p["values"].as_object().ok_or("missing values")?.clone();
                self.update(layer, |state| state.shared.extend(values));
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
                let tool = p["tool"].as_str().ok_or("missing tool")?;
                let declared = def.manifest["tools"].as_array().is_some_and(|t| t.iter().any(|t| t["id"] == tool));
                if !declared {
                    return Err(format!("layer '{layer}' has no tool '{tool}'"));
                }
                self.emit("tool.input", json!({ "layer": layer, "tool": tool, "geometry": p["geometry"], "from": surface }));
            }
            other => return Err(format!("unknown method '{other}'")),
        }
        Ok(json!({}))
    }

    fn update(&self, layer: &str, change: impl FnOnce(&mut LayerState)) {
        let mut inner = self.inner.lock().unwrap();
        let state = inner.layers.get_mut(layer).expect("layer state exists for every def");
        change(state);
        let payload = json!({ "layer": layer, "state": state });
        // Emit under the lock so events for a layer are broadcast in the order they were applied.
        self.emit("state.layer", payload);
    }
}
