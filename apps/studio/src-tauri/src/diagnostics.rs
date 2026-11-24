//! Help > Copy diagnostics, Save diagnostics… and Open log folder (#260).
//!
//! One plain-text report to paste into an issue: the host's part (the table, its layers and how
//! they are doing, the windows' last signs of life, errors in the windows, incidents) and what
//! only the app knows: its version and build, the computer, the displays and which window is on
//! which, and the end of the app's log. Keys never pass through here, and anything in a log line
//! that looks like one is blanked.

use std::fmt::Write as _;
use std::path::Path;

use mrs_host::diagnostics::redact;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{list_displays, updates, Shell, EDITOR};

/// Lines of the app's log the report ends with.
const LOG_LINES: usize = 500;

/// The whole report.
pub async fn report(app: &AppHandle) -> String {
    let shell = app.state::<Shell>();
    let mut out = String::new();
    let state = shell.host.lock().await.as_ref().map(|h| h.state.clone());
    match state {
        Some(state) => out.push_str(&mrs_host::diagnostics::text(&mrs_host::diagnostics::report(&state).await)),
        None => out.push_str("MR Studio diagnostics\nNo table is open.\n"),
    }

    let (commit, built) = updates::build_stamp();
    let _ = writeln!(out, "\nApp");
    let _ = writeln!(out, "  MR Studio {} (commit {}, built {})", app.package_info().version, commit.unwrap_or("-"), built.unwrap_or("-"));
    let _ = writeln!(out, "  {} {}", std::env::consts::OS, std::env::consts::ARCH);
    if let Some(running) = shell.running.lock().unwrap().clone() {
        let _ = writeln!(
            out,
            "  Table '{}' served on port {}{}",
            running.name,
            running.port,
            if running.lan { ", phones on the network" } else { "" }
        );
    }

    let _ = writeln!(out, "\nDisplays");
    let surfaces = shell.surfaces.lock().unwrap().clone();
    match list_displays(app) {
        Ok(displays) => {
            for d in displays {
                // The windows on this display, by role: `surface-0-1-table` is the table.
                let roles: Vec<&str> =
                    surfaces.iter().filter(|(_, at)| *at == d.index).map(|(label, _)| label.rsplit('-').next().unwrap_or("")).collect();
                let _ = writeln!(
                    out,
                    "  {}: {}{} {}x{} at {},{} scale {}{}",
                    d.index,
                    d.model.as_deref().or(d.name.as_deref()).unwrap_or("display"),
                    if d.primary { " (main)" } else { "" },
                    d.width,
                    d.height,
                    d.x,
                    d.y,
                    d.scale,
                    if roles.is_empty() { String::new() } else { format!(", shows the {}", roles.join(" and ")) },
                );
            }
        }
        Err(e) => {
            let _ = writeln!(out, "  could not be listed: {e}");
        }
    }

    let _ = writeln!(out, "\nThe app's log (last {LOG_LINES} lines)");
    match app.path().app_log_dir() {
        Ok(dir) if !cfg!(debug_assertions) => out.push_str(&log_tail(&dir.join("mr-studio.log"), LOG_LINES)),
        Ok(_) => out.push_str("  a development build writes its log to the terminal\n"),
        Err(e) => {
            let _ = writeln!(out, "  no log folder: {e}");
        }
    }
    out
}

/// The last `lines` lines of a log file, each with anything like a key blanked.
fn log_tail(path: &Path, lines: usize) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return format!("  {} could not be read\n", path.display());
    };
    let all: Vec<&str> = text.lines().collect();
    let mut out = String::new();
    for line in &all[all.len().saturating_sub(lines)..] {
        out.push_str("  ");
        out.push_str(&redact(line));
        out.push('\n');
    }
    out
}

/// Save diagnostics…: the report as a text file, where the person chooses.
pub async fn save(app: &AppHandle) -> anyhow::Result<()> {
    let report = report(app).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save diagnostics")
        .set_file_name(format!("MR Studio diagnostics {}.txt", chrono::Local::now().format("%Y-%m-%d %H.%M")))
        .add_filter("Text", &["txt"]);
    if let Ok(documents) = app.path().document_dir() {
        dialog = dialog.set_directory(documents);
    }
    if let Some(window) = app.get_webview_window(EDITOR) {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |path| {
        let _ = send.send(path);
    });
    let Some(target) = receive.await.ok().flatten() else { return Ok(()) };
    let target = target.into_path().map_err(|_| anyhow::anyhow!("the chosen place is not a folder on this computer"))?;
    std::fs::write(&target, report)?;
    tracing::info!("diagnostics saved to {}", target.display());
    let _ = app.opener().reveal_item_in_dir(&target);
    Ok(())
}

/// The menu's Help items.
pub fn menu_action(app: &AppHandle, id: &str) {
    let app = app.clone();
    match id {
        // The editor shows the report and copies it; without an editor it is saved instead.
        "copy-diagnostics" if app.get_webview_window(EDITOR).is_some() => {
            crate::file_menu::tell_editor(&app, EDITOR, serde_json::json!({ "action": "diagnostics" }));
        }
        "copy-diagnostics" | "save-diagnostics" => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = save(&app).await {
                    tracing::error!("Save diagnostics: {e:#}");
                }
            });
        }
        "open-logs" => {
            let shell = app.state::<Shell>();
            if let Some(dir) = shell.operator.dir() {
                let _ = std::fs::create_dir_all(dir);
                if let Err(e) = app.opener().open_path(dir.to_string_lossy(), None::<&str>) {
                    tracing::error!("Open log folder: {e}");
                }
            }
        }
        _ => {}
    }
}

/// The Help menu's item ids.
pub const ACTIONS: [&str; 3] = ["copy-diagnostics", "save-diagnostics", "open-logs"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_tail_keeps_the_last_lines_without_keys() {
        let dir = std::env::temp_dir().join(format!("mrs-diag-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("mr-studio.log");
        let lines: Vec<String> = (0..10).map(|n| format!("line {n} GET /tiles?key=secret{n}")).collect();
        std::fs::write(&log, lines.join("\n")).unwrap();
        let tail = log_tail(&log, 3);
        assert_eq!(tail.lines().count(), 3);
        assert!(tail.contains("line 9 GET /tiles?key=[hidden]"), "{tail}");
        assert!(!tail.contains("secret"));
        assert!(log_tail(&dir.join("missing.log"), 3).contains("could not be read"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
