//! The File menu: New, Open, Save, Save As, Show in folder, Close table, All tables (#130).
//!
//! A table is saved as it is edited (every change is a request to the host that rewrites
//! `site.json`), so Save confirms that rather than writing anything. Save As copies the
//! table's folder under a new name and opens the copy, as Save As does in Photoshop.
//!
//! On macOS the menu is the app's menu bar. On Windows and Linux it is a menu bar on the
//! editor window only: the table, TV and phone windows never show one.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Context;
use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime, Wry};

/// The actions, as menu item ids and as the editor page names them.
pub const ACTIONS: [&str; 9] = ["new", "open", "save", "save_as", "export", "reveal", "close", "home", "settings"];

/// MR Studio > Install command line tool… on macOS, File on Windows and Linux (#370).
pub const INSTALL_CLI: &str = "install-cli";

/// The File submenu.
fn file_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let item = |id: &str, text: &str, keys: Option<&str>| -> tauri::Result<MenuItem<R>> {
        let builder = MenuItemBuilder::with_id(id, text);
        match keys {
            Some(keys) => builder.accelerator(keys).build(app),
            None => builder.build(app),
        }
    };
    let reveal = if cfg!(target_os = "macos") { "Show in Finder" } else { "Show in Explorer" };
    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New table…", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Open…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save_as", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        // One .mrstable file to take to another computer (#85).
        .item(&item("export", "Export table…", None)?)
        .item(&item("reveal", reveal, None)?)
        .separator()
        // This table's own settings, in the editor (#73); app settings are MR Studio > Settings.
        .item(&item("table-settings", "Table settings…", None)?)
        .separator()
        .item(&item("close", "Close table", Some("CmdOrCtrl+W"))?)
        .item(&item("home", "All tables", Some("CmdOrCtrl+Shift+H"))?);
    if !cfg!(target_os = "macos") {
        // On macOS these live in the app menu, where people look for them.
        file = file
            .separator()
            .item(&item("settings", "Settings…", Some("Ctrl+,"))?)
            .item(&item(INSTALL_CLI, "Install command line tool…", None)?)
            .item(&PredefinedMenuItem::quit(app, Some("Exit"))?);
    }
    file.build()
}

/// The whole menu bar for macOS: the app menu, File, Edit (without it copy and paste do not
/// work in a webview there), View and Window.
pub fn app_menu(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let name = app.package_info().name.clone();
    // App settings: this computer, every table (#73). Table settings are in the File menu.
    let settings = MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(app)?;
    let app_menu = SubmenuBuilder::new(app, &name)
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&settings)
        .item(&MenuItemBuilder::with_id(INSTALL_CLI, "Install command line tool…").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&edit_item(app, "undo")?)
        .item(&edit_item(app, "redo")?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").item(&PredefinedMenuItem::fullscreen(app, None)?).build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some("Close window"))?)
        .build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file_submenu(app)?, &edit, &view, &window, &help_submenu(app)?]).build()
}

/// The Help menu (#260): a report of how the table and this computer are doing, to send with
/// a problem, and the folder with the logs. Handled in `diagnostics.rs`.
fn help_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("copy-diagnostics", "Copy diagnostics").build(app)?)
        .item(&MenuItemBuilder::with_id("save-diagnostics", "Save diagnostics…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("open-logs", "Open log folder").build(app)?)
        .build()
}

/// The menu bar of the editor window on Windows and Linux.
pub fn editor_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let edit = SubmenuBuilder::new(app, "Edit").item(&edit_item(app, "undo")?).item(&edit_item(app, "redo")?).build()?;
    MenuBuilder::new(app).item(&file_submenu(app)?).item(&edit).item(&help_submenu(app)?).build()
}

/// The Edit menu's own items (#57).
/// Also "Table settings…" from the File menu, which the editor page opens.
pub const EDIT_ACTIONS: [&str; 3] = ["undo", "redo", "table-settings"];

/// Undo and Redo go to the editor page, which undoes the text being typed, or else the last
/// change to the table through the host's revision history (#72). The system's own items
/// would only reach the text.
fn edit_item<R: Runtime>(app: &AppHandle<R>, id: &str) -> tauri::Result<MenuItem<R>> {
    let (text, keys) = match id {
        "undo" => ("Undo", "CmdOrCtrl+Z"),
        _ if cfg!(target_os = "macos") => ("Redo", "CmdOrCtrl+Shift+Z"),
        _ => ("Redo", "Ctrl+Y"),
    };
    MenuItemBuilder::with_id(id, text).accelerator(keys).build(app)
}

/// Sends Undo or Redo from the Edit menu to the editor page.
pub fn tell_editor_edit<R: Runtime>(app: &AppHandle<R>, label: &str, action: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let detail = serde_json::json!({ "action": action });
        let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('mrs-edit', {{ detail: {detail} }}))"));
    }
}

/// The same action can arrive twice: from the menu's shortcut and from the page, which
/// also listens for the keys (a webview does not always pass them on to the menu).
pub struct Debounce(Mutex<Option<(String, Instant)>>);

impl Debounce {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// True when `action` should run: it is not a repeat of the same action within a moment.
    pub fn allow(&self, action: &str) -> bool {
        let mut last = self.0.lock().unwrap();
        let now = Instant::now();
        let repeat = last.as_ref().is_some_and(|(a, at)| a == action && now.duration_since(*at) < Duration::from_millis(600));
        *last = Some((action.to_string(), now));
        !repeat
    }
}

