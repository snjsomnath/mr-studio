//! Layer manifests and the validation of params against their controls.
//! Contract in `docs/contracts/layer.md`.

use std::path::Path;

use anyhow::{anyhow, bail, Context as _};
use mrs_site::Site;
use serde_json::{Map, Value};

pub const LAYER_API: u64 = 1;
/// Palette groups a layer may put itself in with `category`.
pub const CATEGORIES: [&str; 4] = ["base", "ambient", "analysis", "media"];

#[derive(Debug, Clone)]
pub enum ControlKind {
    Range { min: f64, max: f64, step: f64 },
    Select { options: Vec<Value> },
    Toggle,
    Date,
    Color,
    Text,
    Action,
}

#[derive(Debug, Clone)]
pub struct Control {
    pub id: String,
    pub kind: ControlKind,
    /// Phone participants may change it.
    pub phone: bool,
    pub default: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Point,
    Line,
    Polygon,
}

/// A spatial input the layer accepts.
#[derive(Debug, Clone)]
pub struct Tool {
    pub id: String,
    pub kind: ToolKind,
}

#[derive(Debug, Clone)]
pub struct LayerDef {
    pub id: String,
    /// What a `layers[].use` in site.json says to get this layer: its id for a core
    /// layer, a relative path for a site-only one.
    pub source: String,
    /// The manifest as written, sent to surfaces.
    pub manifest: Value,
    pub controls: Vec<Control>,
    pub tools: Vec<Tool>,
    /// Things a visitor picks and changes one by one (#279), from `entities`.
    pub entity_sets: Vec<EntitySet>,
    /// Named actions without a button (#283), pressed from a layer's stage, hero or panels.
    pub actions: Vec<String>,
}

/// The most voices a layer's sound bed has (#282): a bed is a few slow layers, never a band.
pub const MOST_VOICES: usize = 4;

/// A layer's `sound` (#282): up to four voices, each `noise`, `hum` or `tone` with its own id.
/// What each voice's values mean is checked where it plays (`@mrstudio/sdk` voices.ts).
fn check_voices(sound: &Value) -> anyhow::Result<()> {
    let list = match sound {
        Value::Null => return Ok(()),
        Value::Array(list) => list,
        _ => bail!("sound is a list of voices"),
    };
    if list.len() > MOST_VOICES {
        bail!("sound has at most {MOST_VOICES} voices");
    }
    let mut ids = std::collections::HashSet::new();
    for voice in list {
        let id = voice["id"].as_str().filter(|id| is_entity_id(id) && !id.is_empty()).ok_or_else(|| anyhow!("every voice needs an id"))?;
        if !ids.insert(id) {
            bail!("two voices are called '{id}'");
        }
        if !matches!(voice["kind"].as_str(), Some("noise" | "hum" | "tone")) {
            bail!("voice '{id}' has kind noise, hum or tone");
        }
    }
    Ok(())
}

/// The param that holds every entity's changed values: `entities[set][entity][control]`.
pub const ENTITIES: &str = "entities";
/// The most entities a layer keeps values for, and the longest entity id.
pub const MOST_ENTITIES: usize = 10_000;
const LONGEST_ENTITY_ID: usize = 200;

/// A set of entities (#279): the controls each of its entities has.
#[derive(Debug, Clone)]
pub struct EntitySet {
    pub id: String,
    pub controls: Vec<Control>,
}

impl EntitySet {
    /// Checks values for one entity, as `LayerDef::validate` does for a layer's params.
    pub fn validate(&self, values: &Map<String, Value>, phone: bool) -> Result<Map<String, Value>, String> {
        let mut out = Map::new();
        for (key, value) in values {
            let control =
                self.controls.iter().find(|c| &c.id == key).ok_or_else(|| format!("'{}' entities have no control '{key}'", self.id))?;
            if phone && !control.phone {
                return Err(format!("'{key}' cannot be changed from a phone"));
            }
            out.insert(key.clone(), control.validate(value).map_err(|e| format!("{key}: {e}"))?);
        }
        Ok(out)
    }

    /// Drops values that are the control's default, so only real changes are kept and marked.
    pub fn changed_only(&self, values: &mut Map<String, Value>) {
        values.retain(|key, value| self.controls.iter().find(|c| &c.id == key).is_none_or(|c| &c.default != value));
    }
}

/// Whether a string can name an entity: not empty, at most 200 characters.
pub fn is_entity_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= LONGEST_ENTITY_ID
}

