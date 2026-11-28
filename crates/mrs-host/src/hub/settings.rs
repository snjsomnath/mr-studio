//! Table and controller settings: languages, the controller's words and pages, the
//! table's own settings, display quality and the sources a table uses.

use super::*;

/// The languages a table offers visitors (#80), the first it starts in: never empty.
pub(super) fn offered(branding: &mrs_site::Branding) -> Vec<String> {
    let known: Vec<String> = branding.languages.iter().filter(|l| mrs_site::LANGUAGES.contains(&l.as_str())).cloned().collect();
    if known.is_empty() {
        vec!["en".to_string()]
    } else {
        known
    }
}

/// `branding.languages` from Table settings: known languages, each once.
pub(super) fn languages(value: &Value) -> Result<Vec<String>, String> {
    let list = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(list) => list,
        _ => return Err("languages must be a list such as [\"en\", \"sv\"]".into()),
    };
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let code = item.as_str().ok_or("languages must be a list of language codes")?;
        if !mrs_site::LANGUAGES.contains(&code) {
            return Err(format!("'{code}' is not a language MR Studio speaks yet ({})", mrs_site::LANGUAGES.join(", ")));
        }
        if !out.iter().any(|l| l == code) {
            out.push(code.to_string());
        }
    }
    Ok(out)
}

/// `branding.translations` from Table settings: `{ sv: { "English": "Svenska" } }`.
pub(super) fn translations(
    value: &Value,
) -> Result<std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>, String> {
    let map = match value {
        Value::Null => return Ok(Default::default()),
        Value::Object(map) => map,
        _ => return Err("translations must be an object of languages".into()),
    };
    let mut out = std::collections::BTreeMap::new();
    for (language, words) in map {
        if !mrs_site::LANGUAGES.contains(&language.as_str()) {
            return Err(format!("'{language}' is not a language MR Studio speaks yet"));
        }
        let words = words.as_object().ok_or("each language's translations map English text to its own")?;
        if words.len() > 2000 {
            return Err("at most 2000 translations per language".into());
        }
        let mut kept = std::collections::BTreeMap::new();
        for (english, text) in words {
            let text = text.as_str().ok_or("a translation must be text")?.trim();
            if english.chars().count() > 2000 || text.chars().count() > 2000 {
                return Err("a translation can be at most 2000 characters".into());
            }
            if !text.is_empty() {
                kept.insert(english.clone(), text.to_string());
            }
        }
        if !kept.is_empty() {
            out.insert(language.clone(), kept);
        }
    }
    Ok(out)
}

/// 64 unpredictable bits from the operating system, by way of the standard library's hash seeds.
/// A controller setting in the words the editor uses.
pub(super) fn tv_words(key: &str) -> &str {
    match key {
        "theme" | "theme_name" => "theme",
        "rail_style" => "button style",
        "about" => "About page",
        "idle_reset_s" => "idle reset",
        "attract_s" => "welcome loop",
        "phone_switch" => "phones switching layers",
        "two_layers" => "two layers at once",
        "pages" => "pages",
        "rotate_s" => "page time",
        other => other,
    }
}

/// The controller's hand-made pages (#155): up to 12, each `{ id, title?, panels }` with at most 8
/// panels that name a widget, a size and a place, in at most 64 KB. The grid, the sizes and the
/// density budget are the dashboard's rules, checked by the editor and again by the controller.
pub(super) fn valid_pages(value: &Value) -> bool {
    let Some(pages) = value.as_array() else { return false };
    let id = |v: &Value| {
        v.as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
    };
    pages.len() <= 12
        && value.to_string().len() <= 64_000
        && pages.iter().all(|page| {
            id(&page["id"])
                && (page["title"].is_null() || page["title"].as_str().is_some_and(|t| t.chars().count() <= 28))
                && page["panels"].as_array().is_some_and(|panels| {
                    panels.len() <= 8
                        && panels.iter().all(|p| {
                            id(&p["id"])
                                && p["widget"].as_str().is_some_and(|w| !w.is_empty() && w.len() <= 80)
                                && p["size"].is_string()
                                && p["at"]["col"].is_u64()
                                && p["at"]["row"].is_u64()
                        })
                })
        })
}

