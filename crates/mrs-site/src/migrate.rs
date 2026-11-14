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

/// The steps from the first format to `FORMAT`, in order. Format 1 is the first, so
/// there are none yet. When `FORMAT` becomes 2, add `Step { from: 1, .. }` here and a
/// test with a format 1 document beside the ones below.
pub const STEPS: &[Step] = &[];

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
        std::fs::write(&backup, &text).map_err(|source| SiteError::Io { path: backup.clone(), source })?;
    }
    let upgraded = serde_json::to_string_pretty(&document).map_err(|e| parse(e.to_string()))? + "\n";
    std::fs::write(&path, upgraded).map_err(io)?;
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
}