impl LayerDef {
    pub fn parse(manifest: Value) -> anyhow::Result<Self> {
        let api = manifest["api"].as_u64().ok_or_else(|| anyhow!("missing api"))?;
        if api != LAYER_API {
            bail!("layer api is {api}, this app supports {LAYER_API}");
        }
        let id = manifest["id"].as_str().ok_or_else(|| anyhow!("missing id"))?.to_string();
        if !mrs_site::is_instance_id(&id) {
            bail!("id '{id}' must be lowercase letters, digits and dashes");
        }
        match &manifest["category"] {
            Value::Null => {}
            Value::String(c) if CATEGORIES.contains(&c.as_str()) => {}
            other => bail!("category {other} is not one of {}", CATEGORIES.join(", ")),
        }
        let mut controls = Vec::new();
        for c in manifest["controls"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            controls.push(Control::parse(c)?);
        }
        let mut entity_sets: Vec<EntitySet> = Vec::new();
        for e in manifest["entities"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let sid = e["id"]
                .as_str()
                .filter(|s| mrs_site::is_instance_id(s))
                .ok_or_else(|| anyhow!("an entity set needs an id of lowercase letters, digits and dashes"))?;
            if entity_sets.iter().any(|s| s.id == sid) {
                bail!("two entity sets are called '{sid}'");
            }
            for field in ["dataset", "key"] {
                if e[field].as_str().is_none_or(str::is_empty) {
                    bail!("entity set '{sid}' needs a {field}");
                }
            }
            let mut set = EntitySet { id: sid.to_string(), controls: Vec::new() };
            for c in e["controls"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                let control = Control::parse(c).map_err(|err| anyhow!("entity set '{sid}': {err}"))?;
                if matches!(control.kind, ControlKind::Action) {
                    bail!("entity set '{sid}': '{}' is an action; entities have values only", control.id);
                }
                if set.controls.iter().any(|other| other.id == control.id) {
                    bail!("entity set '{sid}' has two controls called '{}'", control.id);
                }
                set.controls.push(control);
            }
            if set.controls.is_empty() {
                bail!("entity set '{sid}' has no controls");
            }
            entity_sets.push(set);
        }
        let mut actions: Vec<String> = Vec::new();
        for a in manifest["actions"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let aid = a["id"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("a named action has no id"))?;
            if actions.iter().any(|other| other == aid) || controls.iter().any(|c| c.id == aid) {
                bail!("action '{aid}' is named twice");
            }
            actions.push(aid.to_string());
        }
        check_voices(&manifest["sound"])?;
        match &manifest["stage"] {
            Value::Null => {}
            Value::String(s) if s == "custom" => {}
            other => bail!("stage {other} is not \"custom\""),
        }
        if !entity_sets.is_empty() && controls.iter().any(|c| c.id == ENTITIES) {
            bail!("a layer with entities cannot have a control called '{ENTITIES}'");
        }
        let mut tools = Vec::new();
        for t in manifest["tools"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let tid = t["id"].as_str().ok_or_else(|| anyhow!("a tool has no id"))?.to_string();
            let kind = match t["type"].as_str() {
                Some("point") => ToolKind::Point,
                Some("line") => ToolKind::Line,
                Some("polygon") => ToolKind::Polygon,
                other => bail!("tool '{tid}' has unknown type {other:?}"),
            };
            tools.push(Tool { id: tid, kind });
        }
        Ok(Self { source: id.clone(), id, manifest, controls, tools, entity_sets, actions })
    }

    pub fn tool(&self, id: &str) -> Option<&Tool> {
        self.tools.iter().find(|t| t.id == id)
    }

    pub fn entity_set(&self, id: &str) -> Option<&EntitySet> {
        self.entity_sets.iter().find(|s| s.id == id)
    }

    /// Checks a whole `entities` param: known sets, entity ids, and each value against its control.
    pub fn validate_entities(&self, value: &Value, phone: bool) -> Result<Value, String> {
        let sets = value.as_object().ok_or("entities must be an object of sets")?;
        let mut out = Map::new();
        let mut count = 0;
        for (sid, entities) in sets {
            let set = self.entity_set(sid).ok_or_else(|| format!("layer '{}' has no entity set '{sid}'", self.id))?;
            let entities = entities.as_object().ok_or_else(|| format!("entities.{sid} must be an object of entities"))?;
            let mut clean = Map::new();
            for (id, values) in entities {
                if !is_entity_id(id) {
                    return Err(format!("entities.{sid}: '{id}' is not an entity id"));
                }
                let mut values =
                    set.validate(values.as_object().ok_or_else(|| format!("entities.{sid}.{id} must be an object"))?, phone)?;
                set.changed_only(&mut values);
                if !values.is_empty() {
                    clean.insert(id.clone(), Value::Object(values));
                }
            }
            count += clean.len();
            if !clean.is_empty() {
                out.insert(sid.clone(), Value::Object(clean));
            }
        }
        if count > MOST_ENTITIES {
            return Err(format!("at most {MOST_ENTITIES} entities can have their own values"));
        }
        Ok(Value::Object(out))
    }

