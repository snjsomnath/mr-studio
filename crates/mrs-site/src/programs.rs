//! The programs a table brings with it (#506): the services the host would start on this
//! computer, and the code of its own layers that every window would run.
//!
//! A table that came from somewhere else (a `.mrstable` by email, a folder from a colleague)
//! is data until someone says its programs may run. The app asks once per table and again
//! when the programs change; this module says what they are and gives them a fingerprint.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::Site;

/// What a table would run on this computer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Programs {
    /// Services with a program to start, as "name (command)".
    pub services: Vec<String>,
    /// The table's own layers that have built code, by folder name.
    pub layers: Vec<String>,
    /// A fingerprint of all of it: the commands, the services' files and the layers' code.
    /// Empty when the table brings no programs.
    pub fingerprint: String,
}

/// A service's file larger than this is fingerprinted by its size alone: a model or a dataset.
const WHOLE_FILE_LIMIT: u64 = 16 * 1024 * 1024;

impl Programs {
    pub fn is_empty(&self) -> bool {
        self.services.is_empty() && self.layers.is_empty()
    }

    /// The programs of the table in `dir`. A table that does not load has none to run.
    pub fn of(dir: &Path) -> Self {
        let Ok(site) = Site::load(dir) else { return Self::default() };
        let mut hash = Sha256::new();
        let mut services = Vec::new();
        for service in &site.manifest.services {
            let Some(run) = &service.run else { continue };
            let name = service.name.clone().unwrap_or_else(|| service.id.clone());
            services.push(format!("{name} ({})", run.command.join(" ")));
            // Everything that decides what is started, then the files it is started among.
            hash.update(
                serde_json::to_vec(&(&service.id, &run.cwd, &run.command, &run.venv, &run.requirements, &run.env)).unwrap_or_default(),
            );
            if let Some(folder) = site.resolve(&run.cwd) {
                let venv = run.venv.as_ref().map(|v| folder.join(v));
                add_folder(&mut hash, &folder, venv.as_deref());
            }
        }
        let mut folders: Vec<PathBuf> =
            site.instances().iter().filter(|(used, _, _)| used.starts_with('.')).filter_map(|(used, _, _)| site.resolve(used)).collect();
        if let Ok(entries) = std::fs::read_dir(dir.join("layers")) {
            folders.extend(entries.filter_map(|e| e.ok()).map(|e| e.path()));
        }
        folders.sort();
        folders.dedup();
        let mut layers = Vec::new();
        for folder in folders {
            let code = folder.join("dist");
            if !code.join("index.js").is_file() {
                continue;
            }
            let name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            hash.update(name.as_bytes());
            add_folder(&mut hash, &code, None);
            layers.push(name);
        }
        let mut programs = Self { services, layers, fingerprint: String::new() };
        if !programs.is_empty() {
            programs.fingerprint = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        }
        programs
    }

    /// The programs in words, one per line, for the question the app asks.
    pub fn lines(&self) -> Vec<String> {
        let services = self.services.iter().map(|s| format!("Service: {s}"));
        let layers = self.layers.iter().map(|l| format!("Layer code: {l}"));
        services.chain(layers).collect()
    }
}

/// Adds every file under `folder` to the fingerprint, by path and content, in a fixed order.
/// What a run leaves behind is left out: the venv, caches and folders that start with a dot.
fn add_folder(hash: &mut Sha256, folder: &Path, venv: Option<&Path>) {
    let mut files = Vec::new();
    let mut waiting = vec![folder.to_path_buf()];
    while let Some(dir) = waiting.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                let left_behind = name.starts_with('.') || name == "__pycache__" || name == "node_modules" || venv == Some(path.as_path());
                if !left_behind {
                    waiting.push(path);
                }
            } else if kind.is_file() && !name.ends_with(".pyc") && !name.ends_with(".log") {
                files.push(path);
            }
        }
    }
    files.sort();
    for file in files {
        let relative = file.strip_prefix(folder).unwrap_or(&file).to_string_lossy().replace('\\', "/");
        hash.update(relative.as_bytes());
        hash.update([0]);
        let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        hash.update(size.to_le_bytes());
        if size <= WHOLE_FILE_LIMIT {
            if let Ok(bytes) = std::fs::read(&file) {
                hash.update(&bytes);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mrs-programs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sites/sample");
        copy(&sample, &dir);
        dir
    }

    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().map(|e| e.unwrap()) {
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &to.join(entry.file_name()));
            } else {
                std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
            }
        }
    }

    fn with_service(dir: &Path, command: &str) {
        let mut site: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("site.json")).unwrap()).unwrap();
        site["services"] = serde_json::json!([{ "id": "calc", "name": "Calculator", "run": { "cwd": "services/calc", "command": ["{python}", command] } }]);
        std::fs::write(dir.join("site.json"), site.to_string()).unwrap();
        std::fs::create_dir_all(dir.join("services/calc")).unwrap();
    }

    #[test]
    fn a_table_of_data_brings_no_programs() {
        let dir = scratch("none");
        let programs = Programs::of(&dir);
        assert!(programs.is_empty() && programs.fingerprint.is_empty());
        // A layer package that was never built is a manifest, not code.
        std::fs::create_dir_all(dir.join("layers/rings")).unwrap();
        std::fs::write(dir.join("layers/rings/layer.json"), "{}").unwrap();
        assert!(Programs::of(&dir).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn services_and_layer_code_are_named_and_a_change_shows() {
        let dir = scratch("some");
        with_service(&dir, "server.py");
        std::fs::write(dir.join("services/calc/server.py"), "print('hello')").unwrap();
        std::fs::create_dir_all(dir.join("layers/rings/dist")).unwrap();
        std::fs::write(dir.join("layers/rings/dist/index.js"), "export default {}").unwrap();

        let first = Programs::of(&dir);
        assert_eq!(first.lines(), ["Service: Calculator ({python} server.py)", "Layer code: rings"]);
        assert_eq!(first.fingerprint.len(), 64);
        assert_eq!(Programs::of(&dir), first, "the same table has the same fingerprint");

        // What running leaves behind changes nothing.
        std::fs::create_dir_all(dir.join("services/calc/__pycache__")).unwrap();
        std::fs::write(dir.join("services/calc/__pycache__/server.pyc"), "x").unwrap();
        std::fs::create_dir_all(dir.join("services/calc/.cache")).unwrap();
        std::fs::write(dir.join("services/calc/.cache/a"), "x").unwrap();
        assert_eq!(Programs::of(&dir).fingerprint, first.fingerprint);

        // The program's own file, the command and a layer's code each do.
        std::fs::write(dir.join("services/calc/server.py"), "print('other')").unwrap();
        let edited = Programs::of(&dir).fingerprint;
        assert_ne!(edited, first.fingerprint);
        with_service(&dir, "other.py");
        let renamed = Programs::of(&dir).fingerprint;
        assert_ne!(renamed, edited);
        std::fs::write(dir.join("layers/rings/dist/index.js"), "export default { a: 1 }").unwrap();
        assert_ne!(Programs::of(&dir).fingerprint, renamed);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
