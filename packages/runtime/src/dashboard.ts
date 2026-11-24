import { controlProblems, DashboardView, validateLayerPanels, validatePage } from '@mrstudio/dashboard';
import type { PanelInput } from '@mrstudio/dashboard';
import type { Connection, LayerManifest, PanelContext, PanelControls, PanelLayer, PanelSpec, StageLayout } from '@mrstudio/sdk';

import { say, t } from './i18n.ts';
import { baseContext, isAtRest, paramSender } from './layer-manager.ts';
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
        if (!checked.has(manifest.id)) {
          report(manifest.id, validateLayerPanels(panels, registry));
          for (const problem of controlProblems(panels, controlIds(manifest))) console.warn(`[${manifest.id}] ${problem}`);
        }
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

/**
 * A layer's controller centre made of panels (#357): the dashboard's grid inside the layer's card,
 * with the layer's own widgets, controls and map. Panels with `at` stay put; the rest are laid out.
 */
export function mountStage(el: HTMLElement, store: Store, connection: Connection, id: string, layout: StageLayout): { sync(): void; dispose(): void } {
  const manifest = store.manifest(store.state.layers[id]?.layer ?? '');
  const view = new DashboardView(el, { registry: widgets, rotateS: 60, empty: '' });
  view.setTheme(store.state.site.tv?.theme);
  const panels = withTeamWidgets(manifest?.id ?? '', layout.panels ?? []);
  const placed = panels.every((spec) => spec.at);
  if (placed) for (const issue of validatePage({ id: 'stage', panels }, widgets)) console.warn(`[${id}] stage ${issue.path} ${issue.message}`);
  else for (const issue of validateLayerPanels(panels, widgets)) console.warn(`[${id}] stage ${issue.path} ${issue.message}`);
  for (const problem of controlProblems(panels, controlIds(manifest))) console.warn(`[${id}] stage ${problem}`);
  view.setPanels(panels.map((spec) => panelInput(store, connection, id, spec, `${id}/stage/${spec.id}`, placed ? 0 : undefined)));
  const stopTheme = store.onTv((tv) => view.setTheme(tv?.theme));
  return {
    sync: () => view.sync(),
    dispose: () => {
      stopTheme();
      view.destroy();
    },
  };
}

// `layer` is the id of a layer in the scene (an instance), which may come and go while the TV is up.
/** A panel of a layer in the scene, for the TV or the table's ribbon (#78). */
export function panelInput(store: Store, connection: Connection, layer: string | undefined, spec: PanelSpec, key: string, page?: number, touch = true): PanelInput {
  const id = layer ?? '';
  const state = () => store.state.layers[id];
  let cleanups: (() => void)[] = [];
  return {
    controls: layer === undefined ? undefined : panelControls(store, connection, id, touch),
    layer: layer === undefined ? undefined : panelLayer(store, connection, id, touch),
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

/** A panel's layer as a widget reaches it (#355). */
function panelLayer(store: Store, connection: Connection, layer: string, touch: boolean): PanelLayer {
  const base = baseContext(store, connection, layer);
  return {
    touch,
    get manifest() {
      return store.manifest(store.state.layers[layer]?.layer ?? '');
    },
    get site() {
      return base.site;
    },
    get selection() {
      return base.selection;
    },
    select: (set, id) => touch && base.select(set, id),
    sendTool: (tool, geometry) => (touch ? base.sendTool(tool, geometry) : Promise.resolve()),
    action: (id) => (touch ? base.action(id) : Promise.resolve()),
  };
}

/** The ids a control panel may name: the layer's controls and named actions. */
function controlIds(manifest: LayerManifest | undefined): string[] {
  return [...(manifest?.controls ?? []).map((c) => c.id), ...(manifest?.actions ?? []).map((a) => a.id)];
}

/** A layer's controls and named actions as an input widget reaches them (#354). */
function panelControls(store: Store, connection: Connection, layer: string, touch: boolean): PanelControls {
  const manifest = () => store.manifest(store.state.layers[layer]?.layer ?? '');
  const send = paramSender(connection, layer);
  return {
    touch,
    find(id) {
      const m = manifest();
      const named = m?.actions?.find((a) => a.id === id);
      return m?.controls?.find((c) => c.id === id) ?? (named ? { type: 'action' as const, id: named.id, label: named.label } : undefined);
    },
    value: (id) => store.state.layers[layer]?.params?.[id],
    set: (id, value) => send({ [id]: value }),
    press: (id) => void connection.request('layer.action', { layer, action: id }).catch((error: Error) => console.warn(`[${layer}] ${error.message}`)),
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
