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
    Ok(dir)
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
            println!("Built {}", dir.join(SITE_LAYER_MODULE).display());
        }
    }
    Ok(())
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
        assert!(new(&site_dir, "energy-flows", None).is_err(), "an existing package is never overwritten");
        assert!(new(&site_dir, "Bad Name", None).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
