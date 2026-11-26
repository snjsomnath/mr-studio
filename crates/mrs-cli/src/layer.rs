//! `mrstudio layer new` and `mrstudio layer build`: a site's own code layers (#277).
//! Contract in docs/contracts/layer.md, "Site layers".

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context};
use mrs_host::layers::{SITE_LAYERS, SITE_LAYER_MODULE};

/// The files of a new layer package, from `templates/layer`. `__ID__` and `__NAME__` are filled in.
const TEMPLATE: [(&str, &str); 8] = [
    ("layer.json", include_str!("../templates/layer/layer.json")),
    ("src/index.ts", include_str!("../templates/layer/src/index.ts")),
    ("locales/sv.json", include_str!("../templates/layer/locales/sv.json")),
    ("build.mjs", include_str!("../templates/layer/build.mjs")),
    ("package.json", include_str!("../templates/layer/package.json")),
    ("README.md", include_str!("../templates/layer/README.md")),
    (".gitignore", include_str!("../templates/layer/gitignore")),
    ("tsconfig.json", include_str!("../templates/layer/tsconfig.json")),
];

/// The display name a layer id stands for: `energy-flows` is "Energy flows".
fn name_for(id: &str) -> String {
    let words = id.replace('-', " ");
    let mut chars = words.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

/// Writes `<site>/layers/<id>/` from the template. Returns the folder.
pub fn new(site: &Path, id: &str, name: Option<&str>) -> anyhow::Result<PathBuf> {
    if !mrs_site::is_instance_id(id) {
        bail!("'{id}' must be lowercase letters, digits and dashes, like energy-flows");
    }
    if !site.join("site.json").is_file() {
        bail!("{} has no site.json; pass the site folder with --site", site.display());
    }
    let dir = site.join(SITE_LAYERS).join(id);
    if dir.exists() {
        bail!("{} already exists", dir.display());
    }
    let name = name.map(str::to_string).unwrap_or_else(|| name_for(id));
    // The name goes into JSON files, so it is written as JSON would write it, without the quotes.
    let quoted = serde_json::to_string(&name)?;
    let json_name = &quoted[1..quoted.len() - 1];
    for (file, text) in TEMPLATE {
        let path = dir.join(file);
        std::fs::create_dir_all(path.parent().unwrap())?;
        let filled = text.replace("__ID__", id).replace("__NAME__", if file.ends_with(".json") { json_name } else { &name });
        std::fs::write(&path, filled).with_context(|| format!("writing {}", path.display()))?;
    }
    write_sdk_types(&dir)?;
    Ok(dir)
}

/// Where a layer package keeps the SDK's types (#508).
const SDK_TYPES_FILE: &str = "types/mrstudio-sdk.d.ts";
/// Every declaration of `@mrstudio/sdk` as this app has it, written by `pnpm --filter @mrstudio/sdk types`.
const SDK_TYPES: &str = include_str!("../templates/layer/types/mrstudio-sdk.d.ts");

/// Puts this app's SDK types into the package, so an editor and `tsc` know `@mrstudio/sdk`
/// in a repository that has nothing of MR Studio in it (#508). A package from before gets
/// its `tsconfig.json` pointed at them.
fn write_sdk_types(dir: &Path) -> anyhow::Result<()> {
    let path = dir.join(SDK_TYPES_FILE);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(SDK_TYPES) {
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, SDK_TYPES).with_context(|| format!("writing {}", path.display()))?;
    }
    let config = dir.join("tsconfig.json");
    let Ok(text) = std::fs::read_to_string(&config) else { return Ok(()) };
    // Only a tsconfig that is plain JSON with a list to add to is changed; one written by hand
    // with comments is left as it is.
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else { return Ok(()) };
    let Some(include) = value["include"].as_array_mut() else { return Ok(()) };
    if !include.iter().any(|entry| entry.as_str().is_some_and(|e| e == "types" || e.starts_with("types/"))) {
        include.push("types".into());
        std::fs::write(&config, serde_json::to_string_pretty(&value)? + "\n").with_context(|| format!("writing {}", config.display()))?;
    }
    Ok(())
}

/// The site's layer packages, or the one named.
fn packages(site: &Path, only: Option<&str>) -> anyhow::Result<Vec<PathBuf>> {
    let root = site.join(SITE_LAYERS);
    if let Some(id) = only {
        let dir = root.join(id);
        if !dir.join("layer.json").is_file() {
            bail!("{} is not a layer package (no layer.json)", dir.display());
        }
        return Ok(vec![dir]);
    }
    let mut found: Vec<PathBuf> = match std::fs::read_dir(&root) {
        Ok(entries) => entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.join("build.mjs").is_file()).collect(),
        Err(_) => Vec::new(),
    };
    found.sort();
    if found.is_empty() {
        bail!("{} has no layer packages to build; make one with `mrstudio layer new <id> --site {}`", root.display(), site.display());
    }
    Ok(found)
}

