import { coreWidgets, DashboardView, validateLayerPanels, validatePage } from '@mrstudio/dashboard';
import type { PanelInput } from '@mrstudio/dashboard';
import type { Connection, LayerManifest, PanelContext, PanelSpec } from '@mrstudio/sdk';

import { baseContext } from './layer-manager.ts';
import { layerModule } from './registry.ts';
import type { Store } from './store.ts';

/**
 * The TV's dashboard canvas. Panels come from two places: each layer's manifest
 * (laid out automatically while the layer is on) or, if the site has hand-made
 * pages in `tv.pages`, from those. Either way they pass the same rules.
 */
export function mountDashboard(root: HTMLElement, store: Store, connection: Connection, dev: boolean): DashboardView {
  const registry = coreWidgets();
  const tv = store.state.site.tv ?? {};
  const view = new DashboardView(root, { registry, dev, rotateS: tv.rotate_s, empty: 'Turn a layer on to see it here' });
  view.setTheme(tv.theme);

  const report = (owner: string, issues: { path: string; message: string }[]) => {
    for (const issue of issues) console.warn(`[${owner}] ${issue.path} ${issue.message}`);
  };

  const input = (layer: string | undefined, spec: PanelSpec, key: string, page?: number): PanelInput => {
    const id = layer ?? '';
    const known = store.state.layers[id] !== undefined;
    const module = known ? layerModule(id) : undefined;
    let cleanups: (() => void)[] = [];
    return {
      key,
      spec,
      page,
      source: () => ({
        params: known ? store.layer(id).params : {},
        shared: known ? store.layer(id).shared : {},
        site: store.state.site as unknown as Record<string, unknown>,
      }),
      // A panel that reads a layer is only up while that layer is on.
      active: () => layer === undefined || (known && store.layer(id).active),
      custom: (el) => {
        if (!known || !module?.panel) return;
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
  };

  const inputs: PanelInput[] = [];
  if (tv.pages?.length) {
    tv.pages.forEach((page, index) => {
      report(`site page ${page.id}`, validatePage(page, registry));
      for (const spec of page.panels ?? []) inputs.push(input(spec.layer, spec, `${page.id}/${spec.id}`, index));
    });
  } else {
    for (const manifest of store.manifests) {
      if (!store.state.layers[manifest.id]) continue;
      const panels = layerPanels(manifest);
      report(manifest.id, validateLayerPanels(panels, registry));
      for (const spec of panels) inputs.push(input(manifest.id, spec, `${manifest.id}/${spec.id}`));
    }
  }
  view.setPanels(inputs);

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

/** A layer's panels. A layer with only a `panel` function gets one tile for it. */
function layerPanels(manifest: LayerManifest): PanelSpec[] {
  if (manifest.panels) return manifest.panels;
  if (!layerModule(manifest.id)?.panel) return [];
  return [{ id: 'panel', widget: 'custom', size: 'tile', title: manifest.name, props: { reads: 3 } }];
}
