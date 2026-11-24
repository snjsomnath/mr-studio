//! Diagnostics you can send (#260): one report of how the running table is doing, to paste
//! into an issue. The desktop app adds what only it knows (the computer, its displays, the
//! end of the app's log) under Help > Copy diagnostics.
//!
//! Nothing secret goes in: keys live in the system keychain and never pass through here, and
//! anything in a log line that looks like a key or a token is blanked by [`redact`].

use std::fmt::Write as _;

use serde_json::{json, Value};

use crate::AppState;

/// Window errors and incidents a report lists at most.
const MOST: usize = 50;

/// The host's part of the report, as data.
pub async fn report(state: &AppState) -> Value {
    let engine = state.engine.info().await.map(|i| json!({ "backend": i.backend, "adapter": i.adapter })).unwrap_or(Value::Null);
    let site = state.hub.site();
    let errors = state.health.errors();
    let errors = &errors[errors.len().saturating_sub(MOST)..];
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "table": { "name": site.name, "id": site.id, "format": state.site.manifest.format },
        "engine": engine,
        "layers": state.hub.layer_health(),
        "windows": state.health.windows(),
        "errors": errors,
        "incidents": state.health.recent_incidents(MOST).into_iter().map(|(at, message)| json!({ "at": at, "message": message })).collect::<Vec<_>>(),
    })
}

/// The report as plain text, for an issue or an email.
pub fn text(report: &Value) -> String {
    let mut out = String::new();
    let s = |v: &Value| v.as_str().map(String::from).unwrap_or_else(|| if v.is_null() { "-".into() } else { v.to_string() });
    let _ = writeln!(out, "MR Studio diagnostics");
    let _ = writeln!(out, "Version: {}", s(&report["version"]));
    let _ = writeln!(out, "System: {}", s(&report["os"]));
    let _ = writeln!(out, "Table: {} ({}), site format {}", s(&report["table"]["name"]), s(&report["table"]["id"]), s(&report["table"]["format"]));
    let _ = writeln!(out, "Engine: {} on {}", s(&report["engine"]["backend"]), s(&report["engine"]["adapter"]));

    let _ = writeln!(out, "\nLayers");
    for layer in report["layers"].as_array().into_iter().flatten() {
        let state = match (&layer["health"], layer["active"].as_bool()) {
            (Value::Object(h), _) => format!("{}: {}", s(&h["status"].clone()), s(&h["reason"].clone())),
            (_, Some(true)) => "on".into(),
            _ => "off".into(),
        };
        let _ = writeln!(out, "  {} ({}): {state}", s(&layer["id"]), s(&layer["layer"]));
    }

    let _ = writeln!(out, "\nWindows");
    let windows = report["windows"].as_array().cloned().unwrap_or_default();
    if windows.is_empty() {
        let _ = writeln!(out, "  none have reported (only presented table and controller windows do)");
    }
    for w in windows {
        let _ = writeln!(out, "  {} ({}): last heard {:.0} s ago, {:.0} fps", s(&w["window"]), s(&w["role"]), w["age"].as_f64().unwrap_or(0.0), w["fps"].as_f64().unwrap_or(0.0));
    }

    let _ = writeln!(out, "\nErrors in the windows");
    let errors = report["errors"].as_array().cloned().unwrap_or_default();
    if errors.is_empty() {
        let _ = writeln!(out, "  none");
    }
    for e in errors {
        let place = match e["layer"].as_str() {
            Some(layer) => format!("{} window, layer '{layer}'", s(&e["role"])),
            None => format!("{} window", s(&e["role"])),
        };
        let times = e["count"].as_u64().filter(|c| *c > 1).map(|c| format!(" (x{c})")).unwrap_or_default();
        let _ = writeln!(out, "  [{}] {place}: {}{times}", clock(e["at"].as_u64().unwrap_or(0)), redact(&s(&e["message"])));
        if let Some(stack) = e["stack"].as_str() {
            for line in stack.lines().take(6) {
                let _ = writeln!(out, "      {}", redact(line.trim()));
            }
        }
    }

    let _ = writeln!(out, "\nIncidents");
    let incidents = report["incidents"].as_array().cloned().unwrap_or_default();
    if incidents.is_empty() {
        let _ = writeln!(out, "  none");
    }
    for i in incidents {
        let _ = writeln!(out, "  [{}] {}", clock(i["at"].as_u64().unwrap_or(0)), redact(&s(&i["message"])));
    }
    out
}

/// A time of day in UTC, from seconds since 1970.
fn clock(at: u64) -> String {
    let day = at % 86_400;
    format!("{:02}:{:02}:{:02} UTC", day / 3600, day % 3600 / 60, day % 60)
}

