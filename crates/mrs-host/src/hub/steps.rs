//! Slideshows and steps: sequences, sub-steps, the tick that moves playing ones on,
//! and going home when the table is left alone.

use super::*;

/// The positions of a layer and its items: the layer at `at`, then everything with it as parent.
/// The layer the sequence `id` is showing as its current step.
/// How many phase groups a drawing has: distinct `data-mrs-phase` marks, which the import
/// puts on each one (crates/mrs-site/src/plan.rs).
pub(super) fn count_phases(svg: &str) -> usize {
    let mut seen = std::collections::BTreeSet::new();
    for part in svg.split("data-mrs-phase=").skip(1) {
        let value: String = part.chars().skip(1).take_while(|c| c.is_ascii_digit()).collect();
        if !value.is_empty() {
            seen.insert(value);
        }
    }
    seen.len()
}

/// A drawing copied into the table folder by hand never went through the plan import, so its
/// groups carry no phase marks and it would show all at once with no steps (#617). It is marked
/// now the way the import does (crates/mrs-site/src/plan.rs), with the file as it was kept beside
/// it as `<name>.original.svg`. The text as it now is comes back; unchanged when it can't be read
/// as a plan or saved.
pub(super) fn mark_phases(file: &std::path::Path, text: String) -> String {
    let Ok(plan) = mrs_site::plan::read(&text) else { return text };
    if plan.phases.is_empty() || count_phases(&plan.svg) == 0 {
        return text;
    }
    let kept = file.with_extension("original.svg");
    let saved = (kept.exists() || std::fs::write(&kept, &text).is_ok()) && std::fs::write(file, &plan.svg).is_ok();
    if !saved {
        tracing::warn!("{} has no phase marks and could not be marked", file.display());
        return text;
    }
    tracing::info!("{} had no phase marks: marked {} phases, the file as it was is {}", file.display(), plan.phases.len(), kept.display());
    plan.svg
}

impl Hub {
    /// The sub-steps of a layer whose layer.json says `"sub_steps": "drawing"`: one per phase
    /// group of its drawing (`data-mrs-phase`, as the import marked them), and one more for the
    /// finale when `finale` is on. None when `reveal` is off or the drawing can't be read.
    pub(super) fn drawing_steps(&self, instance: &Instance) -> Option<StepState> {
        if self.catalog()[instance.def].manifest["sub_steps"] != "drawing" {
            return None;
        }
        let params = &instance.state.params;
        if params.get("reveal").and_then(Value::as_bool) == Some(false) {
            return None;
        }
        let info = self.info.read();
        let named = params.get("dataset").and_then(Value::as_str).unwrap_or_default();
        let path = if named.is_empty() {
            info.data.values().find(|p| p.to_lowercase().ends_with(".svg"))?.clone()
        } else {
            info.data.get(named)?.clone()
        };
        drop(info);
        let file = self.site.dir.join(path);
        let mut text = std::fs::read_to_string(&file).ok()?;
        if count_phases(&text) == 0 {
            text = mark_phases(&file, text);
        }
        let phases = count_phases(&text);
        if phases == 0 {
            return None;
        }
        let finale = params.get("finale").and_then(Value::as_bool) == Some(true);
        let count = (phases + usize::from(finale)).min(MAX_SUB_STEPS);
        let timed = instance.saved.steps.as_ref().and_then(|s| s.mode) == Some(StepMode::Timed);
        Some(StepState {
            index: 0,
            count,
            sub: None,
            playing: timed,
            title: None,
            description: None,
            source: None,
            titles: Vec::new(),
            due: None,
        })
    }

    /// A layer whose package is a sequence (the slideshow) and that has steps to show.
    pub(super) fn is_sequence(&self, instance: &Instance) -> bool {
        self.catalog()[instance.def].manifest["sequence"] == true && instance.saved.steps.as_ref().is_some_and(|s| !s.sequence.is_empty())
    }