    pub fn control(&self, id: &str) -> Option<&Control> {
        self.controls.iter().find(|c| c.id == id)
    }

    /// The first dataset in `requires.data` that `data` does not have.
    pub fn missing_data(&self, data: &std::collections::BTreeMap<String, String>) -> anyhow::Result<Option<String>> {
        for name in self.manifest["requires"]["data"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let name = name.as_str().ok_or_else(|| anyhow!("layer '{}': requires.data must be dataset names", self.id))?;
            if !data.contains_key(name) {
                return Ok(Some(name.to_string()));
            }
        }
        Ok(None)
    }

    pub fn defaults(&self) -> Map<String, Value> {
        self.controls.iter().filter(|c| !matches!(c.kind, ControlKind::Action)).map(|c| (c.id.clone(), c.default.clone())).collect()
    }

    /// Validates a patch. Returns the cleaned values, or the first problem.
    pub fn validate(&self, patch: &Map<String, Value>, phone: bool) -> Result<Map<String, Value>, String> {
        let mut out = Map::new();
        for (key, value) in patch {
            if key == ENTITIES && !self.entity_sets.is_empty() {
                if phone {
                    return Err("phones change entities one at a time".into());
                }
                out.insert(key.clone(), self.validate_entities(value, false)?);
                continue;
            }
            let control = self.control(key).ok_or_else(|| format!("layer '{}' has no control '{key}'", self.id))?;
            if matches!(control.kind, ControlKind::Action) {
                return Err(format!("'{key}' is an action, not a value"));
            }
            if phone && !control.phone {
                return Err(format!("'{key}' cannot be changed from a phone"));
            }
            out.insert(key.clone(), control.validate(value).map_err(|e| format!("{key}: {e}"))?);
        }
        Ok(out)
    }
}

impl Control {
    /// Reads one control of a layer.json: its id, type, phone flag and checked default.
    pub fn parse(c: &Value) -> anyhow::Result<Self> {
        let cid = c["id"].as_str().ok_or_else(|| anyhow!("a control has no id"))?.to_string();
        let num = |key: &str| c[key].as_f64().ok_or_else(|| anyhow!("control '{cid}' needs a numeric {key}"));
        let kind = match c["type"].as_str() {
            Some("range") => {
                let (min, max) = (num("min")?, num("max")?);
                let step = c["step"].as_f64().unwrap_or(0.0);
                if !(max > min) || step < 0.0 {
                    bail!("control '{cid}' has an empty range");
                }
                ControlKind::Range { min, max, step }
            }
            Some("select") => {
                let options: Vec<Value> = c["options"]
                    .as_array()
                    .map(|o| o.iter().map(|o| o.get("value").cloned().unwrap_or_else(|| o.clone())).collect())
                    .unwrap_or_default();
                if options.is_empty() {
                    bail!("control '{cid}' has no options");
                }
                ControlKind::Select { options }
            }
            Some("toggle") => ControlKind::Toggle,
            Some("date") => ControlKind::Date,
            Some("color") => ControlKind::Color,
            Some("text") => ControlKind::Text,
            Some("action") => ControlKind::Action,
            other => bail!("control '{cid}' has unknown type {other:?}"),
        };
        let mut control = Control { id: cid.clone(), kind, phone: c["phone"].as_bool().unwrap_or(false), default: Value::Null };
        if !matches!(control.kind, ControlKind::Action) {
            control.default = control.validate(&c["default"]).map_err(|e| anyhow!("control '{cid}' default: {e}"))?;
        }
        Ok(control)
    }

    /// Returns the value as it will be stored: clamped, snapped and type-checked.
    pub fn validate(&self, value: &Value) -> Result<Value, String> {
        match &self.kind {
            ControlKind::Range { min, max, step } => {
                let v = value.as_f64().filter(|v| v.is_finite()).ok_or("must be a number")?;
                let mut v = v.clamp(*min, *max);
                if *step > 0.0 {
                    v = (min + ((v - min) / step).round() * step).clamp(*min, *max);
                    // Remove binary noise such as 0.30000000000000004.
                    v = (v * 1e9).round() / 1e9;
                }
                Ok(Value::from(v))
            }
            ControlKind::Select { options } => {
                options.contains(value).then(|| value.clone()).ok_or_else(|| "is not one of the options".to_string())
            }
            ControlKind::Toggle => value.as_bool().map(Value::from).ok_or_else(|| "must be true or false".to_string()),
            ControlKind::Date => {
                let s = value.as_str().ok_or("must be a YYYY-MM-DD string")?;
                let b = s.as_bytes();
                let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
                let ok = b.len() == 10 && b[4] == b'-' && b[7] == b'-' && digits(0..4) && digits(5..7) && digits(8..10);
                let month: u32 = if ok { s[5..7].parse().unwrap_or(0) } else { 0 };
                let day: u32 = if ok { s[8..10].parse().unwrap_or(0) } else { 0 };
                if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
                    return Err("must be a YYYY-MM-DD date".into());
                }
                Ok(value.clone())
            }
            ControlKind::Color => {
                let s = value.as_str().ok_or("must be a #rrggbb string")?;
                let ok = s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit());
                ok.then(|| value.clone()).ok_or_else(|| "must be a #rrggbb colour".to_string())
            }
            ControlKind::Text => {
                let s = value.as_str().ok_or("must be text")?;
                (s.chars().count() <= 500).then(|| value.clone()).ok_or_else(|| "is longer than 500 characters".to_string())
            }
            ControlKind::Action => Err("is an action".into()),
        }
    }
}

