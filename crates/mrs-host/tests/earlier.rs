//! Tables saved by earlier versions still open (#514). Each `fixtures/earlier/*.json` is a
//! site.json as an earlier MR Studio wrote it; the current host brings it up to date, starts
//! on it, lists its layers and saves a change to it.

use std::path::{Path, PathBuf};

use mrs_engine::Backend;
use mrs_host::HostConfig;
use serde_json::Value;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn copy(from: &Path, to: &Path) {
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

#[tokio::test(flavor = "multi_thread")]
async fn tables_saved_by_earlier_versions_still_open() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/earlier");
    let mut files: Vec<PathBuf> =
        std::fs::read_dir(&fixtures).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    assert!(files.len() >= 3, "the fixtures are gone: {files:?}");
    for file in files {
        let name = file.file_stem().unwrap().to_string_lossy().to_string();
        let dir = std::env::temp_dir().join(format!("mrs-earlier-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        copy(&repo().join("sites/sample"), &dir);
        std::fs::copy(&file, dir.join("site.json")).unwrap();
        let before: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();

        // As the app does when it opens a table: bring it up to date on disk, then start.
        let upgraded = mrs_site::migrate::upgrade_site(&dir).unwrap_or_else(|e| panic!("{name} is not brought up to date: {e}"));
        assert_eq!(upgraded.is_some(), before["format"] != mrs_site::FORMAT, "{name}");
        let host = mrs_host::start(HostConfig {
            site_dir: dir.clone(),
            layers_dir: repo().join("packages/layers"),
            web_dir: None,
            bind: "127.0.0.1:0".parse().unwrap(),
            backend: Backend::Cpu,
            session: Default::default(),
            sources: std::sync::Arc::new(mrs_host::Sources::in_memory()),
            programs: true,
        })
        .await
        .unwrap_or_else(|e| panic!("{name} does not open: {e:#}"));

        // Every layer it had is in the scene, and the base map is there whichever format it came from.
        let info: Value = reqwest::get(format!("http://{}/api/info", host.addr)).await.unwrap().json().await.unwrap();
        assert_eq!(info["site"]["name"], before["name"], "{name}");
        let scene: Vec<String> = host.state.site.manifest.layers.iter().map(|l| l.r#use.clone()).collect();
        for layer in before["layers"].as_array().unwrap() {
            let used = layer["use"].as_str().unwrap();
            assert!(scene.iter().any(|s| s == used), "{name}: the layer '{used}' is gone from {scene:?}");
        }
        assert!(scene.iter().any(|s| s == "basemap"), "{name}");

        // It can be changed and saved, and what is saved opens again.
        let place = mrs_site::Place {
            name: Some("Opened again".into()),
            origin: host.state.site.manifest.origin,
            extent: host.state.site.manifest.extent,
            table_width_cm: None,
            tile_cm: None,
            detail: None,
        };
        host.state.site.place(&place).unwrap_or_else(|e| panic!("{name} cannot be saved: {e}"));
        host.shutdown().await;
        let again = mrs_site::Site::load(&dir).unwrap_or_else(|e| panic!("{name} does not open after a save: {e}"));
        assert_eq!(again.manifest.name, "Opened again");
        assert_eq!(again.manifest.layers.len(), scene.len(), "{name}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
