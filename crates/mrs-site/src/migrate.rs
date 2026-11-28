//! Opening site packages written for an older site format.
//!
//! Every change to the format that an older `site.json` does not already satisfy adds one
//! step to `STEPS`: a function that rewrites the document from format N to N + 1. Opening
//! a site runs the steps it needs, so an old site always opens in a new app, and
//! `upgrade_site` writes the result back and keeps the original beside it.
//! A site written for a newer format than this build knows is refused, with a message
//! that says to update the app. Contract in `docs/contracts/site.md`.

use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::{SiteError, FORMAT};

/// One format change. `apply` turns a document of format `from` into format `from + 1`;
/// it does not touch `format` itself.
pub struct Step {
    pub from: u32,
    /// What changed, for the person whose file is being upgraded.
    pub summary: &'static str,
    pub apply: fn(&mut Map<String, Value>) -> Result<(), String>,
}

/// The steps from the first format to `FORMAT`, in order. A new format adds one
/// `Step` here and a test with a document of the format before it.
pub const STEPS: &[Step] = &[
    Step { from: 1, summary: "the base map is now a layer, drawn first", apply: basemap_becomes_a_layer },
    Step { from: 2, summary: "every layer in the scene now has its own id", apply: every_layer_has_an_id },
];

/// Format 1 drew the ground, streets and building footprints by itself, under every
/// layer. Format 2 draws only what `layers` lists, so the base map joins the list at
/// the bottom unless the site already has one.
fn basemap_becomes_a_layer(site: &mut Map<String, Value>) -> Result<(), String> {
    let layers = site.entry("layers").or_insert_with(|| Value::Array(Vec::new()));
    let layers = layers.as_array_mut().ok_or("\"layers\" is not a list")?;
    if !layers.iter().any(|layer| layer["use"] == "basemap") {
        layers.insert(0, serde_json::json!({ "use": "basemap", "active": true }));
    }
    Ok(())
}

/// Format 3 lets a layer own items, a sequence refer to layers and a scene use custom
/// layers, all by instance id. Format 2 left the id out when it was the layer's own, so the
/// upgrade writes it into every entry: the id format 2 used, which is what the session's
/// state and the editor already call it.
fn every_layer_has_an_id(site: &mut Map<String, Value>) -> Result<(), String> {
    let Some(layers) = site.get_mut("layers") else { return Ok(()) };
    let layers = layers.as_array_mut().ok_or("\"layers\" is not a list")?;
    for layer in layers {
        let entry = layer.as_object_mut().ok_or("a layer entry is not an object")?;
        if entry.get("id").is_some_and(|id| !id.is_null()) {
            continue;
        }
        let used = entry.get("use").and_then(Value::as_str).ok_or("a layer entry has no \"use\"")?;
        let id = crate::LayerRef::default_id(used).to_string();
        // Keep "use" first and "id" second, so the file still reads well.
        let rest: Vec<(String, Value)> = std::mem::take(entry).into_iter().collect();
        for (key, value) in rest.iter().filter(|(key, _)| key == "use") {
            entry.insert(key.clone(), value.clone());
        }
        entry.insert("id".into(), id.into());
        for (key, value) in rest.into_iter().filter(|(key, _)| key != "use" && key != "id") {
            entry.insert(key, value);
        }
    }
    Ok(())
}

/// What an upgrade did.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Upgrade {
    pub from: u32,
    pub to: u32,
    /// The summary of each step that ran, oldest first.
    pub changes: Vec<String>,
}

/// Brings a parsed `site.json` up to this build's format. `Ok(None)` when it already is.
pub fn upgrade(document: &mut Value) -> Result<Option<Upgrade>, String> {
    upgrade_with(document, STEPS, FORMAT)
}

fn upgrade_with(document: &mut Value, steps: &[Step], target: u32) -> Result<Option<Upgrade>, String> {
    let object = document.as_object_mut().ok_or("site.json must be an object")?;
    let from = object.get("format").and_then(Value::as_u64).ok_or("site.json needs a whole number as \"format\"")?;
    let from = u32::try_from(from).map_err(|_| "\"format\" is not a format number".to_string())?;
    if from > target {
        return Err(format!(
            "this site was saved by a newer MR Studio (site format {from}); this version reads up to format {target}. Update MR Studio to open it."
        ));
    }
    if from == 0 {
        return Err("\"format\" starts at 1".into());
    }
    if from == target {
        return Ok(None);
    }
    let mut changes = Vec::new();
    for format in from..target {
        let step = steps.iter().find(|s| s.from == format).ok_or_else(|| format!("no upgrade from site format {format} is known"))?;
        (step.apply)(object).map_err(|e| format!("upgrading from site format {format}: {e}"))?;
        changes.push(step.summary.to_string());
    }
    object.insert("format".into(), target.into());
    Ok(Some(Upgrade { from, to: target, changes }))
}