/// Words after which a log line may carry a secret.
const SECRET_WORDS: [&str; 10] = ["key", "token", "secret", "password", "passwd", "authorization", "bearer", "apikey", "api_key", "access_token"];

/// Blanks anything in a line that looks like a key: the value after `key=`, `token: `,
/// `Authorization: Bearer …` and the like, and long runs of letters and digits.
pub fn redact(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let lower = line.to_ascii_lowercase();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < line.len() {
        // A secret word followed by `=`, `:` or a space starts a value to blank.
        let word = SECRET_WORDS.iter().find(|w| lower[i..].starts_with(**w) && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()));
        if let Some(word) = word {
            let mut j = i + word.len();
            // The rest of a longer word, such as `keys` or `api_key_id`, belongs to the name.
            while j < line.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-') {
                j += 1;
            }
            let name_end = j;
            while j < line.len() && matches!(bytes[j], b'=' | b':' | b' ' | b'"' | b'\'') {
                j += 1;
            }
            // Only `name = value` or `name: value` carries one; `the keys are` does not.
            let separated = line[name_end..j].contains(['=', ':']);
            // `Authorization: Bearer abc`: the scheme is part of the name.
            if lower[j..].starts_with("bearer ") || lower[j..].starts_with("basic ") {
                j += lower[j..].find(' ').unwrap_or(0) + 1;
            }
            let value_end = line[j..].find(|c: char| c.is_whitespace() || matches!(c, '&' | '"' | '\'' | ',' | ';' | ')' | '}')).map_or(line.len(), |n| j + n);
            if separated && value_end > j {
                out.push_str(&line[i..j]);
                out.push_str("[hidden]");
                i = value_end;
                continue;
            }
            out.push_str(&line[i..name_end]);
            i = name_end;
            continue;
        }
        let c = line[i..].chars().next().unwrap();
        // A long run of letters and digits with both in it is most likely a key or a token.
        if c.is_ascii_alphanumeric() && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
            let end = line[i..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).map_or(line.len(), |n| i + n);
            let run = &line[i..end];
            if run.len() >= 32 && run.chars().any(|c| c.is_ascii_digit()) && run.chars().any(|c| c.is_ascii_alphabetic()) {
                out.push_str("[hidden]");
                i = end;
                continue;
            }
            out.push_str(run);
            i = end;
            continue;
        }
        out.push(c);
        i += c.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_blanked_and_the_rest_kept() {
        assert_eq!(redact("GET /tiles?key=abc123&z=3"), "GET /tiles?key=[hidden]&z=3");
        assert_eq!(redact("Authorization: Bearer eyJhbGci.x"), "Authorization: Bearer [hidden]");
        assert_eq!(redact("api_key = \"s3cr3t\""), "api_key = \"[hidden]\"");
        assert_eq!(redact("token: hello world"), "token: [hidden] world");
        assert_eq!(redact("uses 0123456789abcdef0123456789abcdef01 here"), "uses [hidden] here");
        // Words that merely contain a secret word, or name one without a value, stay.
        assert_eq!(redact("monkey business; the keys are in the keychain"), "monkey business; the keys are in the keychain");
        assert_eq!(redact("layer 'trees' failed: HTTP 404"), "layer 'trees' failed: HTTP 404");
        assert_eq!(redact("åäö key"), "åäö key");
    }

    #[test]
    fn the_text_report_lists_layers_errors_and_incidents() {
        let report = json!({
            "version": "0.20.0",
            "os": "macos aarch64",
            "table": { "name": "Lindholmen", "id": "lindholmen", "format": 3 },
            "engine": { "backend": "gpu", "adapter": "Apple M4 Pro" },
            "layers": [
                { "id": "trees", "layer": "trees", "active": true, "health": { "status": "retrying", "reason": "couldn't read trees.geojson (HTTP 404)" } },
                { "id": "sun", "layer": "sunlight", "active": false }
            ],
            "windows": [{ "window": "surface-0-0-table", "role": "table", "age": 1.2, "fps": 59.9 }],
            "errors": [{ "at": 3600, "role": "table", "layer": "trees", "message": "TypeError: x is undefined", "count": 3, "stack": "at a\nat b" }],
            "incidents": [{ "at": 7200, "message": "The engine restarted" }],
        });
        let text = text(&report);
        assert!(text.contains("Table: Lindholmen (lindholmen), site format 3"));
        assert!(text.contains("trees (trees): retrying: couldn't read trees.geojson (HTTP 404)"));
        assert!(text.contains("sun (sunlight): off"));
        assert!(text.contains("[01:00:00 UTC] table window, layer 'trees': TypeError: x is undefined (x3)"));
        assert!(text.contains("[02:00:00 UTC] The engine restarted"));
        assert!(text.contains("surface-0-0-table (table): last heard 1 s ago, 60 fps"));
    }
}
