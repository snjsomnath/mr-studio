//! `docs/contracts/protocol.schema.json` is what the host writes (#538). Run with
//! `UPDATE_SCHEMA=1` to write it after changing a type the views receive.

use std::path::PathBuf;

#[test]
fn the_checked_in_protocol_schema_is_current() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts/protocol.schema.json");
    let fresh = format!("{}\n", serde_json::to_string_pretty(&mrs_host::protocol_schema()).unwrap());
    if std::env::var_os("UPDATE_SCHEMA").is_some() {
        std::fs::write(&path, &fresh).unwrap();
        return;
    }
    let saved = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        saved == fresh,
        "docs/contracts/protocol.schema.json is not what the host's types say. Run `UPDATE_SCHEMA=1 cargo test -p mrs-host --test protocol_schema` and commit it, then make packages/sdk/src/types.ts agree."
    );
}

#[test]
fn the_contract_numbers_match_the_sdk() {
    let types = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/sdk/src/types.ts")).unwrap();
    let constant = |name: &str| {
        types.lines().find_map(|l| l.strip_prefix(&format!("export const {name} = "))).map(|v| v.trim_end_matches(';').to_string())
    };
    assert_eq!(constant("PROTOCOL"), Some(mrs_host::PROTOCOL.to_string()), "PROTOCOL differs between hub.rs and types.ts");
    assert_eq!(constant("LAYER_API"), Some(mrs_host::layers::LAYER_API.to_string()), "LAYER_API differs between layers.rs and types.ts");
}