    /// Shows step `to` of the sequence at `at`: the step's layer comes on with the step's
    /// params, and the layer the sequence showed before goes off.
    pub(super) fn show_step(&self, scene: &mut [Instance], at: usize, to: usize, now: Instant) {
        let id = scene[at].id.clone();
        let steps = scene[at].saved.steps.clone().unwrap_or_default();
        let Some(step) = steps.sequence.get(to) else { return };
        if let Some(old) = shown(scene, &id) {
            self.release(scene, old, true);
        }
        let playing = match &scene[at].state.step {
            Some(state) => state.playing,
            None => steps.mode == Some(StepMode::Timed),
        };
        scene[at].state.step = Some(StepState {
            index: to,
            count: steps.sequence.len(),
            sub: None,
            playing,
            title: step.title.clone(),
            description: step.description.clone(),
            source: step.source.clone(),
            titles: Vec::new(),
            due: None,
        });
        self.plan(scene, at, now);
        self.emit_layer(&id, &scene[at].state);
        if let Some(n) = scene.iter().position(|i| i.id == step.layer) {
            let mut params = self.catalog()[scene[n].def].defaults();
            params.extend(scene[n].saved.params.clone());
            params.extend(step.params.clone());
            scene[n].state.params = params;
            scene[n].state.shown_by = Some(id);
            scene[n].state.step = None;
            self.switch(scene, n, true);
        }
    }

    /// Takes a layer back from the sequence that showed it: its own params again, and off
    /// with `off`.
    pub(super) fn release(&self, scene: &mut [Instance], n: usize, off: bool) {
        let mut params = self.catalog()[scene[n].def].defaults();
        params.extend(scene[n].saved.params.clone());
        scene[n].state.params = params;
        scene[n].state.shown_by = None;
        scene[n].state.step = None;
        if off {
            self.switch(scene, n, false);
        } else {
            self.emit_layer(&scene[n].id, &scene[n].state);
        }
    }