fn read_manifest(dir: &Path) -> anyhow::Result<LayerDef> {
    let path = dir.join("layer.json");
    let text = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let mut value: Value = serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    let locales = read_locales(dir)?;
    if !locales.is_empty() {
        value["locales"] = Value::Object(locales);
    }
    LayerDef::parse(value).with_context(|| format!("in {}", path.display()))
}

/// A layer package's words in other languages (#80): `locales/sv.json` and so on, sent to
/// surfaces in the manifest as `locales: { sv: {...} }`. What a file holds is in
/// docs/contracts/layer.md, Languages.
fn read_locales(dir: &Path) -> anyhow::Result<Map<String, Value>> {
    let mut locales = Map::new();
    for language in mrs_site::LANGUAGES {
        let path = dir.join("locales").join(format!("{language}.json"));
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let words: Value = serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        if !words.is_object() {
            bail!("{} must hold an object", path.display());
        }
        locales.insert(language.to_string(), words);
    }
    Ok(locales)
}

/// Loads the layer catalogue: every core layer package, then the site-only layers the
/// site lists. A broken core layer the site does not use is skipped with a warning.
/// The layer.json a custom layer stands for: its words, controls, legend and attract effect,
/// with the recipe itself under `custom` for the runtime to draw.
fn custom_manifest(id: &str, recipe: &mrs_site::CustomLayer) -> Value {
    let mut manifest = serde_json::json!({
        "api": LAYER_API,
        "id": id,
        "name": recipe.name,
        "description": recipe.description.clone().unwrap_or_default(),
        "category": recipe.category.clone().unwrap_or_else(|| "analysis".into()),
        "controls": recipe.controls,
        "custom": recipe,
    });
    if let Some(icon) = &recipe.icon {
        manifest["icon"] = icon.clone().into();
    }
    if !recipe.legend.is_empty() {
        manifest["legend"] = serde_json::to_value(&recipe.legend).unwrap_or_default();
    }
    if let Some(attract) = &recipe.attract {
        manifest["attract"] = serde_json::to_value(attract).unwrap_or_default();
    }
    // Points with sounds (#150) can be played on demand: a tap on the table or a phone's map
    // (the `sound` tool), a card on the controller (the same tool, at the point), or a step of
    // a presentation that names the sound (the `play` param).
    if recipe.motion.iter().any(|m| m.block == "sound") {
        manifest["tools"] = serde_json::json!([{ "id": "sound", "type": "point", "label": "Play a sound" }]);
        let taken = recipe.controls.iter().any(|c| c.get("id").and_then(Value::as_str) == Some("play"));
        if !taken {
            if let Some(controls) = manifest["controls"].as_array_mut() {
                controls.push(serde_json::json!({
                    "id": "play", "type": "text", "label": "Play a sound (its name)", "default": "", "tier": "more"
                }));
            }
        }
    }
    // A network of flows (#280) plays its series on one shared play head that the controller
    // can pause and scrub: `network_play` and `network_at` (a share of the series, in %).
    if recipe.motion.iter().any(|m| m.block == "network") {
        let taken = |id: &str| recipe.controls.iter().any(|c| c.get("id").and_then(Value::as_str) == Some(id));
        let mut extra = Vec::new();
        if !taken("network_play") {
            extra.push(serde_json::json!({ "id": "network_play", "type": "toggle", "label": "Play", "default": true, "tier": "primary" }));
        }
        if !taken("network_at") {
            extra.push(serde_json::json!({
                "id": "network_at", "type": "range", "label": "Time", "min": 0, "max": 100, "step": 1, "default": 0, "unit": "%", "tier": "primary"
            }));
        }
        if let Some(controls) = manifest["controls"].as_array_mut() {
            controls.extend(extra);
        }
    }
    manifest
}

/// The folder of a site that holds its own layer packages (#277).
pub const SITE_LAYERS: &str = "layers";
/// Where a site layer's built code is, inside its package. `mrstudio layer build` writes it.
pub const SITE_LAYER_MODULE: &str = "dist/index.js";

