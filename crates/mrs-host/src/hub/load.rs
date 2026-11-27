//! Building the scene from site.json, and building it again when the file changes.

use super::*;

impl Hub {
    /// The scene a site.json `layers` list stands for, each layer followed by its items.
    pub(super) fn build_scene(catalog: &[LayerDef], layers: &[LayerRef]) -> anyhow::Result<Vec<Instance>> {
        let mut scene: Vec<Instance> = Vec::new();
        let find = |used: &str| {
            catalog
                .iter()
                .position(|d| d.source == used)
                .ok_or_else(|| anyhow::anyhow!("site.json uses layer '{used}', which is not available"))
        };
        for reference in layers {
            let layer = LayerRef { items: Vec::new(), ..reference.clone() };
            let parent = Self::instance(catalog, find(&reference.r#use)?, layer, None, true)?;
            let on = parent.state.active;
            scene.push(parent);
            // A sequence's items come on one at a time, as its steps show them.
            let sequence = catalog[parent_def(&scene)].manifest["sequence"] == true;
            for item in &reference.items {
                let mut item = Self::instance(catalog, find(&item.r#use)?, item_ref(item), Some(reference.id.clone()), true)?;
                item.state.active &= on && !sequence;
                item.set_stack(item_stack(item_ref_stack(&reference.items, &item.id)));
                scene.push(item);
            }
        }
        for (n, instance) in scene.iter().enumerate() {
            if scene[..n].iter().any(|i| i.id == instance.id) {
                anyhow::bail!("'{}' names two entries of the scene in site.json; give each its own \"id\"", instance.id);
            }
        }
        Ok(scene)
    }

    /// Builds an instance from a site.json entry. With `lenient`, params that do not
    /// validate are ignored with a warning (a hand-edited file should still start).
    pub(super) fn instance(
        catalog: &[LayerDef],
        def: usize,
        saved: LayerRef,
        parent: Option<String>,
        lenient: bool,
    ) -> anyhow::Result<Instance> {
        let layer = &catalog[def];
        let id = saved.id.clone();
        let mut params = layer.defaults();
        match layer.validate(&saved.params, false) {
            Ok(overrides) => params.extend(overrides),
            Err(e) if lenient => tracing::warn!("site.json params for layer '{id}' ignored: {e}"),
            Err(e) => anyhow::bail!(e),
        }
        let state = LayerState {
            layer: layer.id.clone(),
            active: saved.active,
            intensity: 1.0,
            params,
            shared: Map::new(),
            button: saved.button.clone(),
            // A control the layer package no longer has is not worth refusing the site over.
            hide: saved.hide.iter().filter(|id| layer.controls.iter().any(|c| &c.id == *id)).cloned().collect(),
            parent: parent.clone(),
            stack: None,
            steps: saved.steps.clone(),
            step: None,
            shown_by: None,
            rest: false,
            selection: None,
            health: None,
            clock: None,
        };
        let mut instance = Instance { id, def, parent, stack: None, saved, state };
        instance.sync_rest();
        // A table starts at rest (#419): a layer with a button on the controller starts closed,
        // even when site.json saved it on. Only the map at rest and items follow `active`.
        if instance.parent.is_none() && !at_rest(layer, &instance) {
            instance.state.active = false;
        }
        Ok(instance)
    }

    /// Takes site.json as it now is after a change the hub did not make itself (an undo, an
    /// outside edit): the layers, custom layers, palette and controller settings change live,
    /// and each surface hears only what changed. The caller re-bakes the ground and sends
    /// `site.changed` when keys beyond these changed.
    pub fn reload(&self, site: &Site, change: &Change) -> anyhow::Result<()> {
        let keys = &change.keys;
        let has = |k: &str| keys.iter().any(|x| x == k || x == "*");
        let mut inner = self.inner.lock();
        let old_catalog = self.catalog();
        let catalog = if has("custom") {
            let mut next: Vec<LayerDef> = old_catalog.iter().filter(|d| !d.source.starts_with(mrs_site::CUSTOM_PREFIX)).cloned().collect();
            for (id, recipe) in &site.manifest.custom {
                next.push(crate::layers::custom_def(id, recipe)?);
            }
            Arc::new(next)
        } else {
            old_catalog.clone()
        };
        let mut scene = Self::build_scene(&catalog, &site.manifest.layers)?;
        // A layer whose entry did not change keeps what it is doing now.
        let mut fresh = Vec::new();
        for (n, instance) in scene.iter_mut().enumerate() {
            let same = inner.scene.iter().find(|old| {
                old.id == instance.id
                    && old_catalog[old.def].source == catalog[instance.def].source
                    && old_catalog[old.def].manifest == catalog[instance.def].manifest
                    && json!(old.saved) == json!(instance.saved)
                    && old.parent == instance.parent
            });
            match same {
                Some(old) => {
                    let def = instance.def;
                    *instance = old.clone();
                    instance.def = def;
                }
                None => fresh.push(n),
            }
        }
        let ids: Vec<String> = scene.iter().map(|i| i.id.clone()).collect();
        for instance in &mut scene {
            if instance.state.shown_by.as_ref().is_some_and(|by| !ids.contains(by)) {
                instance.state.shown_by = None;
                instance.state.active = false;
            }
        }
        // The catalogue first, so a surface knows a layer before the scene uses it.
        if !Arc::ptr_eq(&catalog, &old_catalog) {
            *self.catalog.write() = catalog.clone();
            for old in old_catalog.iter().filter(|d| d.source.starts_with(mrs_site::CUSTOM_PREFIX)) {
                if !catalog.iter().any(|d| d.source == old.source) {
                    self.emit("catalog.removed", json!({ "id": old.id }));
                }
            }
            for def in catalog.iter().filter(|d| d.source.starts_with(mrs_site::CUSTOM_PREFIX)) {
                if !old_catalog.iter().any(|d| d.source == def.source && d.manifest == def.manifest) {
                    self.emit("catalog.changed", json!({ "manifest": def.manifest }));
                }
            }
        }
        let info = site.info();
        *self.info.write() = info.clone();
        if has("palette") {
            self.emit("palette.changed", json!({ "palette": info.palette }));
        }
        if has("tv") {
            self.emit("site.tv", json!({ "tv": info.tv }));
        }
        if has("display") {
            self.emit("site.display", json!({ "display": info.display }));
        }
        if has("name") || has("timezone") || has("branding") {
            self.emit("site.settings", self.settings());
        }
        inner.scene = scene;
        for at in fresh {
            if inner.scene[at].state.active && inner.scene[at].parent.is_none() && self.is_sequence(&inner.scene[at]) {
                self.switch(&mut inner.scene, at, true);
            }
        }
        if has("layers") || has("custom") {
            self.emit("state.scene", json!({ "scene": inner.order(), "layers": inner.layers() }));
        }
        Ok(())
    }
}
