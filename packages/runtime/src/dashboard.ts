import { DashboardView, validateLayerPanels, validatePage } from '@mrstudio/dashboard';
import type { PanelInput } from '@mrstudio/dashboard';
import type { Connection, LayerManifest, PanelContext, PanelSpec } from '@mrstudio/sdk';

import { say, t } from './i18n.ts';
import { baseContext, isAtRest } from './layer-manager.ts';
import { layerModule, widgets, withTeamWidgets } from './registry.ts';
import type { Store } from './store.ts';

/**
 * The TV's dashboard canvas. Panels come from two places: each layer's manifest
 * (laid out automatically while the layer is on) or, if the site has hand-made
 * pages in `tv.pages`, from those. Either way they pass the same rules.
 */
export function mountDashboard(root: HTMLElement, store: Store, connection: Connection, dev: boolean): DashboardView {
  const registry = widgets;
  const tv = store.state.site.tv ?? {};
  const view = new DashboardView(root, { registry, dev, rotateS: tv.rotate_s, empty: t('Turn a layer on to see it here') });
  view.setTheme(tv.theme);
  store.onTv((next) => view.setTheme(next?.theme));

  const report = (owner: string, issues: { path: string; message: string }[]) => {
    for (const issue of issues) console.warn(`[${owner}] ${issue.path} ${issue.message}`);
  };

  const input = (layer: string | undefined, spec: PanelSpec, key: string, page?: number) => panelInput(store, connection, layer, spec, key, page);

  if (tv.pages?.length) {
    const inputs: PanelInput[] = [];
    tv.pages.forEach((page, index) => {
      report(`site page ${page.id}`, validatePage(page, registry));
      for (const spec of page.panels ?? []) inputs.push(input(spec.layer, spec, `${page.id}/${spec.id}`, index));
    });
    view.setPanels(inputs);
  } else {
    // One set of panels per layer in the scene, kept across scene edits so mounted panels stay as they are.
    const made = new Map<string, PanelInput>();
    const checked = new Set<string>();
    const fromScene = () => {
      const inputs: PanelInput[] = [];
      for (const id of store.state.scene) {
        const manifest = store.manifest(store.state.layers[id]?.layer ?? '');
        if (!manifest) continue;
        const panels = layerPanels(manifest);
        if (!checked.has(manifest.id)) report(manifest.id, validateLayerPanels(panels, registry));
        checked.add(manifest.id);
        for (const spec of panels) {
          const key = `${id}/${spec.id}`;
          if (!made.has(key)) made.set(key, input(id, spec, key));
          inputs.push(made.get(key)!);
        }
      }
      for (const key of made.keys()) if (!inputs.some((i) => i.key === key)) made.delete(key);
      view.setPanels(inputs);
    };
    fromScene();
    store.onScene(fromScene);
  }

  // "Turn a layer on" only while none is open: an open layer without panels (a custom layer, #342)
  // leaves the canvas quiet instead of asking for a layer.
  const anyOpen = () =>
    store.state.scene.some((id) => {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      return Boolean(state?.active && !state.parent && manifest && manifest.category !== 'ambient' && manifest.category !== 'base' && !isAtRest(manifest, state));
    });
  const empty = () => view.setEmpty(anyOpen() ? '' : t('Turn a layer on to see it here'));
  empty();
  store.onLayer(empty);
  store.onScene(empty);

  // Many changes can land in one frame (a slider being dragged); one sync covers them.
  let queued = false;
  store.onLayer(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      view.sync();
    });
  });
  return view;
}

// `layer` is the id of a layer in the scene (an instance), which may come and go while the TV is up.
/** A panel of a layer in the scene, for the TV or the table's ribbon (#78). */
export function panelInput(store: Store, connection: Connection, layer: string | undefined, spec: PanelSpec, key: string, page?: number): PanelInput {
  const id = layer ?? '';
  const state = () => store.state.layers[id];
  let cleanups: (() => void)[] = [];
  return {
    key,
    spec,
    page,
    source: () => ({
      params: state()?.params ?? {},
      // The words a layer publishes (a caption, a status) in the visitors' language (#80).
      shared: sayShared(state()?.shared ?? {}, store.manifest(state()?.layer ?? '')),
      site: store.state.site as unknown as Record<string, unknown>,
    }),
    // A panel that reads a layer is only up while that layer is on. A slideshow made of layers
    // has nothing of its own to show: the controller's step strip speaks for it (#43).
    active: () => layer === undefined || (state()?.active === true && !(state()?.step && store.manifest(state()!.layer)?.sequence)),
    custom: (el) => {
      const module = state() ? layerModule(state()!.layer) : undefined;
      if (!module?.panel) return;
      const ctx: PanelContext = Object.assign(Object.create(baseContext(store, connection, id)), {
        panel: spec.id,
        onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
      });
      return module.panel(ctx, el);
    },
    onRemove: () => {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
    },
  };
}

/** A layer's published values with its words said in the visitors' language: only whole texts it has a translation for. */
function sayShared(shared: Record<string, unknown>, manifest: LayerManifest | undefined): Record<string, unknown> {
  if (!manifest?.locales) return shared;
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(shared)) {
    if (typeof value !== 'string') continue;
    const said = say(value, manifest);
    if (said !== value) (out ??= { ...shared })[key] = said;
  }
  return out ?? shared;
}

/** A layer's TV panels: everything but its ribbon panels. A layer with only a `panel` function gets one tile for it. */
function layerPanels(manifest: LayerManifest): PanelSpec[] {
  if (manifest.panels) return withTeamWidgets(manifest.id, manifest.panels.filter((spec) => !spec.ribbon));
  if (!layerModule(manifest.id)?.panel) return [];
  return [{ id: 'panel', widget: 'custom', size: 'tile', title: manifest.name, props: { reads: 3 } }];
}
