//! Session state. The hub is the only authority over it: surfaces send requests,
//! the hub validates, updates and broadcasts.
//!
//! The scene is the ordered list of layer instances, bottom first. It starts as the
//! `layers` list of `site.json`, and the `scene.*` requests edit both together.

use std::sync::Mutex;

use mrs_site::{is_instance_id, LayerRef, Site, SiteInfo};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::broadcast;

use crate::layers::LayerDef;

pub const PROTOCOL: u32 = 1;
pub const MAX_PHONES: usize = 8;
/// More layers than this in one scene is a mistake, not a design.
pub const MAX_SCENE_LAYERS: usize = 64;
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

    /// Editing the scene rewrites site.json, so it is kept to the operator's surfaces.
    fn may_compose(self) -> bool {
        matches!(self, Self::Tv | Self::Dev)
    }

    pub fn may_use_engine(self) -> bool {
        self != Self::Phone
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LayerState {
    /// The layer package this instance runs.
    pub layer: String,
    pub active: bool,
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
    participants: Vec<Participant>,
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
}

pub struct Hub {
    site: Site,
    info: SiteInfo,
    session: SessionInfo,
    /// Every layer that can be added to a scene.
    catalog: Vec<LayerDef>,
    inner: Mutex<Inner>,
    events: broadcast::Sender<String>,
}

impl Hub {
    pub fn new(site: &Site, catalog: Vec<LayerDef>, port: u16) -> anyhow::Result<Self> {
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
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let session = SessionInfo { id: format!("{:x}", nanos), code: format!("{:04}", (nanos / 7919) % 10_000), port };
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            site: site.clone(),
            info: site.info(),
            session,
            catalog,
            inner: Mutex::new(Inner { scene, participants: Vec::new(), next_surface: 1 }),
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
        let state = LayerState { layer: layer.id.clone(), active: saved.active, params, shared: Map::new() };
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
                "site": self.info,
                "scene": inner.order(),
                "layers": inner.layers(),
                "participants": inner.participants,
            },
            "manifests": self.catalog.iter().map(|d| &d.manifest).collect::<Vec<_>>(),
        })
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
