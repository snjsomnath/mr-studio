//! The scene: adding, removing, moving and switching layers, their buttons, settings and
//! entities, and where an item sits in its layer.

use super::*;

/// A stack as site.json may write it: 1 is the surface; 2, or anything else, the stack underneath (none).
pub(super) fn item_stack(stack: Option<u8>) -> Option<u8> {
    stack.filter(|s| *s == 1)
}

pub(super) fn item_ref_stack(items: &[LayerItem], id: &str) -> Option<u8> {
    items.iter().find(|i| i.id == id).and_then(|i| i.stack)
}

/// A `stack` param of a request: 1, 2, or null for none.
pub(super) fn stack_param(value: &Value) -> Result<Option<u8>, String> {
    match value {
        Value::Null => Ok(None),
        v => match v.as_u64() {
            Some(1) => Ok(Some(1)),
            Some(2) => Ok(None),
            _ => Err("stack is 1 (the surface) or 2 (underneath)".into()),
        },
    }
}

pub(super) fn item_ref(item: &LayerItem) -> LayerRef {
    LayerRef {
        r#use: item.r#use.clone(),
        id: item.id.clone(),
        active: item.active,
        params: item.params.clone(),
        button: LayerButton::default(),
        hide: item.hide.clone(),
        items: Vec::new(),
        steps: None,
    }
}

/// The scene as site.json's `layers`: each layer with the items that follow it.
pub(super) fn saved_layers(scene: &[Instance]) -> Vec<LayerRef> {
    let mut out: Vec<LayerRef> = Vec::new();
    for instance in scene {
        match (&instance.parent, out.last_mut()) {
            (Some(_), Some(layer)) => layer.items.push(instance.item()),
            _ => out.push(LayerRef { items: Vec::new(), ..instance.saved.clone() }),
        }
    }
    out
}

/// A base or ambient package: part of the map at rest whatever its button says.
pub(super) fn is_map_life(layer: &LayerDef) -> bool {
    matches!(layer.manifest["category"].as_str(), Some("base" | "ambient"))
}

/// Whether a layer of the scene is on at rest: saved on, and map life or with no button (#204).
/// A layer with a button on the controller is never open at rest (#419).
pub(super) fn at_rest(layer: &LayerDef, instance: &Instance) -> bool {
    instance.saved.active && (instance.state.rest || is_map_life(layer))
}

pub(super) fn shown(scene: &[Instance], id: &str) -> Option<usize> {
    scene.iter().position(|i| i.state.shown_by.as_deref() == Some(id))
}

/// The catalogue index of the last instance pushed, while the scene is being built.
pub(super) fn parent_def(scene: &[Instance]) -> usize {
    scene.last().map_or(0, |i| i.def)
}

pub(super) fn block(scene: &[Instance], at: usize) -> std::ops::Range<usize> {
    let id = &scene[at].id;
    let end = at + 1 + scene[at + 1..].iter().take_while(|i| i.parent.as_ref() == Some(id)).count();
    at..end
}

/// Where the `index`th entry of a list goes: the scene's layers when `parent` is `None`,
/// otherwise that layer's items. Past the end means at the end of that list.
pub(super) fn insert_position(scene: &[Instance], parent: Option<&str>, index: Option<u64>) -> Result<usize, String> {
    let index = index.map_or(usize::MAX, |i| i as usize);
    match parent {
        None => {
            let tops: Vec<usize> = scene.iter().enumerate().filter(|(_, i)| i.parent.is_none()).map(|(n, _)| n).collect();
            Ok(tops.get(index).copied().unwrap_or(scene.len()))
        }
        Some(parent) => {
            let at = scene
                .iter()
                .position(|i| i.id == parent && i.parent.is_none())
                .ok_or_else(|| format!("there is no layer '{parent}' to hold it"))?;
            let range = block(scene, at);
            Ok(range.start + 1 + index.min(range.len() - 1))
        }
    }
}

/// Reads the `hide` of a `scene.*` request: the whole list of control ids to leave off the
/// controller and phones. Absent keeps what is there.
pub(super) fn hide_list(layer: &LayerDef, value: &Value) -> Result<Option<Vec<String>>, String> {
    let list = match value {
        Value::Null => return Ok(None),
        Value::Array(list) => list,
        _ => return Err("hide must be a list of control ids".into()),
    };
    let mut hide: Vec<String> = Vec::new();
    for id in list {
        let id = id.as_str().ok_or("hide must be a list of control ids")?;
        if !layer.controls.iter().any(|c| c.id == id) {
            return Err(format!("layer '{}' has no control '{id}'", layer.id));
        }
        if !hide.iter().any(|h| h == id) {
            hide.push(id.to_string());
        }
    }
    Ok(Some(hide))
}