impl Hub {
    /// `site.tv { tv: { key: value | null } }`: changes the controller's table settings (theme,
    /// theme_name, rail_style, about), saves them to site.json and sends the new `tv` to every
    /// surface as `site.tv`, so a theme shows at once without a reload. `null` removes a key.
    pub(super) fn set_tv(&self, p: &Value, who: Who) -> Result<Value, String> {
        let patch = p["tv"].as_object().ok_or("missing tv")?;
        let mut tv = match self.info.read().tv.clone() {
            Some(Value::Object(tv)) => tv,
            _ => Map::new(),
        };
        for (key, value) in patch {
            let fits = match key.as_str() {
                "theme" => {
                    value.as_object().is_some_and(|t| t.len() <= 64 && t.values().all(|v| v.as_str().is_some_and(|s| s.len() <= 160)))
                }
                "theme_name" => value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 40),
                "rail_style" => matches!(value.as_str(), Some("icons" | "labelled")),
                "about" => value.is_object() && value.to_string().len() <= 8_000,
                "idle_reset_s" => value.as_f64().is_some_and(|s| (0.0..=3600.0).contains(&s)),
                "attract_s" => value.as_f64().is_some_and(|s| (2.0..=30.0).contains(&s)),
                "phone_switch" | "two_layers" => value.is_boolean(),
                // Hand-made pages (#155): the editor checks the grid and the budget with the
                // dashboard's own rules; the host keeps the shape and the size in bounds.
                "pages" => valid_pages(value),
                "rotate_s" => value.as_f64().is_some_and(|s| (6.0..=60.0).contains(&s)),
                _ => return Err(format!("'{key}' is not a controller setting that can be changed here")),
            };
            if value.is_null() {
                tv.remove(key);
            } else if fits {
                tv.insert(key.clone(), value.clone());
            } else {
                return Err(format!("'{key}' is not a valid value"));
            }
        }
        let tv = if tv.is_empty() { Value::Null } else { Value::Object(tv) };
        let what = patch.keys().map(|k| tv_words(k)).collect::<Vec<_>>().join(", ");
        self.saving_later(who, format!("Changed the controller's {what}"), vec![("tv", (!tv.is_null()).then(|| tv.clone()))])?;
        self.info.write().tv = if tv.is_null() { None } else { Some(tv.clone()) };
        self.emit("site.tv", json!({ "tv": tv }));
        Ok(json!({ "tv": tv }))
    }

    /// `site.table { name?, timezone?, branding?: { title?, logo?, welcome? } }` (#73): the table
    /// settings that are not its place (moving and resizing go through `/api/site/place`, which
    /// re-bakes). A field left out stays; `null` clears an optional one. Saved to site.json and
    /// sent to every surface as `site.settings { name, timezone, branding }`.
    pub(super) fn set_table(&self, p: &Value, who: Who) -> Result<Value, String> {
        let current = self.info.read().clone();
        let mut name = current.name.clone();
        let mut timezone = current.timezone.clone();
        let mut branding = current.branding.clone();
        let text = |value: &Value, field: &str, most: usize| -> Result<Option<String>, String> {
            match value {
                Value::Null => Ok(None),
                Value::String(s) if s.trim().is_empty() => Ok(None),
                Value::String(s) if s.trim().chars().count() <= most => Ok(Some(s.trim().to_string())),
                Value::String(_) => Err(format!("{field} can be at most {most} characters")),
                _ => Err(format!("{field} must be text")),
            }
        };
        let mut changed = Vec::new();
        if let Some(value) = p.get("name") {
            name = text(value, "the name", 60)?.ok_or("the table needs a name")?;
            changed.push("name");
        }
        if let Some(value) = p.get("timezone") {
            timezone = text(value, "the time zone", 64)?;
            if let Some(zone) = &timezone {
                let fits = zone
                    .split('/')
                    .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+')));
                if !fits {
                    return Err(format!("'{zone}' is not a time zone such as Europe/Stockholm"));
                }
            }
            changed.push("time zone");
        }
        match &p["branding"] {
            Value::Null => {}
            Value::Object(patch) => {
                for (key, value) in patch {
                    match key.as_str() {
                        "title" => branding.title = text(value, "the title", 80)?,
                        "welcome" => branding.welcome = text(value, "the welcome line", 160)?,
                        "logo" => {
                            let logo = text(value, "the logo", 200)?;
                            if let Some(logo) = &logo {
                                let path = std::path::Path::new(logo);
                                let inside = path.is_relative() && path.components().all(|c| matches!(c, std::path::Component::Normal(_)));
                                if !inside || !self.site.dir.join(path).is_file() {
                                    return Err(format!("the logo must be a picture inside the table's folder; '{logo}' is not"));
                                }
                            }
                            branding.logo = logo;
                        }
                        "languages" => branding.languages = languages(value)?,
                        "translations" => branding.translations = translations(value)?,
                        other => return Err(format!("'{other}' is not a branding setting")),
                    }
                    changed.push(match key.as_str() {
                        "title" => "title",
                        "welcome" => "welcome line",
                        "languages" => "languages",
                        "translations" => "translations",
                        _ => "logo",
                    });
                }
            }
            _ => return Err("branding must be an object".into()),
        }
        // The physical table's front edge and the ribbons in the projector's blank space (#62, #78).
        let mut table = current.table;
        match &p["table"] {
            Value::Null => {}
            Value::Object(patch) => {
                let t = table.as_mut().ok_or("the table has no size yet: set it with the place first")?;
                for (key, value) in patch {
                    match key.as_str() {
                        "front" => {
                            t.front = if value.is_null() {
                                None
                            } else {
                                Some(
                                    serde_json::from_value(value.clone())
                                        .map_err(|_| "the front is top, bottom, left or right".to_string())?,
                                )
                            };
                            changed.push("front edge");
                        }
                        "ribbons" => {
                            let Value::Object(sides) = value else { return Err("ribbons must be an object of sides".into()) };
                            for (side, ribbon) in sides {
                                let ribbon: Option<mrs_site::Ribbon> = if ribbon.is_null() {
                                    None
                                } else {
                                    let r = serde_json::from_value(ribbon.clone())
                                        .map_err(|_| format!("the {side} ribbon is off, auto or {{\"cm\": size}}"))?;
                                    if let mrs_site::Ribbon::Size(size) = r {
                                        if !(2.0..=40.0).contains(&size.cm) {
                                            return Err(format!("the {side} ribbon is 2 to 40 cm wide"));
                                        }
                                    }
                                    Some(r)
                                };
                                match side.as_str() {
                                    "top" => t.ribbons.top = ribbon,
                                    "bottom" => t.ribbons.bottom = ribbon,
                                    "left" => t.ribbons.left = ribbon,
                                    "right" => t.ribbons.right = ribbon,
                                    other => return Err(format!("'{other}' is not a side of the table")),
                                }
                            }
                            changed.push("ribbons");
                        }
                        // The ambient glow in the blank space (#476): null takes it away, otherwise
                        // the fields given change and the rest stay.
                        "glow" => {
                            t.glow = if value.is_null() {
                                None
                            } else {
                                let mut merged = serde_json::to_value(t.glow.unwrap_or(mrs_site::Glow {
                                    on: true,
                                    strength: mrs_site::Glow::default_strength(),
                                    colours: Default::default(),
                                }))
                                .map_err(|e| e.to_string())?;
                                let Value::Object(fields) = value else {
                                    return Err("glow must be an object: on, strength, colours".into());
                                };
                                for (k, v) in fields {
                                    merged[k] = v.clone();
                                }
                                let glow: mrs_site::Glow = serde_json::from_value(merged).map_err(|_| {
                                    "glow is { on: true or false, strength: 0 to 1, colours: \"edges\" or \"one\" }".to_string()
                                })?;
                                if !(0.0..=1.0).contains(&glow.strength) {
                                    return Err("the glow's strength is 0 to 1".into());
                                }
                                Some(glow)
                            };
                            changed.push("ambient glow");
                        }
                        // How the table opens: the layers fading in (the default, also for null) or the zoom in.
                        "intro" => {
                            t.intro = if value.is_null() {
                                None
                            } else {
                                Some(serde_json::from_value(value.clone()).map_err(|_| "the opening is fade or zoom".to_string())?)
                            };
                            changed.push("opening");
                        }
                        other => return Err(format!("'{other}' is not a table setting here; the size and tiles change with the place")),
                    }
                }
            }
            _ => return Err("table must be an object".into()),
        }
        if changed.is_empty() {
            return Err("nothing to change".into());
        }
        let summary = match changed.as_slice() {
            ["name"] => format!("Renamed the table to {name}"),
            [one] => format!("Changed the table's {one}"),
            _ => "Changed the table settings".to_string(),
        };
        let table_changed = table != current.table;
        self.saving(who, summary, || {
            if table_changed {
                if let Some(table) = &table {
                    self.site.save_table(table)?;
                }
            }
            self.site.save_settings(&name, timezone.as_deref(), &branding)
        })?;
        if table_changed {
            // The table draws its ribbons from the site: every surface takes the new one.
            // `table_only` lets the editor take it in place instead of starting again.
            let info = {
                let mut info = self.info.write();
                info.table = table;
                info.clone()
            };
            self.emit("site.changed", json!({ "site": info, "table_only": true }));
        }
        let language = {
            let mut info = self.info.write();
            info.name = name;
            info.timezone = timezone;
            info.branding = branding;
            // A language no longer offered gives way to the first one.
            let offered = offered(&info.branding);
            let mut language = self.language.write();
            if !offered.contains(&language) {
                *language = offered[0].clone();
                true
            } else {
                false
            }
        };
        let settings = self.settings();
        self.emit("site.settings", settings.clone());
        if language {
            self.emit("session.changed", json!({ "session": self.session() }));
        }
        Ok(settings)
    }

    /// The table settings `site.settings` carries.
    pub(super) fn settings(&self) -> Value {
        let info = self.info.read();
        json!({ "name": info.name, "timezone": info.timezone, "branding": info.branding })
    }

    /// `site.sources`: which outside sources (#41) this table's layers use, by the controls
    /// that name one (`"sources": [...]` in layer.json): `{ sources: [{ source, layers: [{ id, name }] }] }`.
    /// The Sources page shows this as the table's own short list.
    /// The outside sources the table's layers use, as `site.sources` answers: for an export (#85).
    pub fn sources_in_use(&self) -> Value {
        let inner = self.inner.lock();
        self.sources_used(&inner)
    }

    pub(super) fn sources_used(&self, inner: &Inner) -> Value {
        let catalog = self.catalog();
        let mut used: Vec<(String, Vec<Value>)> = Vec::new();
        for instance in &inner.scene {
            let manifest = &catalog[instance.def].manifest;
            for control in manifest["controls"].as_array().into_iter().flatten() {
                if !control["sources"].is_array() {
                    continue;
                }
                let Some(id) = control["id"].as_str() else { continue };
                let Some(source) = instance.state.params.get(id).and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
                let layer = json!({ "id": instance.id, "name": self.label(instance) });
                match used.iter_mut().find(|(s, _)| s == source) {
                    Some((_, layers)) => layers.push(layer),
                    None => used.push((source.to_string(), vec![layer])),
                }
            }
        }
        json!({ "sources": used.into_iter().map(|(source, layers)| json!({ "source": source, "layers": layers })).collect::<Vec<_>>() })
    }

    /// `site.display { display: { quality: "draft" | "good" | "best" | null, sounds: 0..1 | null } }`: how the table's surfaces
    /// render (#134). Saved to site.json and sent to every surface as `site.display`, which apply it at once.
    pub(super) fn set_display(&self, p: &Value, who: Who) -> Result<Value, String> {
        let patch = p["display"].as_object().ok_or("missing display")?;
        let mut display = match self.info.read().display.clone() {
            Some(Value::Object(display)) => display,
            _ => Map::new(),
        };
        for (key, value) in patch {
            let fits = match key.as_str() {
                "quality" => matches!(value.as_str(), Some("draft" | "good" | "best")),
                // The volume of the table's interface sounds (#703): 0 is off.
                "sounds" => value.as_f64().is_some_and(|v| (0.0..=1.0).contains(&v)),
                _ => return Err(format!("'{key}' is not a display setting")),
            };
            if value.is_null() {
                display.remove(key);
            } else if fits {
                display.insert(key.clone(), value.clone());
            } else {
                return Err(format!("'{key}' is not a valid value"));
            }
        }
        let display = if display.is_empty() { Value::Null } else { Value::Object(display) };
        self.saving_later(who, "Changed the display settings", vec![("display", (!display.is_null()).then(|| display.clone()))])?;
        self.info.write().display = if display.is_null() { None } else { Some(display.clone()) };
        self.emit("site.display", json!({ "display": display }));
        Ok(json!({ "display": display }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::test_support::*;

    #[test]
    fn the_home_screen_timings_are_table_settings() {
        let hub = scratch_hub("home-timings");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let tv = dev("site.tv", json!({ "tv": { "idle_reset_s": 60, "attract_s": 6 } })).unwrap();
        assert_eq!((tv["tv"]["idle_reset_s"].clone(), tv["tv"]["attract_s"].clone()), (json!(60), json!(6)));
        assert!(dev("site.tv", json!({ "tv": { "idle_reset_s": 0 } })).is_ok(), "0 is never");
        assert!(dev("site.tv", json!({ "tv": { "idle_reset_s": -1 } })).is_err());
        assert!(dev("site.tv", json!({ "tv": { "attract_s": 1 } })).is_err(), "too quick to read");
    }

    #[test]
    fn hand_made_pages_and_their_time_are_controller_settings() {
        let hub = scratch_hub("pages");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let page = json!([{ "id": "energy", "title": "Energy", "panels": [
            { "id": "now", "widget": "stat", "size": "tile", "title": "Now", "props": { "value": 3 }, "at": { "col": 1, "row": 1 } }
        ] }]);
        let tv = dev("site.tv", json!({ "tv": { "pages": page, "rotate_s": 20 } })).unwrap();
        assert_eq!(tv["tv"]["pages"][0]["panels"][0]["widget"], "stat");
        assert_eq!(tv["tv"]["rotate_s"], 20);
        assert!(dev("site.tv", json!({ "tv": { "rotate_s": 2 } })).is_err(), "too quick to read");
        assert!(dev("site.tv", json!({ "tv": { "pages": [{ "id": "Bad Id", "panels": [] }] } })).is_err());
        assert!(
            dev("site.tv", json!({ "tv": { "pages": [{ "id": "p", "panels": [{ "id": "a", "widget": "stat", "size": "tile" }] }] } }))
                .is_err(),
            "a panel needs its place"
        );
        // No pages: the controller lays out the open layers' panels again.
        assert!(dev("site.tv", json!({ "tv": { "pages": null } })).unwrap()["tv"]["pages"].is_null());
    }

    #[test]
    fn a_slow_save_holds_up_no_other_surface_and_saves_keep_their_order() {
        // #536: with every write to site.json taking 500 ms, as on a busy network disk.
        let hub = std::sync::Arc::new(scratch_hub("slow-saves"));
        hub.slow_saves(500);
        let saved_tv = |hub: &Hub| {
            let json: Value = serde_json::from_str(&std::fs::read_to_string(hub.site.dir.join("site.json")).unwrap()).unwrap();
            json["tv"]["idle_reset_s"].clone()
        };
        let editor = |value: u64| {
            let hub = hub.clone();
            std::thread::spawn(move || {
                let started = Instant::now();
                hub.request(Role::Dev, 1, "site.tv", &json!({ "tv": { "idle_reset_s": value } })).unwrap();
                started.elapsed()
            })
        };
        let first = editor(60);
        std::thread::sleep(std::time::Duration::from_millis(100));
        let second = editor(90);
        std::thread::sleep(std::time::Duration::from_millis(100));

        // The controller is answered at once while both are being saved.
        let pressed = Instant::now();
        hub.request(Role::Tv, 2, "session.sound", &json!({ "on": false })).unwrap();
        assert!(pressed.elapsed() < std::time::Duration::from_millis(100), "a press waited {:?} for a save", pressed.elapsed());
        // The hub already holds the newest change.
        assert_eq!(hub.site().tv.unwrap()["idle_reset_s"], 90);

        // Each editor is answered once its own change is on disk, and the newer one wins.
        assert!(first.join().unwrap() >= std::time::Duration::from_millis(500));
        assert!(second.join().unwrap() >= std::time::Duration::from_millis(800), "the second save waited for the first");
        assert_eq!(saved_tv(&hub), 90);
        let history = hub.history_list().to_string();
        assert!(history.contains("Changed the controller's idle reset"), "the history has the change: {history}");
    }

    #[test]
    fn the_controller_mutes_the_table_for_the_session() {
        let hub = scratch_hub("sound");
        assert!(hub.session().sound, "a session starts with sound");
        assert!(hub.request(Role::Phone, 0, "session.sound", &json!({ "on": false })).is_err());
        assert!(hub.request(Role::Table, 0, "session.sound", &json!({ "on": false })).is_err());
        assert!(hub.request(Role::Tv, 0, "session.sound", &json!({})).is_err());
        hub.request(Role::Tv, 0, "session.sound", &json!({ "on": false })).unwrap();
        assert!(!hub.session().sound);
        assert_eq!(hub.welcome(0)["state"]["session"]["sound"], false);
        hub.request(Role::Guide, 0, "session.sound", &json!({ "on": true })).unwrap();
        assert!(hub.session().sound);

        // The frame meter (#262): off at the start, the operator's to show.
        assert!(!hub.session().performance);
        assert!(hub.request(Role::Phone, 0, "session.performance", &json!({ "on": true })).is_err());
        assert!(hub.request(Role::Table, 0, "session.performance", &json!({ "on": true })).is_err());
        hub.request(Role::Dev, 0, "session.performance", &json!({ "on": true })).unwrap();
        assert_eq!(hub.welcome(0)["state"]["session"]["performance"], true);
    }

    #[test]
    fn the_controller_picks_the_ribbon() {
        let hub = scratch_hub("ribbon");
        assert_eq!(hub.session().ribbon, None, "a session starts on Auto");
        let some = hub.inner.lock().scene.first().map(|i| i.id.clone()).expect("the scratch table has layers");
        assert!(hub.request(Role::Phone, 0, "session.ribbon", &json!({ "layer": some })).is_err());
        assert!(hub.request(Role::Table, 0, "session.ribbon", &json!({ "layer": some })).is_err());
        assert!(hub.request(Role::Tv, 0, "session.ribbon", &json!({ "layer": "nowhere" })).is_err());
        assert!(hub.request(Role::Tv, 0, "session.ribbon", &json!({ "layer": 3 })).is_err());
        hub.request(Role::Tv, 0, "session.ribbon", &json!({ "layer": some })).unwrap();
        assert_eq!(hub.session().ribbon.as_deref(), Some(some.as_str()));
        assert_eq!(hub.welcome(0)["state"]["session"]["ribbon"], json!(some));
        hub.request(Role::Guide, 0, "session.ribbon", &json!({ "layer": null })).unwrap();
        assert_eq!(hub.session().ribbon, None);
    }

    #[test]
    fn the_controller_switches_the_visitors_language() {
        let hub = scratch_hub("languages");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("site.table", json!({ "branding": { "languages": null } })).unwrap();
        assert_eq!(hub.session().language, "en", "English until the table offers more");
        assert!(dev("session.language", json!({ "language": "sv" })).is_err(), "Swedish is not offered yet");
        dev("site.table", json!({ "branding": { "languages": ["sv", "en"], "translations": { "sv": { "Sample district": "Exempelstadsdelen", "Empty": " " } } } })).unwrap();
        let saved = Site::load(&hub.site.dir).unwrap().manifest.branding;
        assert_eq!(saved.languages, ["sv", "en"]);
        assert_eq!(saved.translations["sv"].len(), 1, "an empty translation is dropped");
        assert!(dev("site.table", json!({ "branding": { "languages": ["xx"] } })).is_err());

        let mut events = hub.subscribe();
        assert!(hub.request(Role::Phone, 0, "session.language", &json!({ "language": "en" })).is_err(), "a phone keeps its own language");
        assert!(hub.request(Role::Table, 0, "session.language", &json!({ "language": "en" })).is_err());
        hub.request(Role::Tv, 0, "session.language", &json!({ "language": "en" })).unwrap();
        let event: Value = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
        assert_eq!((event["m"].as_str(), event["p"]["session"]["language"].as_str()), (Some("session.changed"), Some("en")));
        assert_eq!(hub.welcome(0)["state"]["session"]["language"], "en");
        hub.request(Role::Guide, 0, "session.language", &json!({ "language": "sv" })).unwrap();

        // Taking a language away goes back to the first one left.
        dev("site.table", json!({ "branding": { "languages": ["en"] } })).unwrap();
        assert_eq!(hub.session().language, "en");
    }

    #[test]
    fn table_settings_are_saved_sent_and_checked() {
        let hub = scratch_hub("table-settings");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let mut events = hub.subscribe();
        let done = dev("site.table", json!({ "name": "Harbour 2040", "timezone": "Europe/Stockholm", "branding": { "title": "Harbour", "welcome": "Touch a layer to begin" } })).unwrap();
        assert_eq!(done["branding"]["welcome"], "Touch a layer to begin");
        let event: Value = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
        assert_eq!((event["m"].as_str(), event["p"]["name"].as_str()), (Some("site.settings"), Some("Harbour 2040")));
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(hub.site.dir.join("site.json")).unwrap()).unwrap();
        assert_eq!(saved["branding"]["title"], "Harbour");
        assert_eq!(saved["name"], "Harbour 2040");
        // A field left out stays; null clears an optional one.
        dev("site.table", json!({ "branding": { "welcome": null } })).unwrap();
        assert_eq!(hub.site().branding.title.as_deref(), Some("Harbour"));
        assert!(hub.site().branding.welcome.is_none());
        assert!(dev("site.table", json!({ "name": "" })).is_err(), "a table needs a name");
        assert!(dev("site.table", json!({ "timezone": "Mars time" })).is_err());
        assert!(dev("site.table", json!({ "branding": { "logo": "../secret.png" } })).is_err());
        assert!(dev("site.table", json!({ "branding": { "colour": "#fff" } })).is_err());
        assert!(hub.request(Role::Phone, 0, "site.table", &json!({ "name": "x" })).is_err());
        // The history says what it was.
        let list = hub.history_list();
        assert_eq!(list["revisions"][1]["summary"], "Changed the table settings");
    }

    #[test]
    fn the_ambient_glow_is_a_table_setting() {
        let hub = scratch_hub("table-glow");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("site.table", json!({ "table": { "glow": { "strength": 0.7 } } })).unwrap();
        let glow = hub.site().table.unwrap().glow.unwrap();
        assert!(glow.on, "giving the glow a setting turns it on");
        assert_eq!((glow.strength, glow.colours), (0.7, mrs_site::GlowColours::Edges));
        // A field left out stays.
        dev("site.table", json!({ "table": { "glow": { "colours": "one", "on": false } } })).unwrap();
        let glow = Site::load(&hub.site.dir).unwrap().manifest.table.unwrap().glow.unwrap();
        assert_eq!((glow.on, glow.strength, glow.colours), (false, 0.7, mrs_site::GlowColours::One));
        assert!(dev("site.table", json!({ "table": { "glow": { "strength": 3 } } })).is_err());
        assert!(dev("site.table", json!({ "table": { "glow": { "colours": "rainbow" } } })).is_err());
        dev("site.table", json!({ "table": { "glow": null } })).unwrap();
        assert!(hub.site().table.unwrap().glow.is_none());
    }

    #[test]
    fn the_opening_is_a_table_setting() {
        let hub = scratch_hub("table-intro");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        assert_eq!(hub.site().table.unwrap().intro, None, "a table without the setting fades in");
        dev("site.table", json!({ "table": { "intro": "zoom" } })).unwrap();
        assert_eq!(Site::load(&hub.site.dir).unwrap().manifest.table.unwrap().intro, Some(mrs_site::Intro::Zoom));
        assert!(dev("site.table", json!({ "table": { "intro": "spin" } })).is_err());
        dev("site.table", json!({ "table": { "intro": null } })).unwrap();
        assert_eq!(hub.site().table.unwrap().intro, None);
    }

    #[test]
    fn the_front_edge_and_ribbons_are_table_settings() {
        let hub = scratch_hub("table-ribbons");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let mut events = hub.subscribe();
        dev("site.table", json!({ "table": { "front": "left", "ribbons": { "left": { "cm": 12 }, "top": "off" } } })).unwrap();
        let table = hub.site().table.unwrap();
        assert_eq!(table.front, Some(mrs_site::TableSide::Left));
        assert_eq!(table.ribbons.left, Some(mrs_site::Ribbon::Size(mrs_site::RibbonSize { cm: 12.0 })));
        assert_eq!(table.ribbons.top, Some(mrs_site::Ribbon::Mode(mrs_site::RibbonMode::Off)));
        let saved = Site::load(&hub.site.dir).unwrap().manifest.table.unwrap();
        assert_eq!(saved.ribbons, table.ribbons);
        // Every surface hears of the new table, so the projector redraws its ribbons.
        let mut heard = false;
        while let Ok(event) = events.try_recv() {
            heard |= event.contains("\"site.changed\"");
        }
        assert!(heard);
        // null puts a side back to the automatic choice; the size stays with the place.
        dev("site.table", json!({ "table": { "front": null, "ribbons": { "top": null } } })).unwrap();
        assert_eq!(hub.site().table.unwrap().front, None);
        assert!(hub.site().table.unwrap().ribbons.top.is_none());
        assert!(dev("site.table", json!({ "table": { "front": "middle" } })).is_err());
        assert!(dev("site.table", json!({ "table": { "ribbons": { "left": { "cm": 90 } } } })).is_err());
        assert!(dev("site.table", json!({ "table": { "width_cm": 10 } })).is_err());
    }

    #[test]
    fn the_sources_a_table_uses_are_listed_by_layer() {
        let hub = scratch_hub("sources-used");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let find = |used: &Value, source: &str| used["sources"].as_array().unwrap().iter().find(|s| s["source"] == source).cloned();
        assert!(find(&dev("site.sources", json!({})).unwrap(), "mapbox").is_none());
        dev("scene.set", json!({ "layer": "basemap", "params": { "style": "source", "source": "mapbox" } })).unwrap();
        let mapbox = find(&dev("site.sources", json!({})).unwrap(), "mapbox").unwrap();
        assert_eq!(mapbox["layers"][0]["id"], "basemap");
    }

    #[test]
    fn display_quality_is_saved_and_checked() {
        let hub = scratch_hub("display");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("site.display", json!({ "display": { "quality": "best" } })).unwrap();
        assert_eq!(hub.site().display.unwrap()["quality"], "best");
        assert_eq!(Site::load(&hub.site.dir).unwrap().manifest.display.unwrap()["quality"], "best");
        assert!(dev("site.display", json!({ "display": { "quality": "ultra" } })).is_err());
        dev("site.display", json!({ "display": { "sounds": 0.8 } })).unwrap();
        assert_eq!(hub.site().display.unwrap()["sounds"], 0.8);
        assert!(dev("site.display", json!({ "display": { "sounds": 2 } })).is_err());
        assert!(dev("site.display", json!({ "display": { "fps": 60 } })).is_err());
        assert!(hub.request(Role::Phone, 0, "site.display", &json!({ "display": { "quality": "draft" } })).is_err());
        dev("site.display", json!({ "display": { "quality": null, "sounds": null } })).unwrap();
        assert!(Site::load(&hub.site.dir).unwrap().manifest.display.is_none());
    }
}