/// `./layers/x` and `layers/x/` name the same folder.
fn same_path(a: &str, b: &str) -> bool {
    let tidy = |p: &str| p.trim_start_matches("./").trim_end_matches('/').to_string();
    tidy(a) == tidy(b)
}

/// The address a surface imports a site layer's code from: its built module under the site's
/// `/site` route, with the file's time so a rebuilt layer is not served from a browser's cache.
/// None when the package has not been built: its manifest still loads, and it draws nothing.
pub fn module_url(source: &str, dir: &Path) -> Option<String> {
    let file = dir.join(SITE_LAYER_MODULE);
    let modified = std::fs::metadata(&file).ok()?.modified().ok()?;
    let stamp = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = source.trim_start_matches("./").trim_end_matches('/');
    Some(format!("/site/{path}/{SITE_LAYER_MODULE}?v={stamp}"))
}

/// The catalogue entry for a custom layer saved in the site.
pub fn custom_def(id: &str, recipe: &mrs_site::CustomLayer) -> anyhow::Result<LayerDef> {
    let mut def = LayerDef::parse(custom_manifest(id, recipe)).map_err(|e| anyhow!("custom layer '{id}': {e:#}"))?;
    def.source = format!("{}{id}", mrs_site::CUSTOM_PREFIX);
    Ok(def)
}