/// Applies a `button` patch from a `scene.*` request: a string sets a field, `null` clears it,
/// and a field that is left out stays as it is.
pub(super) fn button_patch(mut button: LayerButton, patch: &Value) -> Result<LayerButton, String> {
    let patch = match patch {
        Value::Null => return Ok(button),
        Value::Object(patch) => patch,
        _ => return Err("button must be an object".into()),
    };
    for (key, value) in patch {
        if key == "order" {
            button.order = match value {
                Value::Null => None,
                Value::Number(n) => n.as_f64(),
                _ => return Err("button.order must be a number or null".into()),
            };
            continue;
        }
        if key == "hidden" {
            button.hidden = match value {
                Value::Null => false,
                Value::Bool(hidden) => *hidden,
                _ => return Err("button.hidden must be true, false or null".into()),
            };
            continue;
        }
        let text = match value {
            Value::Null => None,
            Value::String(text) => Some(text.trim().to_string()).filter(|t| !t.is_empty()),
            _ => return Err(format!("button.{key} must be text or null")),
        };
        match key.as_str() {
            "group" => button.group = text,
            "name" => button.name = text,
            "description" => button.description = text,
            "icon" => button.icon = text,
            "credit" => button.credit = text,
            "legend" => {
                button.legend = match text.as_deref() {
                    None => None,
                    Some("auto") => Some(mrs_site::LegendMode::Auto),
                    Some("full") => Some(mrs_site::LegendMode::Full),
                    Some("compact") => Some(mrs_site::LegendMode::Compact),
                    Some("off") => Some(mrs_site::LegendMode::Off),
                    Some(other) => return Err(format!("button.legend is 'auto', 'full', 'compact' or 'off', not '{other}'")),
                }
            }
            "side" => {
                button.side = match text.as_deref() {
                    None => None,
                    Some("left") => Some(mrs_site::ButtonSide::Left),
                    Some("right") => Some(mrs_site::ButtonSide::Right),
                    Some(other) => return Err(format!("button.side is 'left' or 'right', not '{other}'")),
                }
            }
            other => return Err(format!("a button has no '{other}'")),
        }
    }
    match button.problem() {
        Some(problem) => Err(problem),
        None => Ok(button),
    }
}