/// A Node tool by name: `npm` is `npm.cmd` on Windows.
fn tool(name: &str) -> Command {
    if cfg!(windows) && name == "npm" {
        Command::new("npm.cmd")
    } else {
        Command::new(name)
    }
}

fn run(mut command: Command, dir: &Path, what: &str) -> anyhow::Result<()> {
    let status = command
        .current_dir(dir)
        .status()
        .with_context(|| format!("could not run {what}: building a layer needs Node 20 or newer (https://nodejs.org) on this computer"))?;
    if !status.success() {
        bail!("{what} failed in {}", dir.display());
    }
    Ok(())
}

/// Bundles each package's `src/index.ts` into `dist/index.js` with its own `build.mjs`,
/// installing esbuild first when the package has not got it yet.
pub fn build(site: &Path, only: Option<&str>, watch: bool) -> anyhow::Result<()> {
    let dirs = packages(site, only)?;
    if watch && dirs.len() > 1 {
        bail!("--watch builds one layer: name it, for example `mrstudio layer build my-layer --watch`");
    }
    for dir in dirs {
        write_sdk_types(&dir)?;
        if !dir.join("node_modules/esbuild").is_dir() {
            let mut install = tool("npm");
            install.args(["install", "--no-audit", "--no-fund"]);
            run(install, &dir, "npm install")?;
        }
        let mut node = tool("node");
        node.arg("build.mjs");
        if watch {
            node.arg("--watch");
        }
        run(node, &dir, "node build.mjs")?;
        if !watch {
            requires_this_app(&dir)?;
            println!("Built {}", dir.join(SITE_LAYER_MODULE).display());
        }
    }
    Ok(())
}

/// Writes into `layer.json` that the layer needs this MR Studio or newer (#509): it was built
/// against this SDK, and an older app says "update" instead of failing inside the layer.
/// A layer that already asks for a newer one keeps that.
fn requires_this_app(dir: &Path) -> anyhow::Result<()> {
    use mrs_site::version;
    let path = dir.join("layer.json");
    let text = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let mut manifest: serde_json::Value = serde_json::from_str(&text).with_context(|| format!("{} is not JSON", path.display()))?;
    let wanted = format!(">={}", version::short(version::THIS));
    let current = manifest["requires"]["app"].as_str().unwrap_or_default();
    let keep = version::parse(current).is_some_and(|c| Some((c.0, c.1)) >= version::parse(&wanted).map(|w| (w.0, w.1)));
    if keep {
        return Ok(());
    }
    if !manifest["requires"].is_object() {
        manifest["requires"] = serde_json::json!({});
    }
    manifest["requires"]["app"] = wanted.into();
    std::fs::write(&path, serde_json::to_string_pretty(&manifest)? + "\n").with_context(|| format!("writing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_writes_a_package_the_host_reads() {
        let tmp = std::env::temp_dir().join(format!("mrs-layer-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let site_dir = tmp.join("site");
        std::fs::create_dir_all(&site_dir).unwrap();
        std::fs::copy(repo.join("sites/sample/site.json"), site_dir.join("site.json")).unwrap();
        let dir = new(&site_dir, "energy-flows", None).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("layer.json")).unwrap()).unwrap();
        assert_eq!(manifest["id"], "energy-flows");
        assert_eq!(manifest["name"], "Energy flows");
        assert!(mrs_host::layers::LayerDef::parse(manifest).is_ok());
        // The SDK's types come with the package, and one made before them gets them (#508).
        assert_eq!(std::fs::read_to_string(dir.join(SDK_TYPES_FILE)).unwrap(), SDK_TYPES);
        assert!(SDK_TYPES.contains("declare module \"@mrstudio/sdk\"") && SDK_TYPES.contains("export function defineLayer"));
        std::fs::remove_dir_all(dir.join("types")).unwrap();
        std::fs::write(dir.join("tsconfig.json"), r#"{ "compilerOptions": { "strict": true }, "include": ["src"] }"#).unwrap();
        write_sdk_types(&dir).unwrap();
        assert!(dir.join(SDK_TYPES_FILE).is_file());
        let config: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("tsconfig.json")).unwrap()).unwrap();
        assert_eq!(config["include"], serde_json::json!(["src", "types"]));
        // A build says which MR Studio the layer needs, and never lowers what it asks for (#509).
        requires_this_app(&dir).unwrap();
        let read = || serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(dir.join("layer.json")).unwrap()).unwrap();
        assert_eq!(read()["requires"]["app"], format!(">={}", mrs_site::version::short(mrs_site::version::THIS)));
        assert!(mrs_host::layers::LayerDef::parse(read()).is_ok());
        let mut newer = read();
        newer["requires"]["app"] = ">=999.1".into();
        std::fs::write(dir.join("layer.json"), newer.to_string()).unwrap();
        requires_this_app(&dir).unwrap();
        assert_eq!(read()["requires"]["app"], ">=999.1");
        assert!(new(&site_dir, "energy-flows", None).is_err(), "an existing package is never overwritten");
        assert!(new(&site_dir, "Bad Name", None).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