/// Core layers that were removed from MR Studio. A table that still uses one opens without
/// it, instead of being refused: the layer and the sequence steps that show it are left out
/// as the site is read (#739). Saving the table then drops them for good.
pub const RETIRED_LAYERS: &[(&str, &str)] = &[("blocks-demo", "the building blocks demo, removed in #739")];

/// Leaves out the layers of `RETIRED_LAYERS` and the steps that show them. Gives a line per
/// layer left out, for the log; empty when the site uses none of them.
pub fn leave_out_retired(document: &mut Value) -> Vec<String> {
    let Some(layers) = document.get_mut("layers").and_then(Value::as_array_mut) else { return Vec::new() };
    let retired = |used: &Value| RETIRED_LAYERS.iter().find(|(id, _)| used == *id).map(|(_, why)| *why);
    let mut gone = Vec::new();
    let mut said = Vec::new();
    layers.retain(|layer| match retired(&layer["use"]) {
        Some(why) => {
            gone.push(layer["id"].as_str().unwrap_or_default().to_string());
            said.push(format!("layer '{}' is left out: it used {why}", layer["id"].as_str().unwrap_or("?")));
            false
        }
        None => true,
    });
    for layer in layers.iter_mut() {
        if let Some(items) = layer.get_mut("items").and_then(Value::as_array_mut) {
            items.retain(|item| match retired(&item["use"]) {
                Some(why) => {
                    gone.push(item["id"].as_str().unwrap_or_default().to_string());
                    said.push(format!("item '{}' is left out: it used {why}", item["id"].as_str().unwrap_or("?")));
                    false
                }
                None => true,
            });
        }
        if let Some(sequence) = layer.pointer_mut("/steps/sequence").and_then(Value::as_array_mut) {
            sequence.retain(|step| !step["layer"].as_str().is_some_and(|l| gone.iter().any(|g| g == l)));
        }
    }
    said
}