impl Hub {
    /// The `scene.*` requests. Each one edits a copy of the scene, saves it to
    /// site.json and only then makes it the session's scene.
    pub(super) fn compose(&self, inner: &mut Inner, method: &str, p: &Value, who: Who) -> Result<Value, String> {
        let mut scene = inner.scene.clone();
        let mut result = json!({});
        let summary;
        // `scene.set` changes one layer; the others change the list.
        let mut changed_layer = None;
        match method {
            "scene.add" => {
                if scene.len() >= MAX_SCENE_LAYERS {
                    return Err(format!("a scene holds at most {MAX_SCENE_LAYERS} layers"));
                }
                let wanted = p["use"].as_str().ok_or("missing use")?;
                let catalog = self.catalog();
                let def =
                    catalog.iter().position(|d| d.source == wanted || d.id == wanted).ok_or_else(|| format!("unknown layer '{wanted}'"))?;
                let parent = match &p["parent"] {
                    Value::Null => None,
                    Value::String(parent) => Some(parent.clone()),
                    _ => return Err("parent is the id of a layer in the scene".into()),
                };
                if parent.is_some() && !p["button"].is_null() {
                    return Err("an item has no button: it comes on with its layer".into());
                }
                if let Some(name) = self.catalog()[def].missing_data(&self.info.read().data).map_err(|e| e.to_string())? {
                    return Err(format!("this site has no '{name}' dataset, which the layer needs"));
                }
                let base = &self.catalog()[def].id;
                let id = match p["id"].as_str() {
                    Some(id) if !is_instance_id(id) => return Err("id must be lowercase letters, digits and dashes".into()),
                    Some(id) if scene.iter().any(|i| i.id == id) => return Err(format!("the scene already has a layer '{id}'")),
                    Some(id) => id.to_string(),
                    // The first copy is named after the layer, the next ones `-2`, `-3`, ...
                    None => std::iter::once(base.clone())
                        .chain((2..).map(|n| format!("{base}-{n}")))
                        .find(|id| scene.iter().all(|i| &i.id != id))
                        .expect("an unused id exists"),
                };
                let saved = LayerRef {
                    r#use: self.catalog()[def].source.clone(),
                    id: id.clone(),
                    // A new layer with a button is offered on the controller, not saved on (#419);
                    // map life and items come on.
                    active: p["active"].as_bool().unwrap_or(
                        parent.is_some() || p["button"].as_object().is_none_or(|b| b.is_empty()) || is_map_life(&self.catalog()[def]),
                    ),
                    params: match &p["params"] {
                        Value::Null => Map::new(),
                        Value::Object(params) => self.catalog()[def].validate(params, false)?,
                        _ => return Err("params must be an object".into()),
                    },
                    button: button_patch(LayerButton::default(), &p["button"])?,
                    hide: hide_list(&self.catalog()[def], &p["hide"])?.unwrap_or_default(),
                    items: Vec::new(),
                    steps: None,
                };
                let index = insert_position(&scene, parent.as_deref(), p["index"].as_u64())?;
                let mut instance = Self::instance(&self.catalog(), def, saved, parent.clone(), false).map_err(|e| e.to_string())?;
                if let Some(parent) = &parent {
                    instance.state.active &= scene.iter().any(|i| &i.id == parent && i.state.active);
                    instance.set_stack(stack_param(&p["stack"])?);
                } else if !p["stack"].is_null() {
                    return Err("only an item inside a layer has a stack".into());
                }
                summary = match &parent {
                    Some(parent) => format!("Added {} to {}", self.label(&instance), self.label_of(&scene, parent)),
                    None => format!("Added {}", self.label(&instance)),
                };
                scene.insert(index, instance);
                result = json!({ "id": id });
            }
            "scene.remove" => {
                let index = inner.position(p["layer"].as_str().ok_or("missing layer")?)?;
                let removed: Vec<Instance> = scene.drain(block(&scene, index)).collect();
                summary = format!("Removed {}", self.label(&removed[0]));
                // A sequence step that showed a removed layer goes with it.
                let mut dropped = 0;
                for instance in &mut scene {
                    if let Some(steps) = &mut instance.saved.steps {
                        let before = steps.sequence.len();
                        steps.sequence.retain(|step| removed.iter().all(|r| r.id != step.layer));
                        if steps.sequence.len() != before {
                            dropped += before - steps.sequence.len();
                            instance.state.steps = Some(steps.clone());
                        }
                    }
                }
                if dropped > 0 {
                    result = json!({ "dropped_steps": dropped });
                }
            }
            "scene.move" => {
                let id = p["layer"].as_str().ok_or("missing layer")?;
                let index = p["index"].as_u64().ok_or("missing index")?;
                let from = inner.position(id)?;
                let mut moving: Vec<Instance> = scene.drain(block(&scene, from)).collect();
                // `parent` left out keeps the instance where it is; null makes an item a layer of the scene.
                let parent = match p.get("parent") {
                    None => moving[0].parent.clone(),
                    Some(Value::Null) => None,
                    Some(Value::String(parent)) => Some(parent.clone()),
                    Some(_) => return Err("parent is the id of a layer in the scene, or null".into()),
                };
                if let Some(parent) = &parent {
                    if parent == id {
                        return Err("a layer cannot hold itself".into());
                    }
                    if moving.len() > 1 || moving[0].saved.steps.is_some() {
                        return Err(format!("'{id}' has items or steps of its own, so it cannot become an item"));
                    }
                    if !moving[0].saved.button.is_empty() {
                        return Err(format!("'{id}' has a button; clear it first, because an item comes on with its layer"));
                    }
                }
                summary = format!("Moved {}", self.label(&moving[0]));
                let first = &mut moving[0];
                if let Some(parent) = &parent {
                    let on = scene
                        .iter()
                        .find(|i| &i.id == parent)
                        .ok_or_else(|| format!("there is no layer '{parent}' to hold it"))?
                        .state
                        .active;
                    first.state.active = on && first.saved.active;
                }
                first.parent = parent.clone();
                first.state.parent = parent.clone();
                first.sync_rest();
                let to = insert_position(&scene, parent.as_deref(), Some(index))?;
                scene.splice(to..to, moving);
            }
            "scene.arrange" => {
                // The controller's rails as the editor's layer list was dragged into (#58): every button
                // named gets its side and its place, in one save, so one undo puts them all back.
                let rails = p["rails"].as_object().ok_or("rails is { left: [layer ids], right: [layer ids] }")?;
                for (side, ids) in rails {
                    let side = match side.as_str() {
                        "left" => mrs_site::ButtonSide::Left,
                        "right" => mrs_site::ButtonSide::Right,
                        other => return Err(format!("a rail is 'left' or 'right', not '{other}'")),
                    };
                    let ids = ids.as_array().ok_or("each rail is a list of layer ids")?;
                    for (at, id) in ids.iter().enumerate() {
                        let id = id.as_str().ok_or("each rail is a list of layer ids")?;
                        let instance = scene.iter_mut().find(|i| i.id == id).ok_or_else(|| format!("there is no layer '{id}'"))?;
                        if instance.parent.is_some() {
                            return Err(format!("'{id}' is an item of a layer, so it has no button"));
                        }
                        let mut button = instance.saved.button.clone();
                        button.side = Some(side);
                        button.order = Some((at + 1) as f64);
                        instance.state.button = button.clone();
                        instance.saved.button = button;
                    }
                }
                summary = "Rearranged the controller's buttons".to_string();
            }
            "scene.set" => {
                let index = inner.position(p["layer"].as_str().ok_or("missing layer")?)?;
                let name = self.label(&scene[index]);
                summary = if p.get("steps").is_some() {
                    format!("Changed the steps of {name}")
                } else if !p["params"].is_null() {
                    let keys: Vec<&str> = p["params"].as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
                    match keys.as_slice() {
                        [one] => format!("Changed {name}: {}", self.control_label(&scene[index], one)),
                        _ => format!("Changed the settings of {name}"),
                    }
                } else if let Some(active) = p["active"].as_bool() {
                    format!("Set {name} to start {}", if active { "on" } else { "off" })
                } else if !p["button"].is_null() {
                    format!("Changed the button of {name}")
                } else if !p["hide"].is_null() {
                    format!("Changed which controls of {name} show")
                } else if p.get("stack").is_some() {
                    format!("Moved {name} to stack {}", p["stack"].as_u64().unwrap_or(2))
                } else {
                    format!("Changed {name}")
                };
                if scene[index].parent.is_some() && !p["button"].is_null() {
                    return Err("an item has no button: it comes on with its layer".into());
                }
                if let Some(steps) = p.get("steps") {
                    let steps = self.clean_steps(&scene, index, steps)?;
                    scene[index].saved.steps = steps.clone();
                    scene[index].state.steps = steps;
                }
                let instance = &mut scene[index];
                match &p["params"] {
                    Value::Null => {}
                    Value::Object(patch) => {
                        let clean = self.catalog()[instance.def].validate(patch, false)?;
                        instance.state.params.extend(clean.clone());
                        instance.saved.params.extend(clean);
                    }
                    _ => return Err("params must be an object".into()),
                }
                let active = p["active"].as_bool();
                if let Some(active) = active {
                    instance.saved.active = active;
                }
                let button = button_patch(instance.saved.button.clone(), &p["button"])?;
                instance.state.button = button.clone();
                instance.saved.button = button;
                instance.sync_rest();
                if let Some(hide) = hide_list(&self.catalog()[instance.def], &p["hide"])? {
                    instance.state.hide = hide.clone();
                    instance.saved.hide = hide;
                }
                // Which stack an item is in (#606): 1 the surface, 2 or null the one underneath.
                if p.get("stack").is_some() {
                    if instance.parent.is_none() {
                        return Err("only an item inside a layer has a stack".into());
                    }
                    instance.set_stack(stack_param(&p["stack"])?);
                }
                changed_layer = Some((index, active));
            }
            other => return Err(format!("unknown method '{other}'")),
        }
        self.saving(who, summary, || self.site.save_layers(&saved_layers(&scene)))?;
        inner.scene = scene;
        match changed_layer {
            Some((index, Some(active))) => {
                // An item comes on only while its layer is on.
                let on = match inner.scene[index].parent.clone() {
                    Some(parent) => active && inner.scene.iter().any(|i| i.id == parent && i.state.active),
                    None => active,
                };
                self.switch(&mut inner.scene, index, on);
            }
            Some((index, None)) => {
                let scene = &mut inner.scene;
                // A sequence that is on shows its steps as they are now.
                if !p["steps"].is_null() || p.get("steps").is_some() {
                    if let Some(old) = shown(scene, &scene[index].id) {
                        self.release(scene, old, true);
                    }
                    let at = scene[index].state.step.take().map_or(0, |s| s.index);
                    if scene[index].state.active && self.is_sequence(&scene[index]) {
                        let count = scene[index].saved.steps.as_ref().map_or(0, |s| s.sequence.len());
                        self.show_step(scene, index, at.min(count.saturating_sub(1)), Instant::now());
                    }
                }
                self.emit_layer(&scene[index].id, &scene[index].state)
            }
            None => self.emit("state.scene", json!({ "scene": inner.order(), "layers": inner.layers() })),
        }
        Ok(result)
    }

