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
    for watched in ["packages/runtime/dist", "packages/layers", "sites/sample"] {
        println!("cargo:rerun-if-changed={}", root.join(watched).display());
    }
    tauri_build::build()
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
            write_if_changed(&layers.join(dir.file_name().expect("layer folder name")).join("layer.json"), &fs::read(manifest)?)?;
        }
    }

    // The sample site, so the app has something to show on first start.
    sync_dir(&root.join("sites/sample"), &staged.join("sites/sample"), &|path| {
        !path.components().any(|c| c.as_os_str() == "scene" || c.as_os_str() == "tools")
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
