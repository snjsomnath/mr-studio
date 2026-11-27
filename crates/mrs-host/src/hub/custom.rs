//! Saved custom layers, the palette, and datasets leaving the table.

use super::*;

impl Hub {
    /// The requests that change what the table can show rather than its scene: custom
    /// layers (`custom.save`, `custom.remove`) and the palette (`palette.set`). Each is
    /// written to site.json first and only then takes effect.
    pub(super) fn author(&self, inner: &mut Inner, method: &str, p: &Value, who: Who) -> Result<Value, String> {
        match method {
            "custom.save" => {
                let id = p["id"].as_str().ok_or("missing id")?.to_string();
                if !is_instance_id(&id) {
                    return Err("id must be lowercase letters, digits and dashes".into());
                }
                let recipe: mrs_site::CustomLayer = serde_json::from_value(p["recipe"].clone()).map_err(|e| format!("recipe: {e}"))?;
                let catalog = self.catalog();
                let source = format!("{}{id}", mrs_site::CUSTOM_PREFIX);
                if catalog.iter().any(|d| d.id == id && d.source != source) {
                    return Err(format!("'{id}' is the id of a core layer; give the custom layer another id"));
                }
                let def = crate::layers::custom_def(&id, &recipe).map_err(|e| format!("{e:#}"))?;
                let mut saved = self.site.saved_custom().map_err(|e| e.to_string())?;
                let name = recipe.name.clone();
                saved.insert(id.clone(), recipe);
                self.saving(who, format!("Saved the custom layer {name}"), || self.site.save_custom(&saved))?;
                let manifest = def.manifest.clone();
                let mut next = (*catalog).clone();
                let at = match next.iter().position(|d| d.source == source) {
                    Some(at) => {
                        next[at] = def;
                        at
                    }
                    None => {
                        next.push(def);
                        next.len() - 1
                    }
                };
                let next = Arc::new(next);
                *self.catalog.write() = next.clone();
                self.emit("catalog.changed", json!({ "manifest": manifest }));
                // Instances of it keep the params its controls still accept.
                for instance in inner.scene.iter_mut().filter(|i| i.def == at) {
                    let mut params = next[at].defaults();
                    let kept: Map<String, Value> = instance
                        .state
                        .params
                        .iter()
                        .filter(|(k, _)| next[at].control(k).is_some())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    if let Ok(clean) = next[at].validate(&kept, false) {
                        params.extend(clean);
                    }
                    instance.state.params = params;
                    self.emit_layer(&instance.id, &instance.state);
                }
                Ok(json!({ "id": id, "use": source }))
            }
            "custom.remove" => {
                let id = p["id"].as_str().ok_or("missing id")?;
                let source = format!("{}{id}", mrs_site::CUSTOM_PREFIX);
                let catalog = self.catalog();
                let at = catalog.iter().position(|d| d.source == source).ok_or_else(|| format!("no custom layer '{id}'"))?;
                if let Some(used) = inner.scene.iter().find(|i| i.def == at) {
                    return Err(format!("'{}' on the table uses it; remove that first", used.id));
                }
                let mut saved = self.site.saved_custom().map_err(|e| e.to_string())?;
                let name = saved.remove(id).map_or_else(|| id.to_string(), |r| r.name);
                self.saving(who, format!("Deleted the custom layer {name}"), || self.site.save_custom(&saved))?;
                let mut next = (*catalog).clone();
                next.remove(at);
                for instance in &mut inner.scene {
                    if instance.def > at {
                        instance.def -= 1;
                    }
                }
                *self.catalog.write() = Arc::new(next);
                self.emit("catalog.removed", json!({ "id": id }));
                Ok(json!({}))
            }
            "data.remove" => {
                // A dataset of the table's own (`data`), out of site.json (#52). Not while anything
                // on the table reads it: a layer that needs it, a setting that names it, a custom layer.
                let name = p["name"].as_str().filter(|n| !n.is_empty()).ok_or("missing name")?.to_string();
                let catalog = self.catalog();
                let mut users: Vec<String> = Vec::new();
                for instance in &inner.scene {
                    let Some(def) = catalog.get(instance.def) else { continue };
                    let needs = def.manifest["requires"]["data"].as_array().is_some_and(|d| d.iter().any(|v| v.as_str() == Some(&name)));
                    let names = instance.state.params.values().any(|v| v.as_str() == Some(&name));
                    let draws =
                        def.manifest["custom"]["data"].as_array().is_some_and(|d| d.iter().any(|v| v["dataset"].as_str() == Some(&name)));
                    if needs || names || draws {
                        let label = instance
                            .state
                            .button
                            .name
                            .clone()
                            .unwrap_or_else(|| def.manifest["name"].as_str().unwrap_or(&instance.id).to_string());
                        users.push(label);
                    }
                }
                if !users.is_empty() {
                    users.sort();
                    users.dedup();
                    return Err(format!(
                        "{} on the table use{} it; remove {} first",
                        users.join(", "),
                        if users.len() == 1 { "s" } else { "" },
                        if users.len() == 1 { "that" } else { "those" }
                    ));
                }
                let mut gone = false;
                self.saving(who, format!("Took the dataset {name} out of the table"), || {
                    gone = self.site.forget_data(&name)?;
                    Ok(())
                })?;
                if !gone {
                    return Err(format!("this table has no dataset '{name}' of its own"));
                }
                let info = {
                    let mut info = self.info.write();
                    info.data.remove(&name);
                    info.clone()
                };
                self.emit("site.changed", json!({ "site": info }));
                Ok(json!({}))
            }
            "palette.set" => {
                let palette: Option<mrs_site::Palette> = match &p["palette"] {
                    Value::Null => None,
                    value => Some(serde_json::from_value(value.clone()).map_err(|e| format!("palette: {e}"))?),
                };
                let value = palette.as_ref().map(serde_json::to_value).transpose().map_err(|e| format!("palette: {e}"))?;
                self.saving_later(who, "Changed the palette", vec![("palette", value)])?;
                self.info.write().palette = palette.clone();
                self.emit("palette.changed", json!({ "palette": palette }));
                Ok(json!({}))
            }
            other => Err(format!("unknown method '{other}'")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::test_support::*;

    #[test]
    fn a_custom_layer_is_saved_offered_added_and_restyled_live() {
        let hub = scratch_hub("custom");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let mut events = hub.subscribe();
        let recipe = |colour: &str| {
            json!({ "name": "Heat walk", "icon": "route",
            "data": [ { "id": "paths", "dataset": "buildings" } ],
            "look": [ { "id": "lines", "block": "lines", "data": "paths", "props": { "color": colour, "width_mm": 2 } } ],
            "controls": [ { "id": "width", "type": "range", "label": "Width", "min": 1, "max": 8, "step": 1, "default": 3, "bind": "look.lines.width_mm" } ] })
        };
        assert_eq!(dev("custom.save", json!({ "id": "heat-walk", "recipe": recipe("@warm") })).unwrap()["use"], "custom:heat-walk");
        let event: Value = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
        assert_eq!(event["m"], "catalog.changed");
        assert_eq!(event["p"]["manifest"]["custom"]["look"][0]["props"]["color"], "@warm");
        assert!(hub.welcome(0)["manifests"].as_array().unwrap().iter().any(|m| m["id"] == "heat-walk"), "offered to new surfaces");

        let added = dev("scene.add", json!({ "use": "custom:heat-walk" })).unwrap();
        assert_eq!(added["id"], "heat-walk");
        dev("scene.set", json!({ "layer": "heat-walk", "params": { "width": 6 } })).unwrap();
        // Restyling keeps the instance and the params its controls still take.
        dev("custom.save", json!({ "id": "heat-walk", "recipe": recipe("#ff8800") })).unwrap();
        assert_eq!(layer(&hub, "heat-walk")["params"]["width"], 6.0);
        let saved = Site::load(&hub.site.dir).unwrap();
        assert_eq!(saved.manifest.custom["heat-walk"].look[0].props["color"], "#ff8800");

        assert!(dev("custom.remove", json!({ "id": "heat-walk" })).unwrap_err().contains("uses it"));
        dev("scene.remove", json!({ "layer": "heat-walk" })).unwrap();
        dev("custom.remove", json!({ "id": "heat-walk" })).unwrap();
        assert!(Site::load(&hub.site.dir).unwrap().manifest.custom.is_empty());
        assert!(dev("custom.save", json!({ "id": "sunlight", "recipe": recipe("#ffffff") })).unwrap_err().contains("core layer"));
        assert!(dev("custom.save", json!({ "id": "bad", "recipe": { "name": "Bad", "data": [ { "id": "x", "dataset": "nothing" } ] } }))
            .is_err());
        assert!(hub.request(Role::Phone, 0, "custom.save", &json!({ "id": "x", "recipe": recipe("#fff000") })).is_err());
    }

    #[test]
    fn a_dataset_leaves_the_table_once_nothing_reads_it() {
        let hub = scratch_hub("data-remove");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        let refused = dev("data.remove", json!({ "name": "walkways" })).unwrap_err();
        assert!(refused.contains("Cool paths"), "{refused}");
        let coolpaths = hub.welcome(0)["state"]["scene"]
            .as_array()
            .unwrap()
            .iter()
            .find(|id| id.as_str().unwrap().starts_with("coolpaths"))
            .unwrap()
            .clone();
        dev("scene.remove", json!({ "layer": coolpaths })).unwrap();
        dev("data.remove", json!({ "name": "walkways" })).unwrap();
        assert!(!hub.site().data.contains_key("walkways"));
        assert!(!Site::load(&hub.site.dir).unwrap().manifest.data.contains_key("walkways"));
        assert!(hub.site.dir.join("data/walkways.geojson").exists(), "the file stays, for undo");
        assert!(dev("data.remove", json!({ "name": "walkways" })).unwrap_err().contains("no dataset"));
        assert!(hub.request(Role::Phone, 0, "data.remove", &json!({ "name": "roads" })).is_err());
    }

    #[test]
    fn the_palette_is_saved_and_sent() {
        let hub = scratch_hub("palette");
        let dev = |method: &str, p: Value| hub.request(Role::Dev, 0, method, &p);
        dev("palette.set", json!({ "palette": { "set": "night", "slots": { "accent": "#ff8800" } } })).unwrap();
        assert_eq!(hub.site().palette.unwrap().slots["accent"], "#ff8800");
        assert_eq!(Site::load(&hub.site.dir).unwrap().manifest.palette.unwrap().set.as_deref(), Some("night"));
        assert!(dev("palette.set", json!({ "palette": { "slots": { "accent": "orange" } } })).is_err());
        dev("palette.set", json!({ "palette": null })).unwrap();
        assert!(Site::load(&hub.site.dir).unwrap().manifest.palette.is_none());
    }
}