    /// Turns an instance on or off and tells every surface. A layer's items follow it:
    /// on with it when they are set to come on, off with it always.
    pub(super) fn switch(&self, scene: &mut [Instance], index: usize, active: bool) {
        let sequence = self.is_sequence(&scene[index]);
        if !active {
            scene[index].state.step = None;
            scene[index].state.selection = None;
            scene[index].state.health = None;
            scene[index].state.clock = None;
        }
        scene[index].state.active = active;
        if sequence && !active {
            if let Some(shown) = shown(scene, &scene[index].id) {
                self.release(scene, shown, true);
            }
        }
        // A layer whose steps are the phases of its drawing (the Masterplan) has them from the
        // moment it turns on, so Next, phones and the MCP can step it before any table window
        // reports them, and without one (#421).
        if !sequence && active && scene[index].state.step.is_none() {
            scene[index].state.step = self.drawing_steps(&scene[index]);
        }
        // A sequence opens on its first step, so every surface sees its steps as it turns on.
        if sequence && active && scene[index].state.step.is_none() {
            self.show_step(scene, index, 0, Instant::now());
        } else {
            self.emit_layer(&scene[index].id, &scene[index].state);
        }
        if scene[index].parent.is_none() {
            for n in block(scene, index).skip(1) {
                // A sequence's own items come on only as its steps show them.
                // The item the sequence has just shown as its first step stays on (#197).
                let on = if sequence {
                    active && scene[n].state.shown_by.as_deref() == Some(scene[index].id.as_str())
                } else {
                    active && scene[n].saved.active
                };
                if scene[n].state.active != on {
                    scene[n].state.active = on;
                    self.emit_layer(&scene[n].id, &scene[n].state);
                }
            }
        }
    }

