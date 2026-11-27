//! What the hub's tests share: hubs on the sample site and small readers.

use super::*;

pub(super) fn hub(options: SessionOptions) -> Hub {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sites/sample");
    let site = Site::load(dir).unwrap();
    let catalog = crate::layers::load_catalog(&site, &site.dir.join("../../packages/layers"), true).unwrap();
    Hub::new(&site, catalog, 4170, Some("http://10.0.0.5:4170/".into()), options).unwrap()
}

/// A hub on a private copy of the sample site, for tests that edit the scene.
pub(super) fn scratch_hub(name: &str) -> Hub {
    scratch_hub_with(name, |_| {})
}

/// A scratch hub whose copy of the sample site `edit` changes first.
pub(super) fn scratch_hub_with(name: &str, edit: impl FnOnce(&std::path::Path)) -> Hub {
    fn copy(from: &std::path::Path, to: &std::path::Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            if entry.file_name() == ".mrstudio" {
                continue;
            }
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = std::env::temp_dir().join(format!("mrs-hub-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    copy(&root.join("sites/sample"), &dir);
    edit(&dir);
    let site = Site::load(&dir).unwrap();
    let catalog = crate::layers::load_catalog(&site, &root.join("packages/layers"), true).unwrap();
    Hub::new(&site, catalog, 4170, None, SessionOptions::default()).unwrap()
}

pub(super) fn layer(hub: &Hub, id: &str) -> Value {
    hub.welcome(0)["state"]["layers"][id].clone()
}

pub(super) fn slots(hub: &Hub) -> Vec<(usize, bool)> {
    hub.inner.lock().participants().iter().map(|p| (p.slot, p.connected)).collect()
}

pub(super) fn token(hub: &Hub, surface: u64) -> String {
    hub.welcome(surface)["resume"].as_str().unwrap().to_string()
}
