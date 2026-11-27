//! `docs/contracts/site.schema.json` is what the code writes (#537). Run with `UPDATE_SCHEMA=1`
//! to write it after changing the manifest types.

use std::path::PathBuf;

#[test]
fn the_checked_in_site_schema_is_current() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts/site.schema.json");
    let fresh = format!("{}\n", serde_json::to_string_pretty(&mrs_site::site_schema()).unwrap());
    if std::env::var_os("UPDATE_SCHEMA").is_some() {
        std::fs::write(&path, &fresh).unwrap();
        return;
    }
    let saved = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        saved == fresh,
        "docs/contracts/site.schema.json is not what the manifest types say. Run `UPDATE_SCHEMA=1 cargo test -p mrs-site --test schema`, then `pnpm --filter @mrstudio/mcp site-types`, and commit both."
    );
}

#[test]
fn the_schema_limits_are_the_codes_limits() {
    // The MCP server reads these limits from the schema; the app checks them in LayerButton::problem.
    let schema = mrs_site::site_schema();
    let button = &schema["$defs"]["LayerButton"]["properties"];
    assert_eq!(button["name"]["maxLength"], mrs_site::LayerButton::MAX_NAME);
    assert_eq!(button["group"]["maxLength"], mrs_site::LayerButton::MAX_NAME);
    assert_eq!(button["credit"]["maxLength"], mrs_site::LayerButton::MAX_CREDIT);
    assert_eq!(button["description"]["maxLength"], mrs_site::LayerButton::MAX_DESCRIPTION);
}
