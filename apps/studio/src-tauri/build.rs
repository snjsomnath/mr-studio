//! Stages what the app ships with into `staged/` (the built surfaces, the layer manifests
//! and the sample site), then runs the Tauri build. `tauri.conf.json` bundles `staged/` as
//! resources, so a plain `cargo build -p mr-studio-app` is always self-contained.

use std::fs;
use std::io;
use std::path::Path;

fn main() {
    let app = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = app.join("../../..");
    let staged = app.join("staged");
    stage(&root, &staged).expect("staging the app's resources");
    for watched in ["packages/runtime/dist", "packages/layers", "sites/sample", "target/third-party-notices.json"] {
        println!("cargo:rerun-if-changed={}", root.join(watched).display());
    }
    // The updater's public key is compiled in; see src/updates.rs.
    println!("cargo:rerun-if-env-changed=MRS_UPDATER_PUBKEY");
    // Naming the commands makes each one a permission, so a window can only call the ones
    // its capability file lists (`capabilities/`). The editor window gets a short list.
    let commands = tauri_build::AppManifest::new().commands(&[
        "launcher_state",
        "add_site",
        "remove_site",
        "delete_table",
        "duplicate_table",
        "import_table",
        "take_opened_file",
        "update_waiting_now",
        "starter_pack",
        "identify",
        "start",
        "open_site",
        "open_site_read_only",
        "create_site",
        "present",
        "stop_presenting",
        "presenting_state",
        "save_displays",
        "save_settings",
        "open_home",
        "open_settings",
        "open_view",
        "new_table",
        "quit",
        "colour_state",
        "set_colour",
        "set_size",
        "save_preset",
        "delete_preset",
        "test_card",
        "set_layer_intensity",
        "calibration_state",
        "calibration_mode",
        "calibration_clear",
        "update_state",
        "check_updates",
        "set_update_check",
        "install_update",
        "dismiss_whats_new",
        "open_link",
        "file_action",
        "table_details",
        "recordings_list",
        "recording_update",
        "recording_delete",
        "recording_reveal",
        "recording_open",
        "table_from_git",
        "table_git_state",
        "table_git_update",
        "recording_import",
        "recording_export",
        "open_sources",
        "cli_state",
        "install_cli",
        "remove_cli",
        "sources_page",
        "sources_save",
        "sources_remove",
        "sources_test",
        "open_operator_log",
        "diagnostics_report",
        "save_diagnostics",
        "open_operator",
        "operator_state",
        "operator_present",
        "operator_restart_screens",
        "operator_set_pin",
        "operator_exit",
        "operator_password",
        "set_operator_start",
        "licence_state",
        "licence_set_use",
        "licence_add",
        "licence_remove",
        "licence_notices",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands)).expect("the Tauri build step");
}

fn stage(root: &Path, staged: &Path) -> io::Result<()> {
    // The surfaces. Build them first with `pnpm build`; without them the app still runs
    // and says what is missing.
    let dist = root.join("packages/runtime/dist");
    let web = staged.join("web");
    if dist.join("index.html").exists() {
        sync_dir(&dist, &web, &|path| path.extension().is_none_or(|e| e != "map"))?;
    } else {
        println!("cargo:warning=packages/runtime/dist is missing; run `pnpm build` before building the app");
        let _ = fs::remove_dir_all(&web);
        write_if_changed(
            &web.join("index.html"),
            b"<!doctype html><meta charset=\"utf-8\"><title>MR Studio</title><body style=\"font:16px system-ui;background:#0b0e14;color:#e6e9ef;padding:3rem\">The surfaces were not built into this copy of MR Studio. Run <code>pnpm build</code> and build the app again.",
        )?;
    }

    // The host only reads each layer's manifest; the layer code is inside the surfaces bundle.
    let layers = staged.join("layers");
    let _ = fs::remove_dir_all(&layers);
    for entry in fs::read_dir(root.join("packages/layers"))? {
        let dir = entry?.path();
        let manifest = dir.join("layer.json");
        if manifest.exists() {
            let staged_layer = layers.join(dir.file_name().expect("layer folder name"));
            write_if_changed(&staged_layer.join("layer.json"), &fs::read(manifest)?)?;
            // The layer's words in other languages (#80), merged into the manifest by the host.
            if dir.join("locales").is_dir() {
                sync_dir(&dir.join("locales"), &staged_layer.join("locales"), &|path| path.extension().is_some_and(|e| e == "json"))?;
            }
        }
    }

    // The open-source notices (#730), when scripts/third-party-notices.mjs has made them.
    // Release builds run it first; a plain build goes without and says so on the Licence page.
    // They are bundled as the `notices` folder, which always exists so the bundle step finds it.
    let notices = root.join("target/third-party-notices.json");
    let staged_notices = staged.join("notices");
    if notices.exists() {
        write_if_changed(&staged_notices.join("third-party-notices.json"), &fs::read(notices)?)?;
        let _ = fs::remove_file(staged_notices.join("README.txt"));
    } else {
        let _ = fs::remove_file(staged_notices.join("third-party-notices.json"));
        write_if_changed(
            &staged_notices.join("README.txt"),
            b"Run scripts/third-party-notices.mjs before building to bundle the open-source notices.\n",
        )?;
    }

    // The sample site, so the app has something to show on first start.
    sync_dir(&root.join("sites/sample"), &staged.join("sites/sample"), &|path| {
        !path.components().any(|c| c.as_os_str() == "scene" || c.as_os_str() == "tools" || c.as_os_str() == ".mrstudio")
    })
}

/// Makes `to` a copy of `from`, touching only files whose content changed so that
/// nothing downstream rebuilds without a reason.
fn sync_dir(from: &Path, to: &Path, keep: &dyn Fn(&Path) -> bool) -> io::Result<()> {
    let mut wanted = Vec::new();
    collect(from, from, keep, &mut wanted)?;
    for relative in &wanted {
        write_if_changed(&to.join(relative), &fs::read(from.join(relative))?)?;
    }
    let mut present = Vec::new();
    if to.exists() {
        collect(to, to, &|_| true, &mut present)?;
    }
    for stale in present.iter().filter(|p| !wanted.contains(p)) {
        fs::remove_file(to.join(stale))?;
    }
    Ok(())
}

fn collect(base: &Path, dir: &Path, keep: &dyn Fn(&Path) -> bool, out: &mut Vec<std::path::PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let relative = path.strip_prefix(base).expect("inside base").to_path_buf();
        if !keep(&relative) {
            continue;
        }
        if path.is_dir() {
            collect(base, &path, keep, out)?;
        } else {
            out.push(relative);
        }
    }
    Ok(())
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if fs::read(path).is_ok_and(|current| current == bytes) {
        return Ok(());
    }
    fs::create_dir_all(path.parent().expect("file in a folder"))?;
    fs::write(path, bytes)
}