    /// Puts the table back the way site.json starts it (the controller's Reset view, #198):
    /// layers that were opened go off, the map at rest comes back on, and every layer has
    /// its saved params again. Live changes made in the editor are not saved, so they go too.
    pub(super) fn reset(&self, scene: &mut [Instance]) {
        // Every layer with a button closes, even one site.json saved on (#419): Reset and
        // Present start at the map at rest.
        for at in 0..scene.len() {
            if scene[at].parent.is_none() && scene[at].state.active && !at_rest(&self.catalog()[scene[at].def], &scene[at]) {
                self.switch(scene, at, false);
            }
        }
        for instance in scene.iter_mut() {
            // A layer a sequence shows has the step's params until the sequence lets it go.
            if instance.state.shown_by.is_some() {
                continue;
            }
            let mut params = self.catalog()[instance.def].defaults();
            params.extend(instance.saved.params.clone());
            if instance.state.params != params || instance.state.selection.is_some() {
                instance.state.params = params;
                instance.state.selection = None;
                self.emit_layer(&instance.id, &instance.state);
            }
        }
        for at in 0..scene.len() {
            if scene[at].parent.is_none() && !scene[at].state.active && at_rest(&self.catalog()[scene[at].def], &scene[at]) {
                self.switch(scene, at, true);
            }
        }
    }