    /// Moves a layer's steps. A sequence walks the shown layer's sub-steps first, then moves
    /// to its next step unless the step says to stop. Any other layer walks its sub-steps.
    pub(super) fn advance(&self, scene: &mut [Instance], at: usize, to: StepTo, now: Instant) -> Result<(), String> {
        let id = scene[at].id.clone();
        let Some(state) = scene[at].state.step.clone() else {
            return Err(format!("'{id}' has no steps"));
        };
        let looping = scene[at].saved.steps.as_ref().and_then(|s| s.r#loop).unwrap_or(true);
        if self.is_sequence(&scene[at]) {
            let steps = scene[at].saved.steps.clone().unwrap_or_default();
            let shown = shown(scene, &id);
            let sub = shown.and_then(|n| scene[n].state.step.as_ref().map(|s| (n, s.index, s.count)));
            let reveal = steps.sequence.get(state.index).and_then(|s| s.next).or(steps.reveal).unwrap_or(Reveal::ThenNext);
            let target = match to {
                StepTo::Next | StepTo::Auto => match sub {
                    Some((n, index, count)) if index < count => {
                        self.set_sub(scene, n, index + 1, now);
                        None
                    }
                    Some((_, _, count)) if count > 0 && reveal == Reveal::Stop && to == StepTo::Next => None,
                    _ => Some(state.index + 1),
                },
                StepTo::Skip => Some(state.index + 1),
                StepTo::Previous => Some(if state.index == 0 {
                    if looping {
                        state.count - 1
                    } else {
                        0
                    }
                } else {
                    state.index - 1
                }),
                StepTo::First => Some(0),
                StepTo::All => {
                    if let Some((n, _, count)) = sub {
                        self.set_sub(scene, n, count, now);
                    }
                    None
                }
                StepTo::At(n) if n >= state.count => return Err(format!("'{id}' has {} steps", state.count)),
                StepTo::At(n) => Some(n),
            };
            match target {
                Some(n) if n >= state.count && !looping => {
                    // The end: a playing sequence stops there.
                    if let Some(step) = scene[at].state.step.as_mut() {
                        step.playing = false;
                        step.due = None;
                    }
                    self.emit_layer(&id, &scene[at].state);
                }
                Some(n) => self.show_step(scene, at, n % state.count.max(1), now),
                None => {}
            }
            return Ok(());
        }
        let index = match to {
            StepTo::Next | StepTo::Auto | StepTo::Skip if state.index < state.count => state.index + 1,
            StepTo::Next | StepTo::Skip if looping => 0,
            StepTo::Next | StepTo::Auto | StepTo::Skip => {
                if let Some(step) = scene[at].state.step.as_mut() {
                    step.playing = false;
                }
                state.index
            }
            StepTo::Previous => state.index.saturating_sub(1),
            StepTo::First => 0,
            StepTo::All => state.count,
            StepTo::At(n) => n.min(state.count),
        };
        self.set_sub(scene, at, index, now);
        Ok(())
    }

    /// Reveals the first `index` sub-steps of a layer, and tells the sequence showing it.
    pub(super) fn set_sub(&self, scene: &mut [Instance], n: usize, index: usize, now: Instant) {
        if let Some(step) = scene[n].state.step.as_mut() {
            step.index = index;
        }
        self.plan(scene, n, now);
        self.emit_layer(&scene[n].id, &scene[n].state);
        self.mirror(scene, n, now);
    }

    /// Copies a shown layer's sub-steps into the sequence showing it, for the controller.
    pub(super) fn mirror(&self, scene: &mut [Instance], n: usize, now: Instant) {
        let Some(by) = scene[n].state.shown_by.clone() else { return };
        let Some(at) = scene.iter().position(|i| i.id == by) else { return };
        let sub = scene[n].state.step.as_ref().map(|s| SubSteps { index: s.index, count: s.count });
        let titles = scene[n].state.step.as_ref().map(|s| s.titles.clone()).unwrap_or_default();
        if let Some(step) = scene[at].state.step.as_mut() {
            step.sub = sub;
            step.titles = titles;
        }
        self.plan(scene, at, now);
        self.emit_layer(&by, &scene[at].state);
    }

    /// Sets when a playing layer moves on: the next sub-step after a short pause, otherwise
    /// the next step after the step's duration.
    pub(super) fn plan(&self, scene: &mut [Instance], at: usize, now: Instant) {
        let sequence = self.is_sequence(&scene[at]);
        let duration = scene[at]
            .state
            .step
            .as_ref()
            .and_then(|s| scene[at].saved.steps.as_ref()?.sequence.get(s.index)?.duration_s)
            .filter(|d| d.is_finite() && *d > 0.0)
            .unwrap_or(STEP_SECONDS);
        let Some(step) = scene[at].state.step.as_mut() else { return };
        let left = match (sequence, step.sub) {
            (true, Some(sub)) => sub.index < sub.count,
            (true, None) => false,
            (false, _) => step.index < step.count,
        };
        let seconds = if left { SUB_STEP_SECONDS } else { duration };
        // Sub-steps are played by the sequence showing the layer, not by the layer itself.
        let shown = scene[at].state.shown_by.is_some();
        step.due = (step.playing && !shown && (sequence || left)).then(|| now + Duration::from_secs_f64(seconds));
    }

    /// Moves on every playing layer whose time has come. The host calls it a few times a second.
    pub fn tick(&self) {
        self.tick_at(Instant::now());
    }

    pub(super) fn tick_at(&self, now: Instant) {
        let mut inner = self.inner.lock();
        let scene = &mut inner.scene;
        self.idle_reset(scene, now);
        let due: Vec<String> = scene
            .iter()
            .filter(|i| i.state.active && i.state.step.as_ref().is_some_and(|s| s.playing && s.due.is_some_and(|d| d <= now)))
            .map(|i| i.id.clone())
            .collect();
        for id in due {
            if let Some(at) = scene.iter().position(|i| i.id == id) {
                if let Err(e) = self.advance(scene, at, StepTo::Auto, now) {
                    tracing::warn!("{id}: {e}");
                }
            }
        }
    }

    /// After `tv.idle_reset_s` seconds (default 180, 0 for never) with nobody doing anything on
    /// any surface, the table goes home as Reset does (#74, #604), so the next visitor finds the
    /// welcome. One timer for the whole table: a controller page that nobody touches does not
    /// reset a table that people are using from another screen, the editor or their phones.
    /// It runs only while a controller is connected.
    pub(super) fn idle_reset(&self, scene: &mut [Instance], now: Instant) {
        let seconds = self.info.read().tv.as_ref().and_then(|tv| tv["idle_reset_s"].as_f64()).unwrap_or(DEFAULT_IDLE_RESET_S);
        if seconds <= 0.0 || self.controllers.lock().is_empty() {
            return;
        }
        {
            let mut last = self.last_input.lock();
            if now.saturating_duration_since(*last) < Duration::from_secs_f64(seconds) {
                return;
            }
            *last = now;
        }
        let catalog = self.catalog();
        let open = scene.iter().any(|i| i.parent.is_none() && i.state.active && !at_rest(&catalog[i.def], i));
        if open {
            tracing::info!("nobody used the table for {seconds} s: back to the welcome");
            self.reset(scene);
            self.emit("table.intro", json!({}));
        }
    }

    /// Reads the `steps` of a `scene.set`; null clears them. Steps that show other layers are
    /// only for a sequence layer, and each step's params are checked against the layer it
    /// shows. Whether each step's layer may be shown is checked with the rest of the site.
    pub(super) fn clean_steps(&self, scene: &[Instance], index: usize, value: &Value) -> Result<Option<Steps>, String> {
        if value.is_null() {
            return Ok(None);
        }
        if scene[index].parent.is_some() {
            return Err("an item has no steps: it comes on with its layer".into());
        }
        let mut steps: Steps = serde_json::from_value(value.clone()).map_err(|e| format!("steps: {e}"))?;
        let def = &self.catalog()[scene[index].def];
        if !steps.sequence.is_empty() && def.manifest["sequence"] != true {
            return Err(format!("only a sequence, such as the slideshow, has steps that show other layers; '{}' is not one", def.id));
        }
        for step in &mut steps.sequence {
            if step.params.is_empty() {
                continue;
            }
            let shown = scene
                .iter()
                .find(|i| i.id == step.layer)
                .ok_or_else(|| format!("a step shows '{}', which is not in the scene", step.layer))?;
            step.params =
                self.catalog()[shown.def].validate(&step.params, false).map_err(|e| format!("a step showing '{}': {e}", step.layer))?;
        }
        Ok(Some(steps))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::test_support::*;

    #[test]
    fn a_sequence_that_opens_on_one_of_its_own_items_shows_it() {
        let hub = scratch_hub("first-item");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("scene.add", json!({ "use": "trees", "parent": "slideshow", "id": "slide-trees" })).unwrap();
        dev("scene.set", json!({ "layer": "slideshow", "steps": { "sequence": [{ "layer": "slide-trees" }, { "layer": "sunlight" }] } }))
            .unwrap();
        dev("layer.activate", json!({ "layer": "slideshow", "active": true })).unwrap();
        let trees = layer(&hub, "slide-trees");
        assert_eq!((trees["active"].clone(), trees["shown_by"].clone()), (json!(true), json!("slideshow")));
        dev("layer.activate", json!({ "layer": "slideshow", "active": false })).unwrap();
        assert_eq!(layer(&hub, "slide-trees")["active"], false);
    }

    #[test]
    fn the_table_goes_home_only_when_nobody_anywhere_has_done_anything() {
        let hub = scratch_hub("idle");
        let open = |hub: &Hub| layer(hub, "sunlight")["active"] == json!(true);
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("layer.activate", json!({ "layer": "sunlight", "active": true })).unwrap();
        // No controller connected: nothing goes home, however long.
        hub.tick_at(Instant::now() + Duration::from_secs(3600));
        assert!(open(&hub));
        let controller = hub.join(Role::Tv, None, None).unwrap().surface;
        let at = Instant::now();
        hub.tick_at(at + Duration::from_secs(170));
        assert!(open(&hub), "not yet: 3 minutes by default");
        // Someone uses the editor, a phone or another screen: the controller page itself was never touched.
        dev("layer.set", json!({ "layer": "sunlight", "params": { "hour": 9 } })).unwrap();
        hub.tick_at(Instant::now() + Duration::from_secs(170));
        assert!(open(&hub), "the editor's change counts");
        hub.request(Role::Table, 0, "session.input", &json!({})).unwrap();
        hub.tick_at(Instant::now() + Duration::from_secs(170));
        assert!(open(&hub), "a touch on the table counts");
        // The table's own layers sending requests is not a person.
        let quiet = Instant::now();
        let _ = hub.request(Role::Table, 0, "layer.set", &json!({ "layer": "sunlight", "params": { "hour": 10 } }));
        let mut events = hub.subscribe();
        hub.tick_at(quiet + Duration::from_secs(181));
        assert!(!open(&hub), "nobody for 3 minutes: home");
        let sent: Vec<Value> = std::iter::from_fn(|| events.try_recv().ok()).map(|e| serde_json::from_str(&e).unwrap()).collect();
        assert!(sent.iter().any(|e| e["m"] == "table.intro"), "the table plays its opening zoom");
        // 0 is never.
        dev("site.tv", json!({ "tv": { "idle_reset_s": 0 } })).unwrap();
        dev("layer.activate", json!({ "layer": "sunlight", "active": true })).unwrap();
        hub.tick_at(Instant::now() + Duration::from_secs(3600));
        assert!(open(&hub));
        // With the controller gone, nothing goes home either.
        dev("site.tv", json!({ "tv": { "idle_reset_s": 60 } })).unwrap();
        hub.leave(controller);
        hub.tick_at(Instant::now() + Duration::from_secs(3600));
        assert!(open(&hub));
    }

    #[test]
    fn a_masterplan_steps_through_its_phases_without_a_table_window() {
        let hub = scratch_hub_with("plan-steps", |dir| {
            let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g data-mrs-phase="0" data-mrs-name="Roads"><path d="M0 0L1 1"/></g><g data-mrs-phase="1" data-mrs-name="Parks"><path d="M0 0L2 2"/></g><g data-mrs-phase="2" data-mrs-name="Homes"><path d="M0 0L3 3"/></g></svg>"#;
            std::fs::write(dir.join("data/plan.svg"), svg).unwrap();
            let path = dir.join("site.json");
            let mut site: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            site["data"]["plan"] = json!("data/plan.svg");
            std::fs::write(&path, serde_json::to_string_pretty(&site).unwrap()).unwrap();
        });
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let tv = |method: &str, p: Value| hub.request(Role::Tv, 0, method, &p);
        dev("scene.add", json!({ "use": "plan", "id": "vision", "button": { "name": "Vision" } })).unwrap();
        assert!(tv("layer.step", json!({ "layer": "vision", "to": "next" })).is_err(), "off: no steps yet");
        // On, and with no table window open, the phases are already steps (#421).
        tv("layer.activate", json!({ "layer": "vision", "active": true })).unwrap();
        assert_eq!(layer(&hub, "vision")["step"]["count"], 3);
        tv("layer.step", json!({ "layer": "vision", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "vision")["step"]["index"], 1);
        // A table window then reports the same phases with names: the reveal stays.
        dev("layer.substeps", json!({ "layer": "vision", "count": 3, "titles": ["Roads", "Parks", "Homes"] })).unwrap();
        assert_eq!(layer(&hub, "vision")["step"]["index"], 1);
        assert_eq!(layer(&hub, "vision")["step"]["titles"], json!(["Roads", "Parks", "Homes"]));
        tv("layer.step", json!({ "layer": "vision", "to": "all" })).unwrap();
        assert_eq!(layer(&hub, "vision")["step"]["index"], 3);
        // The finale is one more step.
        tv("layer.activate", json!({ "layer": "vision", "active": false })).unwrap();
        dev("layer.set", json!({ "layer": "vision", "params": { "finale": true } })).unwrap();
        tv("layer.activate", json!({ "layer": "vision", "active": true })).unwrap();
        assert_eq!(layer(&hub, "vision")["step"]["count"], 4);
        assert_eq!(count_phases(r#"<g data-mrs-phase="0"></g><g data-mrs-phase='1'><g data-mrs-phase="1"></g></g>"#), 2);
    }

    #[test]
    fn a_drawing_copied_in_by_hand_is_marked_into_phases() {
        // Campus Vision (#617): the SVG was copied into data/ without the import, so no marks.
        let hub = scratch_hub_with("plan-unmarked", |dir| {
            let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="projektgräns"><path d="M0 0L1 1"/></g><g id="LEVANDE-CAMPUS"><path d="M0 0L2 2"/></g><g id="Gröna-mötesplatser"><path d="M0 0L3 3"/></g></svg>"#;
            std::fs::write(dir.join("data/campus.svg"), svg).unwrap();
            let path = dir.join("site.json");
            let mut site: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            site["data"]["campus"] = json!("data/campus.svg");
            std::fs::write(&path, serde_json::to_string_pretty(&site).unwrap()).unwrap();
        });
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("scene.add", json!({ "use": "plan", "id": "vision", "params": { "dataset": "campus" }, "button": { "name": "Vision" } }))
            .unwrap();
        dev("layer.activate", json!({ "layer": "vision", "active": true })).unwrap();
        assert_eq!(layer(&hub, "vision")["step"]["count"], 3);
        let marked = std::fs::read_to_string(hub.site.dir.join("data/campus.svg")).unwrap();
        assert_eq!(count_phases(&marked), 3, "the file itself is marked, so the table draws the phases too");
        let kept = std::fs::read_to_string(hub.site.dir.join("data/campus.original.svg")).unwrap();
        assert_eq!(count_phases(&kept), 0, "the file as it was is kept");
    }

    #[test]
    fn a_sequence_shows_its_steps_and_next_walks_sub_steps_first() {
        let hub = scratch_hub("steps");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("layer.activate", json!({ "layer": "trees", "active": false })).unwrap();
        dev("scene.add", json!({ "use": "trees", "parent": "slideshow", "id": "slide-trees" })).unwrap();
        let steps = json!({ "mode": "manual", "loop": false, "sequence": [
            { "layer": "sunlight", "params": { "hour": 9 }, "title": "Morning" },
            { "layer": "slide-trees", "params": { "size": 2 } },
            { "layer": "trees", "next": "stop" }
        ] });
        dev("scene.set", json!({ "layer": "slideshow", "steps": steps })).unwrap();
        assert_eq!(layer(&hub, "slide-trees")["active"], false, "a sequence's item waits for its step");

        // Opening the slideshow shows the first step at once, with that step's params.
        dev("layer.activate", json!({ "layer": "slideshow", "active": true })).unwrap();
        let show = layer(&hub, "slideshow");
        assert_eq!(show["step"], json!({ "index": 0, "count": 3, "playing": false, "title": "Morning" }));
        let sun = layer(&hub, "sunlight");
        assert_eq!(
            (sun["active"].clone(), sun["params"]["hour"].clone(), sun["shown_by"].clone()),
            (json!(true), json!(9.0), json!("slideshow"))
        );

        // Next: the sun study goes off with its own params back, the slideshow's own trees come on.
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        let sun = layer(&hub, "sunlight");
        assert_eq!((sun["active"].clone(), sun["params"]["hour"].clone(), sun["shown_by"].clone()), (json!(false), json!(15), Value::Null));
        assert_eq!(layer(&hub, "slide-trees")["active"], true);
        assert_eq!(layer(&hub, "slide-trees")["params"]["size"], 2.0);

        // A step's layer reports sub-steps: Next reveals them one by one, then moves on.
        assert!(dev("layer.substeps", json!({ "layer": "slide-trees", "count": 2 })).is_ok());
        assert!(
            hub.request(Role::Phone, 0, "layer.substeps", &json!({ "layer": "slide-trees", "count": 2 })).is_err(),
            "only the table reports"
        );
        assert_eq!(layer(&hub, "slideshow")["step"]["sub"], json!({ "index": 0, "count": 2 }));
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "slide-trees")["step"]["index"], 1);
        // A second view of the table starting the layer reports the same sub-steps: the reveal stays.
        dev("layer.substeps", json!({ "layer": "slide-trees", "count": 2 })).unwrap();
        assert_eq!(layer(&hub, "slide-trees")["step"]["index"], 1);
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["sub"], json!({ "index": 2, "count": 2 }));
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 2);
        assert_eq!(layer(&hub, "slide-trees")["active"], false);

        // The last step says stop: once its sub-steps are revealed, Next stays; skip moves on.
        dev("layer.substeps", json!({ "layer": "trees", "count": 1, "titles": ["Oaks"] })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["titles"], json!(["Oaks"]));
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 2, "stop holds the step");
        // Without loop, skipping past the end stays on the last step.
        dev("layer.step", json!({ "layer": "slideshow", "to": "skip" })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 2);
        dev("layer.step", json!({ "layer": "slideshow", "to": "first" })).unwrap();
        assert_eq!(layer(&hub, "sunlight")["active"], true);
        assert_eq!(layer(&hub, "trees")["active"], false);
        assert!(dev("layer.step", json!({ "layer": "slideshow", "to": 7 })).is_err());

        // Opening a shown layer from its own button leaves the slideshow: closing the slideshow keeps it.
        dev("layer.activate", json!({ "layer": "sunlight", "active": true })).unwrap();
        assert_eq!(layer(&hub, "sunlight")["shown_by"], Value::Null);
        assert_eq!(layer(&hub, "sunlight")["params"]["hour"], 15);
        dev("layer.activate", json!({ "layer": "slideshow", "active": false })).unwrap();
        assert_eq!(layer(&hub, "sunlight")["active"], true);
        assert_eq!(layer(&hub, "slideshow")["step"], Value::Null);
        assert!(dev("layer.step", json!({ "layer": "slideshow", "to": "next" })).is_err(), "closed");
    }

