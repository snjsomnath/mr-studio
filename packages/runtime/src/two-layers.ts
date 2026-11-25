// Two layers at once (#473): a second layer joins the open one, such as Wind over Sunlight. At
// most two; a third replaces the older. Every surface works out the same order from the state as
// it changes, so the controller, the phones and the ribbons agree which one is newest.

import type { Connection } from '@mrstudio/sdk';

import { isAtRest } from './layer-manager.ts';
import type { Store } from './store.ts';

const orders = new WeakMap<Store, string[]>();

/** The order the open layers were turned on in, oldest first, kept as the state changes. */
function opened(store: Store): string[] {
  let order = orders.get(store);
  if (!order) {
    const list: string[] = store.state.scene.filter((id) => store.state.layers[id]?.active);
    order = list;
    orders.set(store, list);
    store.onLayer((id, state, previous) => {
      const i = list.indexOf(id);
      if (state.active && !previous?.active) {
        if (i >= 0) list.splice(i, 1);
        list.push(id);
      } else if (!state.active && i >= 0) list.splice(i, 1);
    });
  }
  return order;
}

/** The layers a visitor chose that are open now, oldest first: on, not part of another, not the map at rest, not a tool kept alongside. */
export function chosenLayers(store: Store): string[] {
  const order = opened(store);
  const open = store.state.scene.filter((id) => {
    const state = store.state.layers[id];
    const manifest = state && store.manifest(state.layer);
    return Boolean(state?.active && !state.parent && !state.shown_by && manifest && !isAtRest(manifest, state) && !manifest.alongside);
  });
  // A layer that was on before this screen loaded counts as older than one opened since.
  const rank = (id: string) => order.indexOf(id);
  return open.sort((a, b) => rank(a) - rank(b));
}

/** Whether `id` may join the open layer rather than replace it: the table allows two, and neither fills the table on its own. */
export function canJoin(store: Store, id: string): boolean {
  const state = store.state.layers[id];
  const manifest = state && store.manifest(state.layer);
  if (!manifest || state.active || manifest.alongside || manifest.combine === false || store.state.site.tv?.two_layers === false) return false;
  if (Object.values(store.state.layers).some((layer) => layer.shown_by)) return false;
  const others = chosenLayers(store).filter((other) => other !== id);
  return others.length > 0 && others.every((other) => store.manifest(store.state.layers[other]!.layer)?.combine !== false);
}

/**
 * Turns `id` on next to the open layer (#473). The open layer stays; with two open already, the
 * older goes. A layer that can't share the table opens alone, as its button does.
 */
export function joinLayer(store: Store, connection: Connection, id: string): Promise<void> {
  const join = canJoin(store, id);
  const others = chosenLayers(store).filter((other) => other !== id);
  return connection.request('layer.activate', { layer: id, active: true }).then(() => {
    const going = join ? others.slice(0, -1) : others;
    for (const other of going) void connection.request('layer.activate', { layer: other, active: false, cue: false }).catch(() => {});
  });
}
