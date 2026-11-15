//! What the shell remembers on this machine: which surface goes on which display
//! (`displays.json`, contract in `docs/contracts/session.md`) and the launcher's
//! choices (`studio.json`). Both live in the app's config folder.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The roles a window on this computer can have. Phones join over the network.
pub const WINDOW_ROLES: [&str; 3] = ["table", "tv", "dev"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Displays {
    pub windows: Vec<WindowSpec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowSpec {
    /// table, tv or dev.
    pub role: String,
    #[serde(default)]
    pub display: DisplayRef,
    #[serde(default = "yes")]
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DisplayRef {
    /// Matched first, against the name the system reports for the display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Used when no name matches. 0 is the first display the system lists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
}

fn yes() -> bool {
    true
}

/// A connected display, in the order the system lists them. Pixels are physical.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Display {
    pub index: usize,
    pub name: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

impl Displays {
    /// One windowed dev surface on the primary display: what runs before anything is set up.
    pub fn dev() -> Self {
        Self { windows: vec![WindowSpec { role: "dev".into(), display: DisplayRef::default(), fullscreen: false }] }
    }

    /// `Ok(None)` when the file does not exist.
    pub fn read(path: &Path) -> anyhow::Result<Option<Self>> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let displays: Self = serde_json::from_str(&text)?;
        displays.check()?;
        Ok(Some(displays))
    }

    pub fn write(&self, path: &Path) -> anyhow::Result<()> {
        self.check()?;
        write_json(path, self)
    }

    fn check(&self) -> anyhow::Result<()> {
        for window in &self.windows {
            if !WINDOW_ROLES.contains(&window.role.as_str()) {
                anyhow::bail!("'{}' is not a window role; use table, tv or dev", window.role);
            }
        }
        Ok(())
    }

    /// What Present uses when nobody chose: the controls fullscreen on the primary display
    /// and the table fullscreen on the first other one, or the table alone when there is
    /// only one display (the controller is then in the editor's preview).
    pub fn suggest(displays: &[Display]) -> Self {
        let primary = displays.iter().find(|d| d.primary).or(displays.first());
        let other = displays.iter().find(|d| Some(d.index) != primary.map(|p| p.index));
        let window = |role: &str, display: &Display| WindowSpec { role: role.into(), display: display.reference(), fullscreen: true };
        match (primary, other) {
            (Some(tv), Some(table)) => Self { windows: vec![window("table", table), window("tv", tv)] },
            (Some(only), None) => Self { windows: vec![window("table", only)] },
            _ => Self::dev(),
        }
    }

    /// Whether a saved choice still fits the displays that are connected: each window finds
    /// its display and no two share one. A choice of the dev window alone is what older
    /// versions saved before anything was set up, so it does not count as a choice.
    pub fn fits(&self, displays: &[Display]) -> bool {
        if self.windows.is_empty() || self.windows.iter().all(|w| w.role == "dev") {
            return false;
        }
        let mut used = Vec::new();
        self.windows.iter().all(|w| match w.display.resolve(displays) {
            Some(d) if !used.contains(&d.index) => {
                used.push(d.index);
                true
            }
            _ => false,
        })
    }

    /// The saved choice when it fits, else the suggestion.
    pub fn usual(saved: Option<Self>, displays: &[Display]) -> Self {
        saved.filter(|s| s.fits(displays)).unwrap_or_else(|| Self::suggest(displays))
    }
}

impl Display {
    pub fn reference(&self) -> DisplayRef {
        DisplayRef { name: self.name.clone(), index: Some(self.index) }
    }
}

impl DisplayRef {
    /// By name first, then by index, as the contract says. `None` when neither matches.
    pub fn resolve<'a>(&self, displays: &'a [Display]) -> Option<&'a Display> {
        let named = |matches: &dyn Fn(&str, &str) -> bool| {
            let wanted = self.name.as_deref().filter(|n| !n.is_empty())?;
            displays.iter().find(|d| d.name.as_deref().is_some_and(|name| matches(name, wanted)))
        };
        named(&|name, wanted| name == wanted)
            .or_else(|| named(&|name, wanted| name.contains(wanted)))
            .or_else(|| self.index.and_then(|i| displays.iter().find(|d| d.index == i)))
    }
}

/// The launcher's choices.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Site folders added by hand, besides the ones found in the sites folders.
    pub sites: Vec<PathBuf>,
    /// The site that ran last.
    pub site: Option<PathBuf>,
    /// Listen on the local network so phones can join. Off keeps the host on this
    /// computer only, which also avoids the Windows firewall prompt.
    pub lan: bool,
    /// Start the last site on the saved displays without showing the launcher.
    pub autostart: bool,
    /// Do not look for a newer version when the app starts. Checking is the default.
    pub skip_update_check: bool,
    /// The sites opened last, newest first.
    pub recent: Vec<PathBuf>,
}

impl Settings {
    /// Notes that `site` was opened: it is the one to offer next time and tops the recent list.
    pub fn opened(&mut self, site: &Path) {
        self.site = Some(site.to_path_buf());
        self.recent.retain(|p| p != site);
        self.recent.insert(0, site.to_path_buf());
        self.recent.truncate(8);
    }

