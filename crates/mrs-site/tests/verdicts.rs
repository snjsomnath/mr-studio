//! The verdicts the MCP server must agree with (#537): each site in `fixtures/verdicts.json` is
//! opened as the app opens it, and accepted or refused as the file says. The MCP server runs the
//! same file in packages/mcp/test/verdicts.test.ts.

use serde_json::Value;
use std::path::PathBuf;

/// `base` with each key of `set` put in its place; null removes the key.
fn apply(base: &Value, set: &Value) -> Value {
    let mut site = base.clone();
    for (key, value) in set.as_object().unwrap() {
        if value.is_null() {
            site.as_object_mut().unwrap().remove(key);
        } else {
            site[key] = value.clone();
        }
    }
    site
}

#[test]
fn the_app_and_the_mcp_server_agree_on_every_verdict() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/verdicts.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(fixtures).unwrap()).unwrap();
    let mut wrong = Vec::new();
    for (i, case) in file["cases"].as_array().unwrap().iter().enumerate() {
        let site = apply(&file["base"], &case["set"]);
        let dir = std::env::temp_dir().join(format!("mrs-verdict-{}-{i}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("site.json"), serde_json::to_string_pretty(&site).unwrap()).unwrap();
        let loaded = mrs_site::Site::load(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        let valid = case["valid"].as_bool().unwrap();
        if loaded.is_ok() != valid {
            wrong.push(format!(
                "{}: expected {}, got {:?}",
                case["why"],
                if valid { "valid" } else { "refused" },
                loaded.err().map(|e| e.to_string())
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