    /// Whether a visitor's phone may turn this layer on or off now (#335): the table allows it
    /// (`tv.phone_switch`, default true), the layer does (`phone_switch` in layer.json), and no
    /// slideshow or guided tour is running.
    pub(super) fn phone_may_switch(&self, scene: &[Instance], index: usize) -> Result<(), String> {
        let tv_allows = self.info.read().tv.as_ref().is_none_or(|tv| tv["phone_switch"].as_bool() != Some(false));
        if !tv_allows {
            return Err("this table does not let phones turn layers on or off".into());
        }
        if !self.catalog()[scene[index].def].phone_switch {
            return Err(format!("'{}' is turned on and off from the controller only", scene[index].id));
        }
        if scene.iter().any(|i| i.state.shown_by.is_some()) {
            return Err("a slideshow is running; phones can switch layers again when it ends".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::test_support::*;

    #[test]
    fn an_entity_is_picked_changed_reset_and_saved() {
        let hub = scratch_hub("entities");
        let dir = hub.site.dir.clone();
        // A site layer with buildings to pick, added to the scene.
        let package = dir.join("layers/members");
        std::fs::create_dir_all(&package).unwrap();
        let manifest = json!({ "api": 1, "id": "members", "name": "Members", "requires": { "data": ["buildings"] },
            "entities": [{ "id": "buildings", "dataset": "buildings", "key": "id", "group": "kind", "controls": [
                { "id": "in", "type": "toggle", "label": "In", "default": false, "phone": true },
                { "id": "pv", "type": "range", "label": "PV", "min": 0, "max": 80, "step": 5, "default": 0 }
            ] }] });
        std::fs::write(package.join("layer.json"), manifest.to_string()).unwrap();
        let site = Site::load(&dir).unwrap();
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let catalog = crate::layers::load_catalog(&site, &root.join("packages/layers"), true).unwrap();
        let hub = Hub::new(&site, catalog, 4170, None, SessionOptions::default()).unwrap();
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("scene.add", json!({ "use": "./layers/members" })).unwrap();
        dev("layer.activate", json!({ "layer": "members", "active": true })).unwrap();

        // Picked on the table, the same for everyone.
        dev("layer.select", json!({ "layer": "members", "set": "buildings", "id": "3" })).unwrap();
        assert_eq!(layer(&hub, "members")["selection"], json!({ "set": "buildings", "id": "3" }));
        assert!(dev("layer.select", json!({ "layer": "members", "set": "trees", "id": "3" })).is_err());

        // Changed on the controller, two at once for a group, checked like controls.
        dev("layer.entity", json!({ "layer": "members", "set": "buildings", "ids": ["3"], "values": { "pv": 42 } })).unwrap();
        dev("layer.entity", json!({ "layer": "members", "set": "buildings", "ids": ["3", "4"], "values": { "in": true } })).unwrap();
        assert_eq!(
            layer(&hub, "members")["params"]["entities"],
            json!({ "buildings": { "3": { "pv": 40.0, "in": true }, "4": { "in": true } } })
        );
        assert!(dev("layer.entity", json!({ "layer": "members", "set": "buildings", "ids": ["3"], "values": { "pv": "lots" } })).is_err());
        // A phone may change only what is marked for phones.
        assert!(hub
            .request(Role::Phone, 7, "layer.entity", &json!({ "layer": "members", "set": "buildings", "id": "5", "values": { "pv": 10 } }))
            .is_err());
        hub.request(
            Role::Phone,
            7,
            "layer.entity",
            &json!({ "layer": "members", "set": "buildings", "id": "5", "values": { "in": true } }),
        )
        .unwrap();
        // Reset puts one back; back to its defaults, it has no values of its own.
        dev("layer.entity", json!({ "layer": "members", "set": "buildings", "ids": ["4", "5"], "reset": true })).unwrap();
        dev("layer.entity", json!({ "layer": "members", "set": "buildings", "ids": ["3"], "values": { "in": false } })).unwrap();
        assert_eq!(layer(&hub, "members")["params"]["entities"], json!({ "buildings": { "3": { "pv": 40.0 } } }));

        // Kept in site.json from the editor, with a step in the history to undo.
        let entities = layer(&hub, "members")["params"]["entities"].clone();
        dev("scene.set", json!({ "layer": "members", "params": { "entities": entities } })).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("site.json")).unwrap()).unwrap();
        let entry = saved["layers"].as_array().unwrap().iter().find(|l| l["use"] == "./layers/members").unwrap().clone();
        assert_eq!(entry["params"]["entities"]["buildings"]["3"]["pv"], json!(40.0));
        assert_eq!(hub.history_list()["revisions"][0]["summary"], json!("Changed Members: entities"));

        // A visitor's changes since then go with Reset, and so does the pick.
        dev("layer.entity", json!({ "layer": "members", "set": "buildings", "ids": ["9"], "values": { "pv": 80 } })).unwrap();
        dev("layers.reset", json!({})).unwrap();
        assert_eq!(layer(&hub, "members")["params"]["entities"], json!({ "buildings": { "3": { "pv": 40.0 } } }));
        assert!(layer(&hub, "members").get("selection").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_controller_stage_presses_named_actions_and_sends_tools() {
        let hub = scratch_hub("stage");
        let dir = hub.site.dir.clone();
        let package = dir.join("layers/planner");
        std::fs::create_dir_all(&package).unwrap();
        let manifest = json!({ "api": 1, "id": "planner", "name": "Planner", "stage": "custom",
            "tools": [{ "id": "route", "type": "line" }], "actions": [{ "id": "travel", "label": "Travel" }] });
        std::fs::write(package.join("layer.json"), manifest.to_string()).unwrap();
        let site = Site::load(&dir).unwrap();
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let catalog = crate::layers::load_catalog(&site, &root.join("packages/layers"), true).unwrap();
        let hub = Hub::new(&site, catalog, 4170, None, SessionOptions::default()).unwrap();
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("scene.add", json!({ "use": "./layers/planner" })).unwrap();
        hub.request(Role::Tv, 3, "layer.activate", &json!({ "layer": "planner", "active": true })).unwrap();
        let mut events = hub.subscribe();
        // The controller's stage sends a route and presses an action with no button of its own.
        let route = json!({ "type": "LineString", "coordinates": [[11.97, 57.70], [11.971, 57.701]] });
        hub.request(Role::Tv, 3, "tool.input", &json!({ "layer": "planner", "tool": "route", "geometry": route })).unwrap();
        hub.request(Role::Tv, 3, "layer.action", &json!({ "layer": "planner", "action": "travel" })).unwrap();
        let sent: Vec<Value> = std::iter::from_fn(|| events.try_recv().ok()).map(|e| serde_json::from_str(&e).unwrap()).collect();
        assert!(sent.iter().any(|e| e["m"] == "tool.input" && e["p"]["from"] == 3), "{sent:?}");
        assert!(sent.iter().any(|e| e["m"] == "layer.action" && e["p"]["action"] == "travel"));
        // Not from a phone, and not an action the layer does not name.
        assert!(hub.request(Role::Phone, 7, "layer.action", &json!({ "layer": "planner", "action": "travel" })).is_err());
        assert!(dev("layer.action", json!({ "layer": "planner", "action": "fly" })).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_puts_the_table_back_the_way_it_starts() {
        let hub = scratch_hub("reset");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("layer.activate", json!({ "layer": "sunlight", "active": true })).unwrap();
        dev("layer.set", json!({ "layer": "sunlight", "params": { "hour": 9 } })).unwrap();
        dev("layer.activate", json!({ "layer": "trees", "active": false })).unwrap();
        hub.request(Role::Tv, 0, "layers.reset", &json!({})).unwrap();
        let sun = layer(&hub, "sunlight");
        assert_eq!((sun["active"].clone(), sun["params"]["hour"].clone()), (json!(false), json!(15)));
        assert_eq!(layer(&hub, "trees")["active"], true, "the map at rest comes back");
        assert!(hub.request(Role::Phone, 0, "layers.reset", &json!({})).is_err(), "not from a phone");
    }

    #[test]
    fn phones_switch_layers_unless_the_table_a_layer_or_a_tour_holds_them_back() {
        let hub = scratch_hub("phone-switch");
        let phone = |method: &str, p: Value| hub.request(Role::Phone, 3, method, &p);
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        // A visitor turns Wind on and uses its primary control, which phones get by default (#335).
        phone("layer.activate", json!({ "layer": "wind", "active": true })).unwrap();
        assert_eq!(layer(&hub, "wind")["active"], true);
        phone("layer.set", json!({ "layer": "wind", "params": { "style": "particles" } })).unwrap();
        // The rest of the map stays out of reach, and so does Reset.
        assert!(phone("layers.reset", json!({})).is_err());
        // The table can turn phone switching off.
        dev("site.tv", json!({ "tv": { "phone_switch": false } })).unwrap();
        assert!(phone("layer.activate", json!({ "layer": "wind", "active": false })).is_err());
        dev("site.tv", json!({ "tv": { "phone_switch": null } })).unwrap();
        phone("layer.activate", json!({ "layer": "wind", "active": false })).unwrap();
        // While a slideshow shows its steps, phones leave the layers alone.
        dev(
            "scene.set",
            json!({ "layer": "slideshow", "steps": { "mode": "manual", "sequence": [{ "layer": "sunlight", "title": "Sun" }] } }),
        )
        .unwrap();
        dev("layer.activate", json!({ "layer": "slideshow", "active": true })).unwrap();
        let refused = phone("layer.activate", json!({ "layer": "wind", "active": true })).unwrap_err();
        assert!(refused.contains("slideshow"), "{refused}");
    }

    #[test]
    fn a_layer_on_at_start_without_a_button_is_part_of_the_map_at_rest() {
        let hub = scratch_hub("rest");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        // The sample's wind starts off: it is a button layer.
        assert_eq!(layer(&hub, "wind")["rest"], Value::Null);
        dev("scene.add", json!({ "use": "wind", "id": "breeze", "active": true })).unwrap();
        assert_eq!(layer(&hub, "breeze")["rest"], true, "on at start and no button: the map at rest (#204)");
        dev("scene.set", json!({ "layer": "breeze", "button": { "name": "Breeze" } })).unwrap();
        assert_eq!(layer(&hub, "breeze")["rest"], Value::Null, "a button makes it a layer of the controller");
        dev("scene.set", json!({ "layer": "breeze", "button": { "name": null }, "active": false })).unwrap();
        assert_eq!(layer(&hub, "breeze")["rest"], Value::Null, "off at start: still a layer to open");
        // An item comes on with its layer, never at rest.
        dev("scene.add", json!({ "use": "trees", "parent": "slideshow", "id": "slide-trees" })).unwrap();
        assert_eq!(layer(&hub, "slide-trees")["rest"], Value::Null);
    }

    #[test]
    fn a_button_carries_a_credit_line_and_a_legend_setting() {
        let hub = scratch_hub("credit-659");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("scene.set", json!({ "layer": "wind", "button": { "credit": "Data by SMHI", "legend": "compact" } })).unwrap();
        assert_eq!(layer(&hub, "wind")["button"]["credit"], "Data by SMHI");
        assert_eq!(layer(&hub, "wind")["button"]["legend"], "compact");
        assert!(dev("scene.set", json!({ "layer": "wind", "button": { "legend": "tiny" } })).is_err());
        assert!(dev("scene.set", json!({ "layer": "wind", "button": { "credit": "x".repeat(201) } })).is_err());
        dev("scene.set", json!({ "layer": "wind", "button": { "credit": null, "legend": null } })).unwrap();
        assert_eq!(layer(&hub, "wind")["button"]["credit"], Value::Null);
    }

    #[test]
    fn items_of_a_revealing_layer_go_in_a_stack() {
        let hub = scratch_hub("stacks-606");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("scene.add", json!({ "use": "lens", "id": "glass", "button": { "name": "Glass" } })).unwrap();
        dev("scene.add", json!({ "use": "trees", "parent": "glass", "id": "surface", "stack": 1 })).unwrap();
        dev("scene.add", json!({ "use": "wind", "parent": "glass", "id": "under" })).unwrap();
        assert_eq!(layer(&hub, "surface")["stack"], 1);
        assert_eq!(layer(&hub, "under")["stack"], Value::Null, "underneath is the default");
        let saved = || -> Value { serde_json::from_str(&std::fs::read_to_string(hub.site.dir.join("site.json")).unwrap()).unwrap() };
        let items = |site: Value| site["layers"].as_array().unwrap().iter().find(|l| l["id"] == "glass").unwrap()["items"].clone();
        assert_eq!(items(saved())[0]["stack"], 1);
        // Moved underneath, and the surface again; a layer of the scene has no stack.
        dev("scene.set", json!({ "layer": "surface", "stack": 2 })).unwrap();
        assert_eq!(items(saved())[0].get("stack"), None);
        dev("scene.set", json!({ "layer": "under", "stack": 1 })).unwrap();
        assert_eq!(layer(&hub, "under")["stack"], 1);
        assert!(dev("scene.set", json!({ "layer": "glass", "stack": 1 })).is_err());
        assert!(dev("scene.set", json!({ "layer": "under", "stack": 3 })).is_err());
    }

    #[test]
    fn a_table_starts_and_resets_with_no_button_layer_open() {
        let hub = scratch_hub("rest-419");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        // Saved on, with a button: offered on the controller, not opened (#419).
        dev("scene.add", json!({ "use": "wind", "id": "gust", "button": { "name": "Gust" }, "active": true })).unwrap();
        assert_eq!(layer(&hub, "gust")["active"], false);
        // Added from the editor with a button: not saved on.
        dev("scene.add", json!({ "use": "mapdata", "id": "roads-map", "button": { "side": "right" } })).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(hub.site.dir.join("site.json")).unwrap()).unwrap();
        let entry = saved["layers"].as_array().unwrap().iter().find(|l| l["id"] == "roads-map").unwrap().clone();
        assert_eq!(entry["active"], false, "{entry}");
        // Opened, then Reset (or Present): closed again; the map at rest stays.
        dev("layer.activate", json!({ "layer": "gust", "active": true })).unwrap();
        dev("layers.reset", json!({})).unwrap();
        assert_eq!(layer(&hub, "gust")["active"], false);
        assert_eq!(layer(&hub, "basemap")["active"], true);
        assert_eq!(layer(&hub, "sketch")["active"], true, "on at start with no button: map at rest");
    }
}