/// Upgrades the `site.json` of a site folder on disk. The original is kept beside it as
/// `site.format-<n>.json`. `Ok(None)` when the file is already current, and then nothing is written.
pub fn upgrade_site(dir: &Path) -> Result<Option<Upgrade>, SiteError> {
    let path = dir.join("site.json");
    let io = |source| SiteError::Io { path: path.clone(), source };
    let text = std::fs::read_to_string(&path).map_err(io)?;
    let parse = |message: String| SiteError::Parse { path: path.clone(), message };
    let mut document: Value = serde_json::from_str(&text).map_err(|e| parse(e.to_string()))?;
    let Some(done) = upgrade(&mut document).map_err(parse)? else { return Ok(None) };
    let backup = dir.join(format!("site.format-{}.json", done.from));
    if !backup.exists() {
        crate::files::replace(&backup, &text).map_err(|source| SiteError::Io { path: backup.clone(), source })?;
    }
    let upgraded = serde_json::to_string_pretty(&document).map_err(|e| parse(e.to_string()))? + "\n";
    // In one step (#515): a crash half way leaves the table as it was, not cut off.
    crate::files::replace(&path, upgraded).map_err(io)?;
    Ok(Some(done))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // Two made-up format changes, shaped like real ones: a rename and a new required field.
    const TEST_STEPS: &[Step] = &[
        Step {
            from: 1,
            summary: "\"title\" is now \"name\"",
            apply: |site| {
                let title = site.remove("title").ok_or("no title")?;
                site.insert("name".into(), title);
                Ok(())
            },
        },
        Step {
            from: 2,
            summary: "layers have an id",
            apply: |site| {
                for (n, layer) in site.get_mut("layers").and_then(Value::as_array_mut).into_iter().flatten().enumerate() {
                    let id = format!("{}-{n}", layer["use"].as_str().unwrap_or("layer"));
                    layer.as_object_mut().ok_or("a layer is not an object")?.entry("id").or_insert(id.into());
                }
                Ok(())
            },
        },
    ];

    #[test]
    fn an_old_document_runs_every_step_it_needs() {
        let mut site = json!({ "format": 1, "title": "Old", "layers": [{ "use": "sunlight" }] });
        let done = upgrade_with(&mut site, TEST_STEPS, 3).unwrap().unwrap();
        assert_eq!(site, json!({ "format": 3, "name": "Old", "layers": [{ "use": "sunlight", "id": "sunlight-0" }] }));
        assert_eq!((done.from, done.to, done.changes.len()), (1, 3, 2));

        // One format behind runs only the last step, and a current one is left alone.
        let mut site = json!({ "format": 2, "name": "Mid", "layers": [] });
        assert_eq!(upgrade_with(&mut site, TEST_STEPS, 3).unwrap().unwrap().changes, ["layers have an id"]);
        assert_eq!(upgrade_with(&mut site, TEST_STEPS, 3).unwrap(), None);
    }

    #[test]
    fn a_newer_site_is_refused_with_advice() {
        let mut site = json!({ "format": 4 });
        let error = upgrade_with(&mut site, TEST_STEPS, 3).unwrap_err();
        assert!(error.contains("newer MR Studio") && error.contains("Update MR Studio"), "{error}");
        assert_eq!(site, json!({ "format": 4 }), "nothing is changed");
    }

    #[test]
    fn a_failed_step_and_a_bad_format_are_reported() {
        let mut site = json!({ "format": 1 });
        assert!(upgrade_with(&mut site, TEST_STEPS, 3).unwrap_err().contains("no title"));
        assert!(upgrade_with(&mut json!({}), TEST_STEPS, 3).is_err());
        assert!(upgrade_with(&mut json!({ "format": 0 }), TEST_STEPS, 3).is_err());
        assert!(upgrade_with(&mut json!({ "format": 1, "title": "T" }), &[], 2).unwrap_err().contains("no upgrade"));
    }

    #[test]
    fn format_1_gains_the_base_map_layer() {
        let mut site = json!({ "format": 1, "layers": [{ "use": "sunlight", "active": true }] });
        (STEPS[0].apply)(site.as_object_mut().unwrap()).unwrap();
        assert_eq!(site["layers"], json!([{ "use": "basemap", "active": true }, { "use": "sunlight", "active": true }]));

        // A site that already lists the base map keeps its place and settings, and one without layers gets the list.
        let mut placed = json!({ "format": 1, "layers": [{ "use": "sunlight" }, { "use": "basemap", "active": false }] });
        (STEPS[0].apply)(placed.as_object_mut().unwrap()).unwrap();
        assert_eq!(placed["layers"], json!([{ "use": "sunlight" }, { "use": "basemap", "active": false }]));
        let mut bare = json!({ "format": 1 });
        (STEPS[0].apply)(bare.as_object_mut().unwrap()).unwrap();
        assert_eq!(bare["layers"], json!([{ "use": "basemap", "active": true }]));
    }

    #[test]
    fn format_2_names_every_layer() {
        let mut site = json!({ "format": 2, "layers": [
            { "use": "basemap", "active": true },
            { "use": "cars", "id": "rush-hour", "params": { "density": 30 } },
            { "use": "./layers/artwork/" }
        ] });
        (STEPS[1].apply)(site.as_object_mut().unwrap()).unwrap();
        assert_eq!(
            site["layers"],
            json!([
                { "use": "basemap", "id": "basemap", "active": true },
                { "use": "cars", "id": "rush-hour", "params": { "density": 30 } },
                { "use": "./layers/artwork/", "id": "artwork" }
            ])
        );
        let text = serde_json::to_string(&site["layers"][0]).unwrap();
        assert!(text.starts_with(r#"{"use":"basemap","id":"basemap""#), "use comes first, then id: {text}");
        let mut bare = json!({ "format": 2 });
        (STEPS[1].apply)(bare.as_object_mut().unwrap()).unwrap();
        assert_eq!(bare, json!({ "format": 2 }));
    }

    #[test]
    fn a_format_1_site_reaches_format_3() {
        let mut site = json!({ "format": 1, "layers": [{ "use": "sunlight", "active": true }] });
        let done = upgrade(&mut site).unwrap().unwrap();
        assert_eq!((done.from, done.to, done.changes.len()), (1, 3, 2));
        assert_eq!(
            site["layers"],
            json!([{ "use": "basemap", "id": "basemap", "active": true }, { "use": "sunlight", "id": "sunlight", "active": true }])
        );
    }

    #[test]
    fn the_real_steps_reach_the_current_format_without_gaps() {
        let from: Vec<u32> = STEPS.iter().map(|s| s.from).collect();
        let expected: Vec<u32> = (1..).take_while(|format| *format < FORMAT).collect();
        assert_eq!(from, expected, "exactly one step from each older format, in order");
    }

    #[test]
    fn the_sample_site_is_current_and_is_not_rewritten() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sites/sample");
        assert_eq!(upgrade_site(&sample).unwrap(), None);
    }
    #[test]
    fn a_retired_layer_is_left_out_with_its_steps() {
        let mut site = json!({ "format": 3, "layers": [
            { "use": "basemap", "id": "basemap" },
            { "use": "blocks-demo", "id": "blocks" },
            { "use": "slideshow", "id": "tour", "steps": { "sequence": [{ "layer": "blocks" }, { "layer": "basemap" }] } }
        ]});
        let said = leave_out_retired(&mut site);
        assert_eq!(said.len(), 1, "{said:?}");
        let ids: Vec<_> = site["layers"].as_array().unwrap().iter().map(|l| l["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["basemap", "tour"]);
        assert_eq!(site["layers"][1]["steps"]["sequence"], json!([{ "layer": "basemap" }]));

        let mut current = json!({ "format": 3, "layers": [{ "use": "sunlight", "id": "sun" }] });
        assert!(leave_out_retired(&mut current).is_empty());
    }
}
