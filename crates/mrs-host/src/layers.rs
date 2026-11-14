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
            controls.push(control);
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
        Ok(Self { source: id.clone(), id, manifest, controls, tools })
    }

    pub fn tool(&self, id: &str) -> Option<&Tool> {
        self.tools.iter().find(|t| t.id == id)
    }

    pub fn control(&self, id: &str) -> Option<&Control> {
        self.controls.iter().find(|c| c.id == id)
    }

    pub fn defaults(&self) -> Map<String, Value> {
        self.controls.iter().filter(|c| !matches!(c.kind, ControlKind::Action)).map(|c| (c.id.clone(), c.default.clone())).collect()
    }

    /// Validates a patch. Returns the cleaned values, or the first problem.
    pub fn validate(&self, patch: &Map<String, Value>, phone: bool) -> Result<Map<String, Value>, String> {
        let mut out = Map::new();
        for (key, value) in patch {
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
    let value: Value = serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    LayerDef::parse(value).with_context(|| format!("in {}", path.display()))
}

/// Loads the layer catalogue: every core layer package, then the site-only layers the
/// site lists. A broken core layer the site does not use is skipped with a warning.
pub fn load_catalog(site: &Site, core_layers: &Path) -> anyhow::Result<Vec<LayerDef>> {
    let mut defs: Vec<LayerDef> = Vec::new();
    let mut folders: Vec<_> = match std::fs::read_dir(core_layers) {
        Ok(entries) => entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.join("layer.json").is_file()).collect(),
        Err(e) => bail!("reading the layers folder {}: {e}", core_layers.display()),
    };
    folders.sort();
    for dir in folders {
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        let used = site.manifest.layers.iter().any(|l| l.r#use == name);
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
    for layer in &site.manifest.layers {
        if layer.r#use.starts_with('.') {
            if defs.iter().any(|d| d.source == layer.r#use) {
                continue;
            }
            let dir = site.resolve(&layer.r#use).ok_or_else(|| anyhow!("layer path '{}' leaves the site folder", layer.r#use))?;
            let mut def = read_manifest(&dir)?;
            if defs.iter().any(|d| d.id == def.id) {
                bail!("{} declares id '{}', which another layer already uses", dir.display(), def.id);
            }
            def.source = layer.r#use.clone();
            defs.push(def);
        } else if !defs.iter().any(|d| d.source == layer.r#use) {
            bail!("site.json uses layer '{}', which is not in {}", layer.r#use, core_layers.display());
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
}