/// The folder name and display name for a copy saved at `target`: the name typed in the
/// save dialog, without an extension the dialog may have added.
pub fn name_from(target: &Path) -> Option<String> {
    let name = target.file_name()?.to_string_lossy().trim().to_string();
    let name = name.strip_suffix(".json").or_else(|| name.strip_suffix(".mrstable")).unwrap_or(&name).trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// Copies the table in `from` to the new folder `to`, named `name`, and gives the copy its
/// own id. The revision history and a git repository stay with the original.
pub fn copy_table(from: &Path, to: &Path, name: &str) -> anyhow::Result<()> {
    let id = mrs_site::create::id_from(name);
    anyhow::ensure!(!id.is_empty(), "Give the table a name with at least one letter or digit.");
    anyhow::ensure!(from.join("site.json").is_file(), "{} is not a table", from.display());
    if to.exists() {
        let empty = std::fs::read_dir(to).map(|mut d| d.next().is_none()).unwrap_or(false);
        anyhow::ensure!(empty, "{} already exists. Choose another name.", to.display());
    }
    anyhow::ensure!(!to.starts_with(from), "A table cannot be saved inside itself. Choose a place outside {}.", from.display());
    copy_dir(from, to).with_context(|| format!("copying the table to {}", to.display()))?;
    let path = to.join("site.json");
    let written = (|| -> anyhow::Result<()> {
        let mut site: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        site["id"] = id.into();
        site["name"] = name.into();
        std::fs::write(&path, serde_json::to_string_pretty(&site)? + "\n")?;
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(to);
        return Err(e.context("naming the copy"));
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git" || name == ".mrstudio" {
            continue;
        }
        let target = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Tells the editor page what happened, for its status line: `saved` or a problem.
pub fn tell_editor<R: Runtime>(app: &AppHandle<R>, label: &str, detail: serde_json::Value) {
    if let Some(window) = app.get_webview_window(label) {
        let script = format!("window.dispatchEvent(new CustomEvent('mrs-file', {{ detail: {detail} }}))");
        let _ = window.eval(&script);
    }
}

/// Where a copy goes when the dialog is not told otherwise: beside the original.
/// A free name for a copy of the table `name` in `folder`: "Harbour copy", then "Harbour copy 2"
/// and on, so Duplicate never overwrites a table (#99).
pub fn copy_name(folder: &Path, name: &str) -> String {
    let base = format!("{} copy", name.trim());
    let taken = |n: &str| folder.join(n).exists();
    if !taken(&base) {
        return base;
    }
    (2..).map(|i| format!("{base} {i}")).find(|n| !taken(n)).unwrap()
}

pub fn default_folder(site: &Path, sites_folders: &[PathBuf]) -> PathBuf {
    sites_folders.first().cloned().or_else(|| site.parent().map(Path::to_path_buf)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_duplicate_takes_a_free_name() {
        let dir = std::env::temp_dir().join(format!("mrs-copy-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(copy_name(&dir, "Harbour"), "Harbour copy");
        std::fs::create_dir_all(dir.join("Harbour copy")).unwrap();
        assert_eq!(copy_name(&dir, "Harbour"), "Harbour copy 2");
        std::fs::create_dir_all(dir.join("Harbour copy 2")).unwrap();
        assert_eq!(copy_name(&dir, " Harbour "), "Harbour copy 3");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_copy_gets_its_own_name_and_id_and_leaves_history_behind() {
        let dir = std::env::temp_dir().join(format!("mrs-save-as-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let from = dir.join("harbour");
        std::fs::create_dir_all(from.join("data")).unwrap();
        std::fs::create_dir_all(from.join(".mrstudio/history")).unwrap();
        std::fs::write(from.join("site.json"), r#"{"format":3,"id":"harbour","name":"Harbour","scene":[]}"#).unwrap();
        std::fs::write(from.join("data/trees.geojson"), "{}").unwrap();
        let to = dir.join("Harbour after");
        copy_table(&from, &to, "Harbour after").unwrap();
        let site: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(to.join("site.json")).unwrap()).unwrap();
        assert_eq!(site["id"], "harbour-after");
        assert_eq!(site["name"], "Harbour after");
        // Key order is kept, so the copy diffs cleanly against the original.
        assert!(std::fs::read_to_string(to.join("site.json")).unwrap().trim_start().starts_with("{\n  \"format\""));
        assert!(to.join("data/trees.geojson").is_file());
        assert!(!to.join(".mrstudio").exists());
        // The original is untouched, and a second copy to the same place is refused.
        assert!(std::fs::read_to_string(from.join("site.json")).unwrap().contains("\"Harbour\""));
        assert!(copy_table(&from, &to, "Harbour after").is_err());
        assert!(copy_table(&from, &from.join("inside"), "Inside").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_name_comes_from_the_dialog_without_an_extension() {
        assert_eq!(name_from(Path::new("/a/Harbour v2")).as_deref(), Some("Harbour v2"));
        assert_eq!(name_from(Path::new("/a/Harbour v2.json")).as_deref(), Some("Harbour v2"));
        assert_eq!(name_from(Path::new("/")), None);
    }

    #[test]
    fn the_same_action_twice_in_a_moment_runs_once() {
        let d = Debounce::new();
        assert!(d.allow("save_as"));
        assert!(!d.allow("save_as"));
        assert!(d.allow("save"));
    }
}
