//! The final colour pass. A projector on a physical model usually wants more saturation
//! and contrast than a monitor, and every projector differs, so the settings are kept per
//! display in `colour.json` in the app's config folder. The shell applies them to each
//! surface window as a CSS filter (see `colour.js`); surfaces and layers know nothing about it.
//! The same file keeps each display's size: how large the controller's text and controls are
//! drawn there (#682).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::{write_json, Display};

/// Injected into every surface window. Defines `__mrsColour(settings)`, `__mrsSize(size)` and `__mrsTestCard(on)`.
pub const SCRIPT: &str = include_str!("colour.js");

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Colour {
    /// 0 is grey, 1 is unchanged.
    pub saturation: f64,
    pub brightness: f64,
    pub contrast: f64,
    /// Above 1 lifts the midtones, below 1 darkens them.
    pub gamma: f64,
    /// White balance: -1 is cooler (bluer), 1 is warmer.
    pub temperature: f64,
    /// White balance: -1 is greener, 1 is more magenta.
    pub tint: f64,
}

impl Default for Colour {
    fn default() -> Self {
        Self { saturation: 1.0, brightness: 1.0, contrast: 1.0, gamma: 1.0, temperature: 0.0, tint: 0.0 }
    }
}

impl Colour {
    /// Keeps every value inside the range the sliders offer, and turns NaN into the default.
    pub fn clamped(self) -> Self {
        let keep = |value: f64, min: f64, max: f64, default: f64| if value.is_finite() { value.clamp(min, max) } else { default };
        Self {
            saturation: keep(self.saturation, 0.0, 2.5, 1.0),
            brightness: keep(self.brightness, 0.5, 1.5, 1.0),
            contrast: keep(self.contrast, 0.5, 2.0, 1.0),
            gamma: keep(self.gamma, 0.5, 2.5, 1.0),
            temperature: keep(self.temperature, -1.0, 1.0, 0.0),
            tint: keep(self.tint, -1.0, 1.0, 0.0),
        }
    }

    /// The call that applies these settings in a surface window.
    pub fn script(&self) -> String {
        format!("window.__mrsColour && window.__mrsColour({});", serde_json::to_string(self).expect("plain numbers"))
    }
}

/// The smallest and largest size a display can have, as a share of the designed size. Below
/// 80% the controller's smallest text would be too small to read across a room.
pub const SIZE_RANGE: (f64, f64) = (0.8, 1.5);

/// Keeps a size inside [`SIZE_RANGE`] in steps of 5%, and turns NaN into 1.
pub fn clamp_size(size: f64) -> f64 {
    if !size.is_finite() {
        return 1.0;
    }
    ((size.clamp(SIZE_RANGE.0, SIZE_RANGE.1) * 20.0).round() / 20.0).clamp(SIZE_RANGE.0, SIZE_RANGE.1)
}

/// The call that applies a size in a surface window.
pub fn size_script(size: f64) -> String {
    format!("window.__mrsSize && window.__mrsSize({});", clamp_size(size))
}

/// Starting points that ship with the app. They cannot be deleted or overwritten.
pub fn built_in_presets() -> Vec<(&'static str, Colour)> {
    let neutral = Colour::default();
    vec![
        ("Neutral", neutral),
        ("Projector boost", Colour { saturation: 1.35, contrast: 1.12, gamma: 1.1, ..neutral }),
        ("Vivid", Colour { saturation: 1.7, contrast: 1.2, ..neutral }),
        ("Bright room", Colour { saturation: 1.5, contrast: 1.25, brightness: 1.1, gamma: 1.25, ..neutral }),
    ]
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ColourConfig {
    /// Current settings per display, by `key`.
    pub displays: BTreeMap<String, Colour>,
    /// Presets saved on this machine, by name.
    pub presets: BTreeMap<String, Colour>,
    /// How strongly each layer is drawn (0 to 2), by site id and then layer id. Only values
    /// that differ from 1 are kept. The shell hands them to the host when a session starts.
    pub layers: BTreeMap<String, BTreeMap<String, f64>>,
    /// The controller's size per display, by `key`, as a share of the designed size (#682).
    /// Only sizes that differ from 1 are kept.
    pub sizes: BTreeMap<String, f64>,
}

impl ColourConfig {
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

    pub fn for_display(&self, display: &Display) -> Colour {
        self.displays.get(&key(display)).copied().unwrap_or_default().clamped()
    }

    pub fn size_for(&self, display: &Display) -> f64 {
        self.sizes.get(&key(display)).copied().map(clamp_size).unwrap_or(1.0)
    }
}

/// Settings follow the display's name, so they survive a change in the order of the
/// displays. A display without a name is known by its position.
pub fn key(display: &Display) -> String {
    match display.name.as_deref() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => format!("#{}", display.index),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(index: usize, name: Option<&str>) -> Display {
        Display {
            index,
            name: name.map(Into::into),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            primary: index == 0,
            model: None,
            kind: None,
        }
    }

    #[test]
    fn settings_are_kept_per_display_and_default_to_neutral() {
        let (projector, unnamed) = (display(1, Some("EPSON PJ")), display(2, None));
        let mut config = ColourConfig::default();
        config.displays.insert(key(&projector), Colour { saturation: 1.4, ..Colour::default() });
        assert_eq!(config.for_display(&projector).saturation, 1.4);
        assert_eq!(config.for_display(&display(0, Some("DELL"))), Colour::default());
        assert_eq!(key(&unnamed), "#2");

        let path = std::env::temp_dir().join(format!("mrs-colour-{}.json", std::process::id()));
        config.write(&path).unwrap();
        assert_eq!(ColourConfig::read(&path), config);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn values_outside_the_sliders_are_pulled_back() {
        let wild = Colour { saturation: 9.0, brightness: -1.0, contrast: f64::NAN, gamma: 0.0, temperature: 3.0, tint: -3.0 }.clamped();
        assert_eq!(wild, Colour { saturation: 2.5, brightness: 0.5, contrast: 1.0, gamma: 0.5, temperature: 1.0, tint: -1.0 });
        // A file from an older version may miss fields.
        let partial: Colour = serde_json::from_str(r#"{ "saturation": 1.3 }"#).unwrap();
        assert_eq!(partial, Colour { saturation: 1.3, ..Colour::default() });
    }

    #[test]
    fn sizes_are_kept_per_display_in_steps_within_range() {
        let tv = display(0, Some("LG TV"));
        let mut config = ColourConfig::default();
        assert_eq!(config.size_for(&tv), 1.0);
        config.sizes.insert(key(&tv), 1.234);
        assert_eq!(config.size_for(&tv), 1.25);
        assert_eq!(clamp_size(0.3), 0.8);
        assert_eq!(clamp_size(9.0), 1.5);
        assert_eq!(clamp_size(f64::NAN), 1.0);
        assert_eq!(size_script(1.1), "window.__mrsSize && window.__mrsSize(1.1);");
        // A file from before sizes existed still reads.
        let old: ColourConfig = serde_json::from_str(r#"{ "displays": {} }"#).unwrap();
        assert!(old.sizes.is_empty());
    }

    #[test]
    fn built_in_presets_are_within_range_and_start_with_neutral() {
        let presets = built_in_presets();
        assert_eq!(presets[0], ("Neutral", Colour::default()));
        assert!(presets.iter().all(|(_, colour)| *colour == colour.clamped()));
    }
}