pub fn load_catalog(site: &Site, core_layers: &Path) -> anyhow::Result<Vec<LayerDef>> {
    let mut defs: Vec<LayerDef> = Vec::new();
    let mut folders: Vec<_> = match std::fs::read_dir(core_layers) {
        Ok(entries) => entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.join("layer.json").is_file()).collect(),
        Err(e) => bail!("reading the layers folder {}: {e}", core_layers.display()),
    };
    folders.sort();
    for dir in folders {
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        let used = site.instances().iter().any(|(used, _, _)| *used == name);
        let def = read_manifest(&dir).and_then(|def| {
            if def.id != name {
                bail!("{} declares id '{}', expected '{name}'", dir.display(), def.id);
            }
            Ok(def)
        });
        match def {
            Ok(def) => defs.push(def),
            Err(e) if used => return Err(e),
            Err(e) => tracing::warn!("layer '{name}' is left out of the palette: {e:#}"),
        }
    }
    // The site's custom layers: recipes that the runtime draws from the blocks they list.
    for (id, recipe) in &site.manifest.custom {
        if defs.iter().any(|d| &d.id == id) {
            bail!("the custom layer '{id}' has the id of a core layer; give it another id");
        }
        defs.push(custom_def(id, recipe)?);
    }
    // The site's own layer packages (#277): those the scene uses, and every folder in `layers/`,
    // so the composer's palette offers them too. One that the scene does not use and that does
    // not load is left out with a warning, as a core layer is.
    let mut site_layers: Vec<(String, bool)> =
        site.instances().iter().filter(|(used, _, _)| used.starts_with('.')).map(|(used, _, _)| (used.to_string(), true)).collect();
    if let Ok(entries) = std::fs::read_dir(site.dir.join(SITE_LAYERS)) {
        let mut found: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().join("layer.json").is_file())
            .filter_map(|e| e.file_name().to_str().map(|name| format!("./{SITE_LAYERS}/{name}")))
            .collect();
        found.sort();
        for used in found {
            if !site_layers.iter().any(|(known, _)| same_path(known, &used)) {
                site_layers.push((used, false));
            }
        }
    }
    for (used, in_scene) in &site_layers {
        if defs.iter().any(|d| same_path(&d.source, used)) {
            continue;
        }
        let def = site.resolve(used).ok_or_else(|| anyhow!("layer path '{used}' leaves the site folder")).and_then(|dir| {
            let mut def = read_manifest(&dir)?;
            if defs.iter().any(|d| d.id == def.id) {
                bail!("{} declares id '{}', which another layer already uses", dir.display(), def.id);
            }
            def.source = used.to_string();
            if let Some(module) = module_url(used, &dir) {
                def.manifest["module"] = Value::String(module);
            }
            Ok(def)
        });
        match def {
            Ok(def) => defs.push(def),
            Err(e) if *in_scene => return Err(e),
            Err(e) => tracing::warn!("site layer '{used}' is left out of the palette: {e:#}"),
        }
    }
    for (used, _, _) in site.instances() {
        if used.starts_with('.') {
            continue;
        } else if !defs.iter().any(|d| d.source == used) {
            bail!("site.json uses layer '{used}', which is not in {}", core_layers.display());
        }
    }
    // A layer the site uses should find the datasets it requires. A table that lacks one still
    // opens: the layer shows nothing, and the editor offers to bring the data in. (Adding such a
    // layer is refused in the scene instead.)
    let data = site.data();
    for (used, _, _) in site.instances() {
        let Some(def) = defs.iter().find(|d| d.source == used) else { continue };
        if let Some(name) = def.missing_data(&data)? {
            tracing::warn!("layer '{}' needs the dataset '{name}', which this site does not have yet", def.id);
        }
        // A layer that calls a service the site does not declare (#278) still starts; its calls are refused.
        for wanted in def.manifest["requires"]["services"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let wanted = wanted.as_str().unwrap_or_default();
            if !site.manifest.services.iter().any(|s| s.id == wanted) {
                tracing::warn!("layer '{}' needs the service '{wanted}', which this site does not have under \"services\"", def.id);
            }
        }
    }
    Ok(defs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def() -> LayerDef {
        LayerDef::parse(json!({
            "api": 1, "id": "t", "name": "T",
            "controls": [
                { "id": "hour", "type": "range", "label": "Hour", "min": 0, "max": 24, "step": 0.25, "default": 12, "phone": true },
                { "id": "mode", "type": "select", "label": "Mode", "default": "a", "options": [{ "value": "a", "label": "A" }, { "value": "b", "label": "B" }] },
                { "id": "on", "type": "toggle", "label": "On", "default": false },
                { "id": "date", "type": "date", "label": "Date", "default": "2026-06-21" },
                { "id": "go", "type": "action", "label": "Go" }
            ]
        }))
        .unwrap()
    }

    fn patch(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn clamps_snaps_and_rejects() {
        let d = def();
        assert_eq!(d.defaults().len(), 4);
        assert_eq!(d.validate(&patch(json!({ "hour": 30 })), false).unwrap()["hour"], json!(24.0));
        assert_eq!(d.validate(&patch(json!({ "hour": 7.6 })), false).unwrap()["hour"], json!(7.5));
        assert!(d.validate(&patch(json!({ "hour": "7" })), false).is_err());
        assert!(d.validate(&patch(json!({ "mode": "c" })), false).is_err());
        assert!(d.validate(&patch(json!({ "nope": 1 })), false).is_err());
        assert!(d.validate(&patch(json!({ "go": true })), false).is_err());
        assert!(d.validate(&patch(json!({ "date": "21 June" })), false).is_err());
        assert!(d.validate(&patch(json!({ "date": "2026-12-01" })), false).is_ok());
    }

    #[test]
    fn phones_only_change_phone_controls() {
        let d = def();
        assert!(d.validate(&patch(json!({ "hour": 9 })), true).is_ok());
        assert!(d.validate(&patch(json!({ "mode": "b" })), true).is_err());
    }

    #[test]
    fn every_core_layer_speaks_swedish() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let site = Site::load(repo.join("sites/sample")).unwrap();
        let catalog = load_catalog(&site, &repo.join("packages/layers")).unwrap();
        for def in catalog.iter().filter(|d| !d.source.starts_with(mrs_site::CUSTOM_PREFIX)) {
            let words = &def.manifest["locales"]["sv"];
            let name = def.manifest["name"].as_str().unwrap();
            assert!(words[name].is_string(), "{} has no Swedish name", def.id);
            // Every control's label and choices have a translation (#80).
            for control in def.manifest["controls"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                let label = control["label"].as_str().unwrap_or_default();
                assert!(words[label].is_string(), "{}: '{label}' has no Swedish", def.id);
                for option in control["options"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                    let text = option["label"].as_str().unwrap_or_default();
                    assert!(text.ends_with("m/s") || words[text].is_string(), "{}: '{text}' has no Swedish", def.id);
                }
            }
        }
        let sunlight = catalog.iter().find(|d| d.id == "sunlight").unwrap();
        assert_eq!(sunlight.manifest["locales"]["sv"]["Sunlight"], "Solljus");
    }

    #[test]
    fn a_table_missing_a_layers_data_still_opens() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut site = Site::load(repo.join("sites/sample")).unwrap();
        assert!(site.manifest.layers.iter().any(|l| l.r#use == "cars"));
        let catalog = load_catalog(&site, &repo.join("packages/layers")).unwrap();
        // Traffic needs streets; without them the table opens, and Traffic says what it lacks.
        site.manifest.data.remove("roads");
        let data = site.data();
        assert!(load_catalog(&site, &repo.join("packages/layers")).is_ok());
        let cars = catalog.iter().find(|d| d.id == "cars").unwrap();
        assert_eq!(cars.missing_data(&data).unwrap().as_deref(), Some("roads"));
    }

    #[test]
    fn site_layers_are_found_and_carry_their_built_module() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let tmp = std::env::temp_dir().join(format!("mrs-site-layers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let package = |name: &str, manifest: Value| {
            let dir = tmp.join(SITE_LAYERS).join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("layer.json"), manifest.to_string()).unwrap();
            dir
        };
        let built = package("rings", json!({ "api": 1, "id": "rings", "name": "Rings" }));
        std::fs::create_dir_all(built.join("dist")).unwrap();
        std::fs::write(built.join(SITE_LAYER_MODULE), "export default {}").unwrap();
        package("unbuilt", json!({ "api": 1, "id": "unbuilt", "name": "Unbuilt" }));
        // Broken and not in the scene: left out of the palette, the table still opens.
        package("broken", json!({ "api": 9, "id": "broken" }));
        // The sample site, looked for in another folder: only its layers come from there.
        let mut site = Site::load(repo.join("sites/sample")).unwrap();
        site.dir = tmp.clone();
        let catalog = load_catalog(&site, &repo.join("packages/layers")).unwrap();
        let rings = catalog.iter().find(|d| d.id == "rings").unwrap();
        assert_eq!(rings.source, "./layers/rings");
        let module = rings.manifest["module"].as_str().unwrap();
        assert!(module.starts_with("/site/layers/rings/dist/index.js?v="), "{module}");
        let unbuilt = catalog.iter().find(|d| d.id == "unbuilt").unwrap();
        assert!(unbuilt.manifest.get("module").is_none());
        assert!(!catalog.iter().any(|d| d.id == "broken"));
        // In the scene, named either way, it is the same layer, listed once.
        site.manifest.layers.push(serde_json::from_value(json!({ "use": "./layers/rings", "id": "rings" })).unwrap());
        let catalog = load_catalog(&site, &repo.join("packages/layers")).unwrap();
        assert_eq!(catalog.iter().filter(|d| d.id == "rings").count(), 1);
        // A broken layer the scene uses stops the table, with the reason.
        site.manifest.layers.push(serde_json::from_value(json!({ "use": "./layers/broken", "id": "broken" })).unwrap());
        assert!(load_catalog(&site, &repo.join("packages/layers")).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn with_entities() -> LayerDef {
        LayerDef::parse(json!({
            "api": 1, "id": "e", "name": "E",
            "entities": [{ "id": "members", "dataset": "buildings", "key": "id", "controls": [
                { "id": "in", "type": "toggle", "label": "In", "default": false, "phone": true },
                { "id": "pv", "type": "range", "label": "PV", "min": 0, "max": 80, "step": 5, "default": 0 }
            ] }]
        }))
        .unwrap()
    }

    #[test]
    fn entity_values_are_checked_and_only_changes_kept() {
        let d = with_entities();
        assert!(d.defaults().is_empty(), "no entity has values of its own yet");
        let clean =
            d.validate(&patch(json!({ "entities": { "members": { "3": { "pv": 33, "in": false }, "4": { "pv": 0 } } } })), false).unwrap();
        // Snapped like a layer control; defaults are dropped, and an entity left with none goes.
        assert_eq!(clean["entities"], json!({ "members": { "3": { "pv": 35.0 } } }));
        assert!(d.validate(&patch(json!({ "entities": { "other": {} } })), false).is_err());
        assert!(d.validate(&patch(json!({ "entities": { "members": { "3": { "nope": 1 } } } })), false).is_err());
        assert!(d.validate(&patch(json!({ "entities": { "members": { "": { "pv": 5 } } } })), false).is_err());
        assert!(d.validate(&patch(json!({ "entities": {} })), true).is_err(), "phones go one entity at a time");
        let set = d.entity_set("members").unwrap();
        assert!(set.validate(&patch(json!({ "in": true })), true).is_ok());
        assert!(set.validate(&patch(json!({ "pv": 10 })), true).is_err());
    }

    #[test]
    fn bad_entity_sets_are_refused() {
        let layer = |sets: Value| LayerDef::parse(json!({ "api": 1, "id": "e", "name": "E", "entities": sets }));
        let toggle = json!({ "id": "in", "type": "toggle", "label": "In", "default": false });
        assert!(layer(json!([{ "id": "a", "dataset": "b", "key": "id", "controls": [toggle] }])).is_ok());
        assert!(layer(json!([{ "id": "a", "dataset": "b", "key": "id", "controls": [] }])).is_err());
        assert!(layer(json!([{ "id": "a", "key": "id", "controls": [toggle] }])).is_err());
        assert!(layer(json!([{ "id": "a", "dataset": "b", "key": "id", "controls": [{ "id": "go", "type": "action", "label": "Go" }] }]))
            .is_err());
        assert!(layer(json!([{ "id": "a", "dataset": "b", "key": "id", "controls": [toggle] }, { "id": "a", "dataset": "b", "key": "id", "controls": [toggle] }])).is_err());
    }

    #[test]
    fn named_actions_and_a_custom_stage_are_checked() {
        let layer = |extra: Value| {
            let mut m = json!({ "api": 1, "id": "s", "name": "S", "controls": [{ "id": "go", "type": "action", "label": "Go" }] });
            m.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            LayerDef::parse(m)
        };
        assert_eq!(layer(json!({ "stage": "custom", "actions": [{ "id": "travel" }] })).unwrap().actions, vec!["travel"]);
        assert!(layer(json!({ "stage": "big" })).is_err());
        assert!(layer(json!({ "actions": [{ "id": "go" }] })).is_err(), "already an action control");
        assert!(layer(json!({ "actions": [{ "label": "No id" }] })).is_err());
    }

    #[test]
    fn sound_voices_are_checked() {
        let layer = |extra: Value| {
            let mut m = json!({ "api": 1, "id": "t" });
            m.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            LayerDef::parse(m)
        };
        assert!(layer(json!({ "sound": [{ "id": "grid", "kind": "noise" }, { "id": "hum", "kind": "hum" }] })).is_ok());
        assert!(layer(json!({ "sound": { "id": "grid" } })).is_err());
        assert!(layer(json!({ "sound": [{ "id": "a", "kind": "drum" }] })).is_err());
        assert!(layer(json!({ "sound": [{ "id": "a", "kind": "tone" }, { "id": "a", "kind": "hum" }] })).is_err());
        let five: Vec<Value> = (0..5).map(|i| json!({ "id": format!("v{i}"), "kind": "tone" })).collect();
        assert!(layer(json!({ "sound": five })).is_err());
    }

    #[test]
    fn bad_manifests_are_refused() {
        assert!(LayerDef::parse(json!({ "api": 2, "id": "t" })).is_err());
        assert!(LayerDef::parse(json!({ "api": 1, "id": "t", "category": "ambient" })).is_ok());
        assert!(LayerDef::parse(json!({ "api": 1, "id": "t", "category": "misc" })).is_err());
        assert!(LayerDef::parse(json!({ "api": 1, "id": "Bad Id" })).is_err());
        assert!(LayerDef::parse(json!({ "api": 1, "id": "t", "tools": [{ "id": "x", "type": "circle" }] })).is_err());
        let ok = LayerDef::parse(json!({ "api": 1, "id": "t", "tools": [{ "id": "x", "type": "line" }] })).unwrap();
        assert_eq!(ok.tool("x").unwrap().kind, ToolKind::Line);
        assert!(LayerDef::parse(
            json!({ "api": 1, "id": "t", "controls": [{ "id": "x", "type": "range", "min": 1, "max": 1, "default": 1 }] })
        )
        .is_err());
        assert!(LayerDef::parse(
            json!({ "api": 1, "id": "t", "controls": [{ "id": "x", "type": "select", "options": [{ "value": "a" }], "default": "b" }] })
        )
        .is_err());
    }

    #[test]
    fn custom_layers_with_sounds_can_be_played_on_demand() {
        let recipe: mrs_site::CustomLayer = serde_json::from_value(json!({
            "name": "Birds",
            "data": [{ "id": "birds", "dataset": "birds" }],
            "look": [{ "id": "dots", "block": "points", "data": "birds" }],
            "motion": [{ "id": "dots-sound", "block": "sound", "on": "dots", "props": { "column": "sound" } }]
        }))
        .unwrap();
        let def = custom_def("birds", &recipe).unwrap();
        assert_eq!(def.tool("sound").unwrap().kind, ToolKind::Point);
        assert_eq!(def.validate(&patch(json!({ "play": "Blackbird" })), false).unwrap()["play"], json!("Blackbird"));
        let silent: mrs_site::CustomLayer = serde_json::from_value(json!({ "name": "Dots" })).unwrap();
        let def = custom_def("dots", &silent).unwrap();
        assert!(def.tool("sound").is_none());
        assert!(def.validate(&patch(json!({ "play": "x" })), false).is_err());
    }

    #[test]
    fn custom_networks_can_be_paused_and_scrubbed() {
        let recipe: mrs_site::CustomLayer = serde_json::from_value(json!({
            "name": "Energy",
            "data": [{ "id": "nodes", "dataset": "nodes" }],
            "look": [{ "id": "dots", "block": "points", "data": "nodes" }],
            "motion": [{ "id": "dots-network", "block": "network", "on": "dots", "props": { "links": "links" } }]
        }))
        .unwrap();
        let def = custom_def("energy", &recipe).unwrap();
        let checked = def.validate(&patch(json!({ "network_at": 40, "network_play": false })), false).unwrap();
        assert_eq!(checked["network_at"], json!(40.0));
        assert_eq!(checked["network_play"], json!(false));
        assert_eq!(def.validate(&patch(json!({ "network_at": 140 })), false).unwrap()["network_at"], json!(100.0));
        let plain: mrs_site::CustomLayer = serde_json::from_value(json!({ "name": "Dots" })).unwrap();
        assert!(custom_def("dots", &plain).unwrap().validate(&patch(json!({ "network_at": 1 })), false).is_err());
    }
}
