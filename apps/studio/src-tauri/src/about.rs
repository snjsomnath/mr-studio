//! MR Studio's own About window (#699), in place of the plain box the system draws: the logo,
//! version and build, this computer's system, credits, where the data comes from and the
//! open-source licences. A table's own credits stay on its controller (`tv.about`).

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// The window's label; capabilities/about.json lets only it call the About commands.
pub const ABOUT: &str = "about";

/// The menu item id: the app menu on macOS, Help on Windows and Linux.
pub const MENU_ID: &str = "about";

#[derive(Debug, Serialize)]
pub struct AboutInfo {
    version: String,
    commit: Option<String>,
    built: Option<String>,
    /// "macOS", "Windows" or "Linux", and the processor: "macOS · Apple silicon".
    system: String,
}

#[tauri::command]
pub(crate) fn about_info(app: AppHandle) -> AboutInfo {
    let (commit, built) = crate::updates::build_stamp();
    AboutInfo {
        version: app.package_info().version.to_string(),
        commit: commit.map(String::from),
        built: built.map(String::from),
        system: system(),
    }
}

fn system() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    let chip = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "Apple silicon",
        ("macos", "x86_64") => "Intel",
        (_, "x86_64") => "64-bit",
        (_, "aarch64") => "ARM",
        (_, other) => other,
    };
    format!("{os} · {chip}")
}

/// Opens the About window, or brings it forward.
#[tauri::command]
pub(crate) fn open_about(app: AppHandle) -> Result<(), String> {
    show(&app).map_err(|e| e.to_string())
}

pub(crate) fn show(app: &AppHandle) -> tauri::Result<()> {
    let window = match app.get_webview_window(ABOUT) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, ABOUT, WebviewUrl::App("about.html".into()))
            .title("About MR Studio")
            .inner_size(520.0, 640.0)
            .min_inner_size(440.0, 480.0)
            .resizable(true)
            .center()
            .build()?,
    };
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_system_is_named_in_words() {
        let words = super::system();
        assert!(words.contains(" · "), "{words}");
        assert!(!words.contains("x86_64") && !words.contains("aarch64"), "{words}");
    }
}
