//! Which MR Studio a table was made with (#509).
//!
//! `site.json` says which format it is in, and the format changes only when something breaks.
//! Between two format changes the app gains layers, widgets and settings, and a table that uses
//! them does not open in an app from before. So a table carries the version of the newest app
//! that changed it, in a one-line file beside site.json, and an older app that meets it says
//! which version to install instead of reporting whatever it tripped over first.
//!
//! The version is not in site.json: apps from before this file refuse a site.json with a key
//! they do not know, and would then open no table a newer app had touched.

use std::path::Path;

/// The file beside `site.json`: one line, such as `0.50.0`.
pub const FILE: &str = "mrstudio.version";
/// This build.
pub const THIS: &str = env!("CARGO_PKG_VERSION");

/// `0.50.1`, `v0.50` or `>=0.50` as numbers. A missing part is 0.
pub fn parse(text: &str) -> Option<(u64, u64, u64)> {
    let text = text.trim().trim_start_matches(">=").trim().trim_start_matches('v');
    let mut parts = text.split('.').map(|part| part.parse::<u64>().ok());
    let major = parts.next()??;
    let minor = parts.next().unwrap_or(Some(0))?;
    let patch = parts.next().unwrap_or(Some(0))?;
    parts.next().is_none().then_some((major, minor, patch))
}

/// Whether `wanted` is from a later release line than this build. A later patch of the same
/// minor version adds nothing a table can use, so it is not newer.
pub fn is_newer(wanted: &str) -> bool {
    is_newer_than(wanted, THIS)
}

fn is_newer_than(wanted: &str, this: &str) -> bool {
    match (parse(wanted), parse(this)) {
        (Some(wanted), Some(this)) => (wanted.0, wanted.1) > (this.0, this.1),
        _ => false,
    }
}

/// `0.50.3` as people say it: `0.50`.
pub fn short(version: &str) -> String {
    parse(version).map(|(major, minor, _)| format!("{major}.{minor}")).unwrap_or_else(|| version.trim().to_string())
}

/// The version the table in `dir` was last changed with, if it says.
pub fn made_with(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(FILE)).ok()?;
    let line = text.lines().next()?.trim();
    parse(line).map(|_| line.to_string())
}

/// The version a table needs when that is newer than this build.
pub fn needs_newer(dir: &Path) -> Option<String> {
    made_with(dir).filter(|version| is_newer(version))
}

/// Marks the table as changed by this build. A table a newer app changed keeps that mark.
pub fn stamp(dir: &Path) {
    stamp_with(dir, THIS);
}

/// Marks the table as made with `version`, unless it already names that release line or a
/// later one.
pub fn stamp_with(dir: &Path, version: &str) {
    if parse(version).is_none() {
        return;
    }
    let current = made_with(dir);
    if current.as_deref().is_some_and(|current| !is_newer_than(version, current)) {
        return;
    }
    // A folder that cannot be written keeps working; it only says less to an older app.
    let _ = std::fs::write(dir.join(FILE), format!("{}\n", version.trim()));
}

/// What to tell someone whose app is older than the table.
pub fn update_message(needed: &str) -> String {
    format!(
        "This table was made with MR Studio {}. This computer has {}. Update MR Studio on this computer to {} or newer.",
        short(needed),
        short(THIS),
        short(needed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_release_line() {
        assert_eq!(parse("0.50.1"), Some((0, 50, 1)));
        assert_eq!(parse(">=0.50"), Some((0, 50, 0)));
        assert_eq!(parse("v1"), Some((1, 0, 0)));
        assert_eq!(parse("soon"), None);
        assert_eq!(parse("1.2.3.4"), None);
        assert!(is_newer_than("0.51.0", "0.50.9"));
        assert!(is_newer_than("1.0", "0.99.0"));
        assert!(!is_newer_than("0.50.9", "0.50.0"), "a patch adds nothing a table can use");
        assert!(!is_newer_than("0.49.0", "0.50.0"));
        assert!(!is_newer_than("nonsense", "0.50.0"));
        assert_eq!(short("0.50.3"), "0.50");
    }

    #[test]
    fn a_table_keeps_the_newest_version_that_changed_it() {
        let dir = std::env::temp_dir().join(format!("mrs-version-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(made_with(&dir), None);
        assert_eq!(needs_newer(&dir), None);
        stamp(&dir);
        assert_eq!(made_with(&dir).as_deref(), Some(THIS));
        stamp_with(&dir, "999.2.0");
        assert_eq!(needs_newer(&dir).as_deref(), Some("999.2.0"));
        stamp(&dir);
        assert_eq!(made_with(&dir).as_deref(), Some("999.2.0"), "an older app does not lower it");
        assert!(update_message("999.2.0").contains("made with MR Studio 999.2"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A table that uses something from a later version says "update", not what it tripped over.
    #[test]
    fn a_table_this_version_cannot_read_says_which_version_to_install() {
        let dir = std::env::temp_dir().join(format!("mrs-version-newer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sample = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/site/site.json");
        let mut site: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(sample).unwrap()).unwrap();
        site["hologram"] = serde_json::json!({ "on": true });
        std::fs::write(dir.join("site.json"), site.to_string()).unwrap();
        let plain = crate::Site::load(&dir).unwrap_err().to_string();
        assert!(plain.contains("hologram") && !plain.contains("Update MR Studio"), "{plain}");
        std::fs::write(dir.join(FILE), "999.2.0\n").unwrap();
        let said = crate::Site::load(&dir).unwrap_err();
        assert!(matches!(said, crate::SiteError::Newer { .. }), "{said}");
        let said = said.to_string();
        assert!(said.starts_with("This table was made with MR Studio 999.2. This computer has"), "{said}");
        assert!(said.contains("Update MR Studio on this computer to 999.2 or newer") && said.contains("hologram"), "{said}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