    pub fn read(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                tracing::error!("{}: {e}", path.display());
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn write(&self, path: &Path) -> anyhow::Result<()> {
        write_json(path, self)
    }
}

pub fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Write beside the file and rename, so a crash never leaves half a config.
    let partial = path.with_extension("json.part");
    std::fs::write(&partial, serde_json::to_string_pretty(value)? + "\n")?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(index: usize, name: &str, primary: bool) -> Display {
        Display { index, name: Some(name.into()), x: index as i32 * 1920, y: 0, width: 1920, height: 1080, scale: 1.0, primary }
    }

    fn wanted(name: Option<&str>, index: Option<usize>) -> DisplayRef {
        DisplayRef { name: name.map(Into::into), index }
    }

    #[test]
    fn a_name_wins_over_an_index() {
        let displays = [display(0, "DELL U2720Q", true), display(1, "EPSON PJ", false)];
        assert_eq!(wanted(Some("EPSON PJ"), Some(0)).resolve(&displays).unwrap().index, 1);
        // Part of a name is enough, but an exact match is preferred.
        assert_eq!(wanted(Some("EPSON"), None).resolve(&displays).unwrap().index, 1);
        let similar = [display(0, r"\\.\DISPLAY10", false), display(1, r"\\.\DISPLAY1", true)];
        assert_eq!(wanted(Some(r"\\.\DISPLAY1"), None).resolve(&similar).unwrap().index, 1);
    }

    #[test]
    fn the_index_is_used_when_the_name_is_gone() {
        let displays = [display(0, "DELL U2720Q", true), display(1, "SAMSUNG TV", false)];
        assert_eq!(wanted(Some("EPSON PJ"), Some(1)).resolve(&displays).unwrap().index, 1);
        assert_eq!(wanted(None, Some(0)).resolve(&displays).unwrap().index, 0);
        assert!(wanted(Some("EPSON PJ"), Some(2)).resolve(&displays).is_none());
        assert!(wanted(None, None).resolve(&displays).is_none());
    }

    #[test]
    fn the_contract_example_parses_and_survives_a_round_trip() {
        let text = r#"{ "windows": [
            { "role": "table", "display": { "name": "EPSON PJ", "index": 1 }, "fullscreen": true },
            { "role": "tv",    "display": { "index": 0 } }
        ] }"#;
        let dir = std::env::temp_dir().join(format!("mrs-displays-{}", std::process::id()));
        let path = dir.join("displays.json");
        assert!(Displays::read(&path).unwrap().is_none());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, text).unwrap();
        let displays = Displays::read(&path).unwrap().unwrap();
        assert_eq!(displays.windows[0].display, wanted(Some("EPSON PJ"), Some(1)));
        assert!(displays.windows[1].fullscreen, "fullscreen defaults to on");
        displays.write(&path).unwrap();
        assert_eq!(Displays::read(&path).unwrap().unwrap(), displays);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_phone_is_not_a_window() {
        let displays = Displays { windows: vec![WindowSpec { role: "phone".into(), display: DisplayRef::default(), fullscreen: true }] };
        assert!(displays.write(Path::new("unused.json")).is_err());
    }

    #[test]
    fn two_displays_suggest_table_and_tv_and_one_suggests_the_table() {
        let two = Displays::suggest(&[display(0, "LAPTOP", true), display(1, "EPSON PJ", false)]);
        assert_eq!(
            two.windows.iter().map(|w| (w.role.as_str(), w.display.index)).collect::<Vec<_>>(),
            [("table", Some(1)), ("tv", Some(0))]
        );
        let one = Displays::suggest(&[display(0, "LAPTOP", true)]);
        assert_eq!(one.windows.len(), 1);
        assert_eq!((one.windows[0].role.as_str(), one.windows[0].display.index, one.windows[0].fullscreen), ("table", Some(0), true));
    }

    #[test]
    fn a_saved_choice_is_used_only_while_it_fits() {
        let two = [display(0, "LAPTOP", true), display(1, "EPSON PJ", false)];
        let one = [display(0, "LAPTOP", true)];
        let spec = |role: &str, name: &str| WindowSpec { role: role.into(), display: wanted(Some(name), None), fullscreen: true };
        let saved = Displays { windows: vec![spec("table", "LAPTOP"), spec("tv", "EPSON PJ")] };
        assert!(saved.fits(&two));
        assert_eq!(Displays::usual(Some(saved.clone()), &two), saved);
        // The projector is unplugged: both windows would land on the laptop.
        assert!(!saved.fits(&one));
        assert_eq!(Displays::usual(Some(saved), &one), Displays::suggest(&one));
        // What older versions saved before anything was chosen.
        assert!(!Displays::dev().fits(&two));
        let same = Displays { windows: vec![spec("table", "LAPTOP"), spec("tv", "LAPTOP")] };
        assert!(!same.fits(&two));
    }
}
