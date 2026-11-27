//! Every command the app registers must also be named in `build.rs` and allowed by a
//! capability file. Tauri refuses a command that is missing from either with "Command …
//! not allowed by ACL", which is how Home's Open a table file broke in 0.54.0: `import_table`
//! was in `generate_handler!` but not in the build manifest.

const MAIN: &str = include_str!("main.rs");
const BUILD: &str = include_str!("../build.rs");
const CAPABILITIES: [&str; 4] = [
    include_str!("../capabilities/default.json"),
    include_str!("../capabilities/editor.json"),
    include_str!("../capabilities/operator.json"),
    include_str!("../capabilities/sources.json"),
];

/// The command names inside `tauri::generate_handler![…]` in main.rs, without their module
/// (`operator_mode::open_operator` is the command `open_operator`).
fn handlers() -> Vec<&'static str> {
    let start = MAIN.find("generate_handler![").expect("main.rs registers its commands") + "generate_handler![".len();
    let end = start + MAIN[start..].find(']').expect("the handler list ends");
    let names: Vec<_> = MAIN[start..end]
        .split(',')
        .map(|path| path.trim().rsplit("::").next().unwrap_or_default())
        .filter(|name| !name.is_empty())
        .collect();
    assert!(names.len() > 40, "found only {} commands; has the handler list changed shape?", names.len());
    names
}

#[test]
fn every_command_is_in_the_build_manifest() {
    let missing: Vec<_> = handlers().into_iter().filter(|name| !BUILD.contains(&format!("\"{name}\""))).collect();
    assert!(missing.is_empty(), "add these to the command list in build.rs: {missing:?}");
}

#[test]
fn every_command_is_allowed_somewhere() {
    let missing: Vec<_> = handlers()
        .into_iter()
        .filter(|name| {
            let permission = format!("\"allow-{}\"", name.replace('_', "-"));
            !CAPABILITIES.iter().any(|file| file.contains(&permission))
        })
        .collect();
    assert!(missing.is_empty(), "allow these in a capabilities/*.json file: {missing:?}");
}