    #[test]
    fn a_timed_sequence_moves_on_by_itself() {
        let hub = scratch_hub("timed");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let steps = json!({ "mode": "timed", "sequence": [
            { "layer": "sunlight", "duration_s": 5 },
            { "layer": "wind" }
        ] });
        dev("scene.set", json!({ "layer": "slideshow", "steps": steps })).unwrap();
        dev("layer.activate", json!({ "layer": "slideshow", "active": true })).unwrap();
        assert_eq!(layer(&hub, "slideshow")["step"]["playing"], true);
        let t0 = Instant::now();
        hub.tick_at(t0 + Duration::from_secs(4));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 0);
        hub.tick_at(t0 + Duration::from_secs(6));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 1);
        assert_eq!(layer(&hub, "wind")["active"], true);
        // The default step is eight seconds, and the sequence loops by default.
        hub.tick_at(t0 + Duration::from_secs(13));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 1);
        hub.tick_at(t0 + Duration::from_secs(15));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 0);
        // Paused, it stays.
        dev("layer.play", json!({ "layer": "slideshow", "playing": false })).unwrap();
        hub.tick_at(t0 + Duration::from_secs(60));
        assert_eq!(layer(&hub, "slideshow")["step"]["index"], 0);
    }

    #[test]
    fn a_layer_of_its_own_walks_its_sub_steps() {
        let hub = scratch_hub("substeps");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        assert!(dev("layer.step", json!({ "layer": "trees", "to": "next" })).is_err(), "no sub-steps reported");
        dev("layer.substeps", json!({ "layer": "trees", "count": 3 })).unwrap();
        dev("layer.step", json!({ "layer": "trees", "to": "next" })).unwrap();
        dev("layer.step", json!({ "layer": "trees", "to": "all" })).unwrap();
        assert_eq!(layer(&hub, "trees")["step"]["index"], 3);
        dev("layer.step", json!({ "layer": "trees", "to": "previous" })).unwrap();
        assert_eq!(layer(&hub, "trees")["step"]["index"], 2);
        dev("layer.activate", json!({ "layer": "trees", "active": false })).unwrap();
        assert_eq!(layer(&hub, "trees")["step"], Value::Null, "reported again when it opens");
    }
}
