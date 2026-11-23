//! No key, token or password lands in the repository (#41, #111). Keys belong in the Sources
//! manager, which keeps them in the operating system's keychain. This looks through every file
//! git tracks for the shapes keys come in, and for a committed `sources.json`.

use std::path::PathBuf;
use std::process::Command;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A run of at least `min` characters a key is made of, starting at `from`.
fn keyish(text: &str, from: usize, min: usize) -> bool {
    text[from..].chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).count() >= min
}

fn problems_in(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    // Mapbox tokens: pk.eyJ… (public) and sk.eyJ… (secret).
    for prefix in ["pk.eyJ", "sk.eyJ"] {
        for (at, _) in text.match_indices(prefix) {
            if keyish(text, at, 40) {
                found.push(format!("a Mapbox token ({prefix}…)"));
            }
        }
    }
    // A key written into an address: ?access_token=…, &api_key=…, &apikey=…, &key=….
    for name in ["access_token=", "api_key=", "apikey=", "token=", "key="] {
        for (at, _) in text.match_indices(name) {
            let before = text[..at].chars().last();
            if matches!(before, Some('?') | Some('&')) && keyish(text, at + name.len(), 24) {
                found.push(format!("a key in an address ({name}…)"));
            }
        }
    }
    found
}

#[test]
fn no_key_is_committed() {
    let listed = Command::new("git").args(["ls-files", "-z"]).current_dir(repo()).output();
    let Some(listed) = listed.ok().filter(|o| o.status.success()) else {
        eprintln!("not a git checkout; nothing to look through");
        return;
    };
    let mut problems = Vec::new();
    for name in String::from_utf8_lossy(&listed.stdout).split('\0').filter(|n| !n.is_empty()) {
        if name.rsplit('/').next() == Some("sources.json") && !name.contains("/capabilities/") {
            problems.push(format!("{name}: a sources list belongs in the app's config folder, not the repository"));
        }
        // This file holds made-up keys to check the check.
        if name == "crates/mrs-host/tests/no_keys.rs" {
            continue;
        }
        let path = repo().join(name);
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if bytes.len() > 4 * 1024 * 1024 || bytes.contains(&0) {
            continue;
        }
        for problem in problems_in(&String::from_utf8_lossy(&bytes)) {
            problems.push(format!("{name}: {problem}"));
        }
    }
    assert!(problems.is_empty(), "keys belong in Sources, not in the repository:\n{}", problems.join("\n"));
}

#[test]
fn the_check_knows_a_key_when_it_sees_one() {
    assert!(!problems_in("https://api.mapbox.com/tiles?access_token=pk.eyJ1IjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo").is_empty());
    assert!(!problems_in("tile.example.org/{z}/{x}/{y}.png?api_key=0123456789abcdef0123456789abcdef").is_empty());
    assert!(problems_in("auth: Query, param: \"access_token\", key=value").is_empty());
}
