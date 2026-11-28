//! The request handler: one lock per request, then each method to its part.

use super::*;

impl Hub {
    pub(super) fn handle(&self, role: Role, surface: u64, method: &str, p: &Value) -> Result<Value, String> {
        // Recording takes the hub's lock itself, for its start snapshot (#521).
        if method.starts_with("recording.") {
            return self.recording_request(role, surface, method, p);
        }
        self.recording_limits();
        // One lock for the whole request, so changes and their events keep one order.
        let mut inner = self.inner.lock();
        if self.fault.swap(false, std::sync::atomic::Ordering::SeqCst) {
            panic!("a fault was injected");
        }
        // In the log in the order the requests are handled (#521).
        self.record_request(&inner, role, surface, method, p);
        if method.starts_with("scene.") {
            if !role.may_compose() {
                return Err("this surface cannot edit the scene".into());
            }
            return self.compose(&mut inner, method, p, Who::of(role, surface));
        }
        if method == "site.tv" {
            if !role.may_compose() {
                return Err("this surface cannot change the table's settings".into());
            }
            return self.set_tv(p, Who::of(role, surface));
        }
        if method == "site.table" {
            if !role.may_compose() {
                return Err("this surface cannot change the table's settings".into());
            }
            return self.set_table(p, Who::of(role, surface));
        }
        if method == "site.sources" {
            if role.from_a_phone() {
                return Err("phones cannot see the table's sources".into());
            }
            return Ok(self.sources_used(&inner));
        }
        if method == "site.display" {
            if !role.may_compose() {
                return Err("this surface cannot change the table's settings".into());
            }
            return self.set_display(p, Who::of(role, surface));
        }
        if method.starts_with("custom.") || method == "palette.set" || method == "data.remove" {
            if !role.may_compose() {
                return Err("this surface cannot edit the table".into());
            }
            return self.author(&mut inner, method, p, Who::of(role, surface));
        }
        if method == "session.language" {
            if !matches!(role, Role::Tv | Role::Dev | Role::Guide) {
                return Err("only the controller switches the table's language".into());
            }
            let language = p["language"].as_str().ok_or("say which language: en or sv")?;
            let branding = self.info.read().branding.clone();
            if !offered(&branding).iter().any(|l| l == language) {
                return Err(format!("this table does not offer '{language}'; turn it on in Table settings"));
            }
            *self.language.write() = language.to_string();
            self.emit("session.changed", json!({ "session": self.session() }));
            return Ok(json!({ "language": language }));
        }
        if method == "session.sound" {
            if !matches!(role, Role::Tv | Role::Dev | Role::Guide) {
                return Err("only the controller turns the table's sound on or off".into());
            }
            let on = p["on"].as_bool().ok_or("say on: true or false")?;
            *self.sound.write() = on;
            self.emit("session.changed", json!({ "session": self.session() }));
            return Ok(json!({ "sound": on }));
        }
        if method == "session.performance" {
            if !matches!(role, Role::Tv | Role::Dev) {
                return Err("only the operator shows or hides the frame meter".into());
            }
            let on = p["on"].as_bool().ok_or("say on: true or false")?;
            *self.performance.write() = on;
            self.emit("session.changed", json!({ "session": self.session() }));
            return Ok(json!({ "performance": on }));
        }
        if method == "phones.pause" || method == "phones.release" || method == "phones.log" {
            if !matches!(role, Role::Tv | Role::Dev) {
                return Err("only the operator looks after the phones".into());
            }
            return Ok(match method {
                "phones.pause" => {
                    let paused = p["paused"].as_bool().ok_or("say paused: true or false")?;
                    *self.phones_paused.write() = paused;
                    self.emit("session.changed", json!({ "session": self.session() }));
                    json!({ "paused": paused })
                }
                "phones.release" => {
                    // One phone by its slot, or every phone: the end of a round.
                    let slot = match &p["slot"] {
                        Value::Null => None,
                        value => Some(value.as_u64().ok_or("slot is a number")? as usize),
                    };
                    let mut gone = Vec::new();
                    for seat in inner.seats.iter().filter(|s| slot.is_none_or(|slot| s.participant.slot == slot)) {
                        gone.push(seat.participant.surface);
                    }
                    if slot.is_some() && gone.is_empty() {
                        return Err("no phone in that slot".into());
                    }
                    for surface in &gone {
                        self.note_phone(&inner.seats, *surface, "released", json!({}));
                    }
                    self.released.lock().extend(gone.iter().copied());
                    for seat in inner.seats.iter().filter(|s| gone.contains(&s.participant.surface)) {
                        seat.kick.notify_one();
                    }
                    inner.seats.retain(|s| !gone.contains(&s.participant.surface));
                    self.emit("state.participants", json!({ "participants": inner.participants() }));
                    json!({ "released": gone.len() })
                }
                _ => json!({ "log": self.phone_log.lock().iter().collect::<Vec<_>>() }),
            });
        }
        // Paused by the operator (#335), or watching while the table is full (#462), a phone can
        // look at layers but change nothing on the table.
        let watching = role == Role::Phone && inner.watching.iter().any(|w| w.surface == surface);
        if watching
            && matches!(
                method,
                "layer.activate" | "layer.set" | "layer.action" | "tool.input" | "layer.entity" | "layer.select" | "layer.step"
            )
        {
            return Err("watching: every seat at the table is taken".into());
        }
        if role == Role::Phone
            && matches!(
                method,
                "layer.activate"
                    | "layer.set"
                    | "layer.action"
                    | "tool.input"
                    | "layer.entity"
                    | "layer.select"
                    | "layer.step"
                    | "participant.profile"
            )
            && self.awaits_consent(&inner, surface)
        {
            return Err("this session is being recorded: answer the notice first".into());
        }
        if role == Role::Phone
            && *self.phones_paused.read()
            && matches!(
                method,
                "layer.activate" | "layer.set" | "layer.action" | "tool.input" | "layer.entity" | "layer.select" | "layer.step"
            )
        {
            return Err("the phones are paused for a moment".into());
        }
        if method == "participant.profile" {
            if role != Role::Phone {
                return Err("only a phone has a name and an animal".into());
            }
            let seat = inner.seats.iter_mut().find(|s| s.participant.surface == surface).ok_or("this phone has no seat")?;
            if let Some(avatar) = p.get("avatar").filter(|v| !v.is_null()) {
                let avatar = avatar.as_str().and_then(|a| AVATARS.iter().find(|x| **x == a)).ok_or("pick one of the animals offered")?;
                seat.participant.avatar = avatar;
            }
            if let Some(name) = p.get("name") {
                seat.participant.name = match name {
                    Value::Null => None,
                    Value::String(name) => clean_name(name)?,
                    _ => return Err("a name is text".into()),
                };
            }
            let me = seat.participant.clone();
            self.emit("state.participants", json!({ "participants": inner.participants() }));
            return Ok(json!({ "participant": me }));
        }
        if method == "session.ribbon" {
            if !matches!(role, Role::Tv | Role::Dev | Role::Guide) {
                return Err("only the controller chooses the table's ribbon".into());
            }
            let layer = match &p["layer"] {
                Value::Null => None,
                Value::String(id) => {
                    if !inner.scene.iter().any(|i| &i.id == id) {
                        return Err(format!("no layer '{id}' on this table"));
                    }
                    Some(id.clone())
                }
                _ => return Err("say layer: an instance id, or null for Auto".into()),
            };
            *self.ribbon.write() = layer.clone();
            self.emit("session.changed", json!({ "session": self.session() }));
            return Ok(json!({ "ribbon": layer }));
        }
        if method == "session.input" {
            // Someone touched a screen (#604): `request` notes the time for the idle reset.
            return Ok(json!({}));
        }
        if method == "session.guide" {
            if !matches!(role, Role::Tv | Role::Dev) {
                return Err("only the operator's screens see the guide's code".into());
            }
            return Ok(self.guide());
        }
        if method == "layers.reset" {
            if !role.may_activate() {
                return Err("phones cannot turn layers on or off".into());
            }
            self.reset(&mut inner.scene);
            // The table plays its opening zoom again (#446).
            self.emit("table.intro", json!({}));
            return Ok(json!({}));
        }
        let layer = p["layer"].as_str().ok_or("missing layer")?;
        let index = inner.position(layer)?;
        if method == "layer.activate" {
            if role == Role::Phone {
                self.phone_may_switch(&inner.scene, index)?;
            } else if !role.may_activate() {
                return Err("phones cannot turn layers on or off".into());
            }
            let active = p["active"].as_bool().ok_or("missing active")?;
            if let Some(parent) = inner.scene[index].parent.clone() {
                if active && !inner.scene[inner.position(&parent)?].state.active {
                    return Err(format!("'{layer}' comes on with '{parent}'; open that layer first"));
                }
            }
            // Opened from its own button, a layer a sequence is showing leaves the sequence.
            if active && inner.scene[index].state.shown_by.is_some() {
                self.release(&mut inner.scene, index, false);
            }
            self.switch(&mut inner.scene, index, active);
            // The controller says which phone did it, in that phone's colour (#335). The layers a
            // phone closes to make way (`cue: false`) are not worth a word.
            if role == Role::Phone && p["cue"].as_bool() != Some(false) {
                let mut event = json!({ "layer": layer, "active": active });
                if let Some(seat) = inner.seats.iter().find(|s| s.participant.surface == surface) {
                    event["participant"] = json!({ "slot": seat.participant.slot, "colour": seat.participant.colour, "avatar": seat.participant.avatar, "mood": seat.participant.mood, "name": seat.participant.name });
                }
                self.note_phone(&inner.seats, surface, if active { "turned on" } else { "turned off" }, json!({ "layer": layer }));
                self.emit("phone.switched", event);
            }
            return Ok(json!({}));
        }
        match method {
            "layer.step" => {
                let to = StepTo::parse(&p["to"])?;
                if to == StepTo::Auto {
                    return Err("missing to".into());
                }
                if !inner.scene[index].state.active {
                    return Err(format!("'{layer}' is off; open it first"));
                }
                self.advance(&mut inner.scene, index, to, Instant::now())?;
                return Ok(json!({}));
            }
            "layer.play" => {
                let playing = p["playing"].as_bool().ok_or("missing playing")?;
                let now = Instant::now();
                let scene = &mut inner.scene;
                let step = scene[index].state.step.as_mut().ok_or_else(|| format!("'{layer}' has no steps to play"))?;
                step.playing = playing;
                self.plan(scene, index, now);
                self.emit_layer(&scene[index].id, &scene[index].state);
                return Ok(json!({}));
            }
            "layer.substeps" => {
                if !role.may_publish() {
                    return Err("only the table reports a layer's sub-steps".into());
                }
                let count = p["count"].as_u64().ok_or("missing count")? as usize;
                if count > MAX_SUB_STEPS {
                    return Err(format!("a layer has at most {MAX_SUB_STEPS} sub-steps"));
                }
                let titles: Vec<String> = match &p["titles"] {
                    Value::Null => Vec::new(),
                    Value::Array(list) => {
                        list.iter().take(count).map(|t| t.as_str().unwrap_or_default().chars().take(80).collect()).collect()
                    }
                    _ => return Err("titles is a list of words".into()),
                };
                let scene = &mut inner.scene;
                if !scene[index].state.active {
                    return Err(format!("'{layer}' is off"));
                }
                // Every view of the table running the layer reports its sub-steps as it starts. The same
                // sub-steps again (a projector and an editor, or a view joining late) keep the reveal where it is.
                if scene[index].state.step.as_ref().is_some_and(|s| s.count == count && s.titles == titles) {
                    return Ok(json!({}));
                }
                // The same number with names now (the host counted a drawing's phases before the
                // table read their names, #421): keep the reveal, take the names.
                if let Some(step) = scene[index].state.step.as_mut().filter(|s| s.count == count && s.titles.is_empty()) {
                    step.titles = titles;
                    self.emit_layer(&scene[index].id, &scene[index].state);
                    self.mirror(scene, index, Instant::now());
                    return Ok(json!({}));
                }
                let timed = scene[index].saved.steps.as_ref().and_then(|s| s.mode) == Some(StepMode::Timed);
                scene[index].state.step = (count > 0).then_some(StepState {
                    index: 0,
                    count,
                    sub: None,
                    playing: timed,
                    title: None,
                    description: None,
                    source: None,
                    titles,
                    due: None,
                });
                let now = Instant::now();
                self.plan(scene, index, now);
                self.emit_layer(&scene[index].id, &scene[index].state);
                self.mirror(scene, index, now);
                return Ok(json!({}));
            }
            _ => {}
        }
        let def = &self.catalog()[inner.scene[index].def];
        // Who sent it, when a phone did: tool inputs and actions carry it to the table (#335, #423).
        let sender = inner.seats.iter().find(|s| s.participant.surface == surface).map(|seat| {
            json!({ "slot": seat.participant.slot, "colour": seat.participant.colour, "avatar": seat.participant.avatar, "mood": seat.participant.mood, "name": seat.participant.name })
        });
        // What goes in the phones' session log (#335) once the request is done.
        let mut noted: Option<(&str, Value)> = None;
        let state = &mut inner.scene[index].state;
        match method {
            "layer.intensity" => {
                if !role.may_activate() {
                    return Err("phones cannot change a layer's intensity".into());
                }
                state.intensity = p["intensity"].as_f64().filter(|v| v.is_finite()).ok_or("missing intensity")?.clamp(0.0, 2.0);
                self.emit_layer(layer, state);
            }
            "layer.set" => {
                let patch = p["params"].as_object().ok_or("missing params")?;
                let checked = def.validate(patch, role == Role::Phone)?;
                noted = Some(("set", json!({ "layer": layer, "params": checked })));
                state.params.extend(checked);
                self.emit_layer(layer, state);
            }
            "layer.entity" => {
                // One or more entities' values (#279): merged into `params.entities`, or put back with `reset`.
                let sid = p["set"].as_str().ok_or("missing set")?;
                let set = def.entity_set(sid).ok_or_else(|| format!("layer '{layer}' has no entity set '{sid}'"))?;
                let ids: Vec<&str> = match (&p["ids"], &p["id"]) {
                    (Value::Array(ids), _) => ids.iter().map(|id| id.as_str().ok_or("ids must be strings")).collect::<Result<_, _>>()?,
                    (Value::Null, Value::String(id)) => vec![id.as_str()],
                    _ => return Err("missing ids".into()),
                };
                if ids.is_empty() || ids.len() > crate::layers::MOST_ENTITIES || !ids.iter().all(|id| crate::layers::is_entity_id(id)) {
                    return Err("ids must be 1 to 10000 entity ids".into());
                }
                let mut all = state.params.get(crate::layers::ENTITIES).and_then(Value::as_object).cloned().unwrap_or_default();
                let mut of_set = all.get(sid).and_then(Value::as_object).cloned().unwrap_or_default();
                if p["reset"].as_bool() == Some(true) {
                    for id in &ids {
                        of_set.remove(*id);
                    }
                } else {
                    let clean = set.validate(p["values"].as_object().ok_or("missing values")?, role == Role::Phone)?;
                    for id in &ids {
                        let mut values = of_set.get(*id).and_then(Value::as_object).cloned().unwrap_or_default();
                        values.extend(clean.clone());
                        set.changed_only(&mut values);
                        if values.is_empty() {
                            of_set.remove(*id);
                        } else {
                            of_set.insert(id.to_string(), Value::Object(values));
                        }
                    }
                }
                if of_set.is_empty() {
                    all.remove(sid);
                } else {
                    all.insert(sid.to_string(), Value::Object(of_set));
                }
                let kept: usize = all.values().filter_map(Value::as_object).map(Map::len).sum();
                if kept > crate::layers::MOST_ENTITIES {
                    return Err(format!("at most {} entities can have their own values", crate::layers::MOST_ENTITIES));
                }
                if all.is_empty() {
                    state.params.remove(crate::layers::ENTITIES);
                } else {
                    state.params.insert(crate::layers::ENTITIES.into(), Value::Object(all));
                }
                self.emit_layer(layer, state);
            }
            "layer.select" => {
                // The entity picked on the table or the controller (#279), or none.
                let sid = p["set"].as_str().ok_or("missing set")?;
                if def.entity_set(sid).is_none() {
                    return Err(format!("layer '{layer}' has no entity set '{sid}'"));
                }
                let selection = match &p["id"] {
                    Value::Null => None,
                    Value::String(id) if crate::layers::is_entity_id(id) => Some(json!({ "set": sid, "id": id })),
                    _ => return Err("id must be an entity id or null".into()),
                };
                if state.selection != selection {
                    state.selection = selection;
                    self.emit_layer(layer, state);
                }
            }
            "layer.clock" => {
                // The table moves the play head (#373): where it is now and how fast it runs.
                if !role.may_publish() {
                    return Err("only the table moves a layer's play head".into());
                }
                let value = p["value"].as_f64().filter(|v| v.is_finite()).ok_or("missing value")?;
                let rate = p["rate"].as_f64().filter(|v| v.is_finite()).unwrap_or(0.0);
                if rate.abs() > MAX_CLOCK_RATE {
                    return Err(format!("a play head runs at most {MAX_CLOCK_RATE} a second"));
                }
                state.clock = Some(LayerClock { value, rate, at: host_millis() });
                self.emit_layer(layer, state);
            }
            "layer.publish" => {
                if !role.may_publish() {
                    return Err("only the table publishes".into());
                }
                state.shared.extend(p["values"].as_object().ok_or("missing values")?.clone());
                self.emit_layer(layer, state);
            }
            "layer.health" => {
                // The table says how the layer is doing (#259): trouble, or running again.
                if !role.may_publish() {
                    return Err("only the table reports how a layer is doing".into());
                }
                let health = match p["status"].as_str().ok_or("missing status")? {
                    "running" | "starting" => None,
                    status @ ("retrying" | "failed") => Some(LayerHealth {
                        status: status.to_string(),
                        reason: p["reason"].as_str().unwrap_or("it could not start").chars().take(MAX_HEALTH_REASON).collect(),
                        retry_in: p["retry_in"].as_f64().filter(|s| s.is_finite() && *s >= 0.0).map(|s| s.min(3600.0)),
                    }),
                    other => return Err(format!("'{other}' is not a layer status")),
                };
                // A layer that went off meanwhile has nothing to report.
                if !state.active || state.health == health {
                    return Ok(json!({}));
                }
                let name = state
                    .button
                    .name
                    .clone()
                    .filter(|n| !n.is_empty())
                    .or_else(|| def.manifest["name"].as_str().map(String::from))
                    .unwrap_or_else(|| layer.to_string());
                // The operator log hears when trouble starts and when it ends, not every retry.
                let incident = match (&state.health, &health) {
                    (None, Some(h)) => Some(format!("The layer '{name}' is not running: {}. Trying again.", h.reason)),
                    (Some(_), None) => Some(format!("The layer '{name}' is running again.")),
                    _ => None,
                };
                state.health = health;
                self.emit_layer(layer, state);
                return Ok(json!({ "incident": incident }));
            }
            "layer.retry" => {
                // Retry from the editor or the controller (#259): the table starts the layer again now.
                if !matches!(role, Role::Tv | Role::Dev) {
                    return Err("only the operator's screens retry a layer".into());
                }
                if state.health.is_some() {
                    self.emit("layer.retry", json!({ "layer": layer }));
                }
            }
            "layer.action" => {
                let action = p["action"].as_str().ok_or("missing action")?;
                let control = def.control(action).filter(|c| matches!(c.kind, crate::ControlKind::Action));
                let named = def.actions.iter().any(|a| a == action);
                if control.is_none() && !named {
                    return Err(format!("layer '{layer}' has no action '{action}'"));
                }
                // Named actions (#283) come from the controller's stage, never from a phone.
                if role == Role::Phone && !control.is_some_and(|c| c.phone) {
                    return Err(format!("'{action}' cannot be used from a phone"));
                }
                let mut event = json!({ "layer": layer, "action": action, "from": surface });
                if let Some(sender) = &sender {
                    event["participant"] = sender.clone();
                }
                // A few words typed with the press (#462), for an action that asks for them.
                if let Some(max) = control.and_then(|c| c.words) {
                    let words = p["words"].as_str().map(|w| w.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or_default();
                    if words.is_empty() {
                        return Err("type a few words first".into());
                    }
                    if words.chars().count() > max {
                        return Err(format!("at most {max} characters"));
                    }
                    event["words"] = json!(words);
                }
                noted = Some(("pressed", json!({ "layer": layer, "action": action, "words": event.get("words") })));
                self.emit("layer.action", event);
            }
            "tool.input" => {
                let id = p["tool"].as_str().ok_or("missing tool")?;
                let tool = def.tool(id).ok_or_else(|| format!("layer '{layer}' has no tool '{id}'"))?;
                let geometry = clean_geometry(tool.kind, &p["geometry"])?;
                if !state.active {
                    return Err(format!("layer '{layer}' is off"));
                }
                let mut event = json!({ "layer": layer, "tool": id, "geometry": geometry, "from": surface });
                if let Some(sender) = &sender {
                    event["participant"] = sender.clone();
                }
                noted = Some(("drew", json!({ "layer": layer, "tool": id, "geometry": geometry })));
                self.emit("tool.input", event);
            }
            other => return Err(format!("unknown method '{other}'")),
        }
        if let (Role::Phone, Some((what, detail))) = (role, noted) {
            self.note_phone(&inner.seats, surface, what, detail);
        }
        Ok(json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::test_support::*;

    #[test]
    fn the_table_keeps_a_play_head_every_view_reads() {
        let hub = scratch_hub("clock");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("layer.activate", json!({ "layer": "sunlight", "active": true })).unwrap();
        assert!(layer(&hub, "sunlight").get("clock").is_none());
        let before = host_millis();
        hub.request(Role::Table, 1, "layer.clock", &json!({ "layer": "sunlight", "value": 9.5, "rate": 0.4 })).unwrap();
        let clock = layer(&hub, "sunlight")["clock"].clone();
        assert_eq!((clock["value"].clone(), clock["rate"].clone()), (json!(9.5), json!(0.4)));
        assert!(clock["at"].as_f64().unwrap() >= before && hub.welcome(0)["time"].as_f64().unwrap() >= clock["at"].as_f64().unwrap());
        // Only the table moves it, with a sane pace.
        assert!(hub.request(Role::Tv, 2, "layer.clock", &json!({ "layer": "sunlight", "value": 1 })).is_err());
        assert!(hub.request(Role::Phone, 3, "layer.clock", &json!({ "layer": "sunlight", "value": 1 })).is_err());
        assert!(dev("layer.clock", json!({ "layer": "sunlight", "value": "noon" })).is_err());
        assert!(dev("layer.clock", json!({ "layer": "sunlight", "value": 1, "rate": 1e9 })).is_err());
        // Stopping is a rate of 0, and closing the layer forgets it.
        dev("layer.clock", json!({ "layer": "sunlight", "value": 10 })).unwrap();
        assert_eq!(layer(&hub, "sunlight")["clock"]["rate"], json!(0.0));
        dev("layer.activate", json!({ "layer": "sunlight", "active": false })).unwrap();
        assert!(layer(&hub, "sunlight").get("clock").is_none());
    }

    #[test]
    fn the_table_reports_a_layers_trouble_until_it_runs_again() {
        let hub = scratch_hub("layer-health");
        let table = |method: &str, p: Value| hub.request(Role::Table, 1, method, &p);
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let mut events = hub.subscribe();
        // Off: nothing to report.
        table("layer.health", json!({ "layer": "wind", "status": "retrying", "reason": "x" })).unwrap();
        assert!(layer(&hub, "wind").get("health").is_none());
        dev("layer.activate", json!({ "layer": "wind", "active": true })).unwrap();
        let r = table(
            "layer.health",
            json!({ "layer": "wind", "status": "retrying", "reason": "couldn't read buildings.geojson (HTTP 404)", "retry_in": 5 }),
        )
        .unwrap();
        assert!(r["incident"].as_str().unwrap().contains("is not running: couldn't read buildings.geojson"), "{r}");
        assert_eq!(layer(&hub, "wind")["health"]["status"], "retrying");
        assert_eq!(layer(&hub, "wind")["health"]["retry_in"], 5.0);
        // A retry later with the same trouble is not a new incident.
        let r = table(
            "layer.health",
            json!({ "layer": "wind", "status": "retrying", "reason": "couldn't read buildings.geojson (HTTP 404)", "retry_in": 15 }),
        )
        .unwrap();
        assert!(r["incident"].is_null());
        // Phones can neither report nor retry; the controller and editor retry.
        assert!(hub.request(Role::Phone, 3, "layer.health", &json!({ "layer": "wind", "status": "running" })).is_err());
        assert!(hub.request(Role::Phone, 3, "layer.retry", &json!({ "layer": "wind" })).is_err());
        while events.try_recv().is_ok() {}
        dev("layer.retry", json!({ "layer": "wind" })).unwrap();
        let retry: Value = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
        assert_eq!((retry["m"].as_str(), retry["p"]["layer"].as_str()), (Some("layer.retry"), Some("wind")), "{retry}");
        let r = table("layer.health", json!({ "layer": "wind", "status": "running" })).unwrap();
        assert!(r["incident"].as_str().unwrap().contains("running again"));
        assert!(layer(&hub, "wind").get("health").is_none());
        // Going off forgets any trouble.
        table("layer.health", json!({ "layer": "wind", "status": "failed", "reason": "boom" })).unwrap();
        dev("layer.activate", json!({ "layer": "wind", "active": false })).unwrap();
        assert!(layer(&hub, "wind").get("health").is_none());
        assert!(table("layer.health", json!({ "layer": "wind", "status": "sleeping" })).is_err());
    }
}
