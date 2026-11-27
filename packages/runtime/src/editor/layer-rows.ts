// The editor's layer list as drawn (#540): At rest, the layers down each rail with their items, the
// views around the table and the data, with rename, duplicate, remove and the right-click menu. Its
// rules live in layer-list.ts. Moved from editor.ts as functions of the one editor state.
import type { LayerManifest, LayerState } from '@mrstudio/sdk';
import { defaultSideOf, el, isAmbient, isAtRest, layerButton, railButtons } from '../controls.ts';
import { customFromDataset, vectorDatasets } from './builder.ts';
import { icon } from './icons.ts';
import { copyPlace, datasetRows, layerRowWords, listParts, railsOf, restRowWords, stackWords } from './layer-list.ts';
import { targetFor } from './importer.ts';
import { contextMenu, renameInline } from './tree-tools.ts';
import { menuItem } from './ribbon-layout.ts';
import { setting } from './settings-list.ts';
import type { MenuItem } from './tree-tools.ts';
import { AT_REST } from './wizard.ts';
import { comesOn } from './format-pane.ts';
import type { Editor } from './editor.ts';
import { button, markTrouble } from './editor.ts';
import { ask } from './dialogs.ts';
import { addData, bringIn, gallery } from './adding.ts';

export function treeRow(ed: Editor, label: string, detail: string, iconName: string | undefined, selected: boolean, onClick: () => void): HTMLButtonElement {
  const row = el('button', 'ed-row');
  row.type = 'button';
  row.setAttribute('aria-current', String(selected));
  const badge = el('span', 'ed-row-icon');
  badge.append(icon(iconName));
  const text = el('span', 'ed-row-text');
  text.append(el('span', 'ed-row-label', label));
  if (detail) text.append(el('span', 'ed-row-detail', detail));
  row.append(badge, text);
  row.addEventListener('click', () => {
    if (ed.also.size) ed.also.clear();
    onClick();
  });
  return row;
}

/** What Hide and Remove act on: the selection, and the rows added to it. */
export function selection(ed: Editor, target?: string): string[] {
  const first = target ?? (ed.wizard ? null : ed.target());
  if (!first) return [];
  if (target) return [target];
  return [first, ...[...ed.also].filter((id) => id !== first && ed.store.state.layers[id])];
}

/**
 * The Data group of the tree (#52): every dataset of the table. A row opens what can be done
 * with it: make a layer from it, replace it with another file, or take it out of the table.
 */
export function dataRows(ed: Editor): HTMLElement[] {
  const rows = datasetRows(ed.store.state.site.data ?? {}, (name) => targetFor(name));
  const title = el('h2', 'ed-tree-title', 'Data');
  const plus = el('button', 'ed-icon-button');
  plus.type = 'button';
  plus.ariaLabel = 'Add data';
  plus.title = 'Add data';
  plus.append(icon('plus', 14));
  plus.addEventListener('click', () => addData(ed));
  title.append(plus);
  const nodes: HTMLElement[] = [title];
  if (rows.length === 0) nodes.push(el('p', 'ed-empty', 'No data yet. Bring in a file or fetch it from OpenStreetMap with the + above.'));
  for (const { name, path, label, detail, icon: iconName } of rows) {
    const row = treeRow(ed, label, detail, iconName, false, () => dataMenu(ed, row, name, path));
    row.dataset.dataset = name;
    row.setAttribute('aria-haspopup', 'menu');
    nodes.push(row);
  }
  return nodes;
}

/** What can be done with one dataset, in a menu under its row. */
export function dataMenu(ed: Editor, anchor: HTMLElement, name: string, path: string): void {
  document.querySelector('.ed-data-menu')?.remove();
  const menu = el('div', 'ed-file-menu ed-data-menu');
  menu.setAttribute('role', 'menu');
  menu.ariaLabel = name;
  const close = (): void => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (event: PointerEvent): void => {
    if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  };
  const item = (label: string, iconName: string, run: () => void, disabled = false, tip = ''): void => {
    const node = button('ed-file-item', label, iconName);
    node.setAttribute('role', 'menuitem');
    node.disabled = disabled;
    node.title = tip;
    node.addEventListener('click', () => {
      close();
      run();
    });
    menu.append(node);
  };
  const known = targetFor(name);
  const vector = vectorDatasets(ed.store).some((d) => d.name === name);
  item('Make a layer from it', 'brush', () => void customFromDataset(ed.builderHost(), name), !vector, vector ? 'A custom layer of this data, opened in the builder' : 'Only map data and tables with places can be drawn');
  // The files the table is made of are replaced where they were brought in: Your place.
  const yourPlace = known && !known.target.startsWith('data:');
  item('Replace with another file\u2026', 'reset', () => (yourPlace ? bringIn(ed, known.target) : addData(ed, undefined, name)));
  item('Take out of the table', 'trash', () => void forgetData(ed, name, known?.name ?? name), Boolean(yourPlace), yourPlace ? 'Part of Your place: replace it there' : `The file ${path} stays in the table folder`);
  const box = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${box.left + 24}px`;
  menu.style.top = `${box.bottom + 2}px`;
  ed.shell.append(menu);
  // A row near the bottom of the window opens its menu above it, so all of it shows.
  if (box.bottom + 2 + menu.offsetHeight > window.innerHeight - 8) menu.style.top = `${Math.max(8, box.top - menu.offsetHeight - 2)}px`;
  document.addEventListener('pointerdown', outside, true);
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      anchor.focus();
    }
  });
  menu.querySelector<HTMLButtonElement>('.ed-file-item:not(:disabled)')?.focus();
}

/** Takes a dataset out of site.json, or says what still reads it. */
export async function forgetData(ed: Editor, name: string, label: string): Promise<void> {
  try {
    await ed.connection.request('data.remove', { name });
  } catch (error) {
    await ask(ed, `${label} is still in use`, `${(error as Error).message.replace(/^./, (c) => c.toUpperCase())}.`, [{ id: 'ok', label: 'OK', primary: true }]);
  }
}

export function renderTree(ed: Editor, instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
  if (ed.tree.querySelector('.ed-rename')) {
    ed.treeWaiting = true;
    return;
  }
  ed.treeWaiting = false;
  const { context } = ed;
  const { rest: ambient, layers, itemsOf } = listParts(instances, isAtRest);
  const nodes: HTMLElement[] = [];

  nodes.push(el('h2', 'ed-tree-title', 'Map'));
  const home = treeRow(ed, AT_REST, ambient.length > 0 ? 'When no layer is open' : 'Nothing yet', 'moon', context.kind === 'home' && !ed.homeItem, () => {
    ed.homeItem = null;
    ed.go({ kind: 'home' });
  });
  home.dataset.context = 'home';
  nodes.push(home);
  // Map life as rows under At rest, like the slide master's layouts (#382): select one to format it,
  // its eye turns it on or off. The eye is the one home of that switch (docs/editor-ui.md).
  const rest = el('div', 'ed-rest');
  rest.setAttribute('role', 'group');
  rest.ariaLabel = AT_REST;
  for (const { id, manifest, state } of ambient) rest.append(restRow(ed, id, manifest, state, context.kind === 'home' && ed.homeItem === id));
  nodes.push(rest);

  const title = el('h2', 'ed-tree-title', 'Layers');
  const plus = el('button', 'ed-icon-button');
  plus.type = 'button';
  plus.ariaLabel = 'New layer';
  plus.title = 'New layer';
  plus.append(icon('plus', 14));
  plus.setAttribute('aria-haspopup', 'dialog');
  plus.addEventListener('click', () => gallery(ed));
  title.append(plus);
  nodes.push(title);
  if (layers.length === 0) {
    const empty = el('div', 'ed-empty lg-empty');
    const start = button('ed-button is-primary', 'New layer', 'plus');
    start.addEventListener('click', () => gallery(ed));
    empty.append(el('p', undefined, 'No layers yet. Each layer becomes a button on the controller.'), start);
    nodes.push(empty);
  } else {
    // The list shows the controller's two rails (#58). Move up and Move down change the order; a
    // button's side is set in its Format pane, the one place for it (rule 7).
    const rails = listRails(ed, layers);
    for (const side of ['left', 'right'] as const) {
      const zone = setting('layer.order', 'list:move', el('div', 'ed-rail'));
      zone.dataset.side = side;
      zone.setAttribute('role', 'group');
      zone.ariaLabel = side === 'left' ? 'Left of the controller' : 'Right of the controller';
      zone.append(el('div', 'ed-rail-name', side === 'left' ? 'Left' : 'Right'));
      for (const id of rails[side]) {
        const layer = layers.find((i) => i.id === id)!;
        zone.append(layerRow(ed, layer.id, layer.manifest, layer.state, context.kind === 'layer' && context.id === id && ed.layerItem === null));
        const as = layerButton(id, layer.manifest, layer.state);
        // Its items, indented under it: they show only while it is open.
        // A glass or a reveal line says which stack each item is in (#606).
        const stacked = Boolean(layer.manifest.reveals);
        for (const item of itemsOf(id)) {
          const child = treeRow(ed, item.manifest.name, stackWords(stacked, item.state.stack), item.manifest.icon, context.kind === 'layer' && context.id === id && ed.layerItem === item.id, () =>
            ed.go({ kind: 'layer', id }, item.id),
          );
          child.classList.add('is-item');
          child.dataset.layer = item.id;
          child.title = `${item.manifest.name}: shows while ${as.name} is open`;
          child.classList.toggle('is-off', !comesOn(ed, item.id));
          child.dataset.troubleTitle = child.title;
          markTrouble(child, item.state);
          child.addEventListener('contextmenu', (event) => rowMenu(ed, event, item.id));
          const previous = ed.sync.get(item.id);
          ed.sync.set(item.id, (next) => {
            previous?.(next);
            child.classList.toggle('is-off', !comesOn(ed, item.id));
            markTrouble(child, next);
          });
          zone.append(child);
        }
      }
      if (rails[side].length === 0) zone.append(el('p', 'ed-rail-empty', 'No buttons on this side. A layer’s Format pane sets its side.'));
      nodes.push(zone);
    }
  }

  nodes.push(el('h2', 'ed-tree-title', 'Around the table'));
  const controller = treeRow(ed, 'Controller', 'Buttons, controls and dashboard', 'tv', context.kind === 'controller', () => ed.go({ kind: 'controller' }));
  controller.dataset.context = 'controller';
  const phones = treeRow(ed, 'Phones', 'Personal controllers', 'phone', context.kind === 'phone', () => ed.go({ kind: 'phone' }));
  phones.dataset.context = 'phone';
  nodes.push(controller, phones);
  nodes.push(...dataRows(ed));
  ed.tree.replaceChildren(...nodes);
}

// ---- The layer list (#58) ---------------------------------------------------

/** The layer buttons down each rail of the controller, as visitors see them, with hidden ones on their side too. */
export function listRails(ed: Editor, layers: { id: string; manifest: LayerManifest; state: LayerState }[]): Record<'left' | 'right', string[]> {
  return railsOf(railButtons(ed.store, true), layers);
}

/** One piece of map life under At rest: select it to see its settings; the eye turns it on or off. */
export function restRow(ed: Editor, id: string, manifest: LayerManifest, state: LayerState, selected: boolean): HTMLElement {
  const row = treeRow(ed, layerButton(id, manifest).name, '', manifest.icon, selected, () => {
    ed.homeItem = id;
    ed.go({ kind: 'home' });
  });
  row.classList.add('is-item', 'is-rest');
  row.dataset.layer = id;
  row.addEventListener('contextmenu', (event) => rowMenu(ed, event, id));
  const eye = setting('maplife.shown', 'list:eye', el('span', 'ed-row-eye'));
  eye.setAttribute('role', 'switch');
  eye.tabIndex = 0;
  const flip = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
    void ed.send('scene.set', { layer: id, active: !ed.store.state.layers[id]?.active });
  };
  eye.addEventListener('click', flip);
  eye.addEventListener('keydown', (event) => (event.key === 'Enter' || event.key === ' ') && flip(event));
  row.append(eye);
  const draw = (next: LayerState): void => {
    row.classList.toggle('is-off', !next.active);
    eye.replaceChildren(icon(next.active ? 'eye' : 'eye-off', 14));
    eye.setAttribute('aria-checked', String(next.active));
    const words = restRowWords(manifest.name, next.active);
    eye.ariaLabel = words.eyeLabel;
    eye.title = words.eyeTitle;
    markTrouble(row, next);
  };
  row.dataset.troubleTitle = '';
  draw(state);
  ed.sync.set(id, draw);
  return row;
}

/**
 * One layer in the list: its button's icon and name, and an eye that keeps the button off the
 * controller. Click to open it, double-click or F2 to rename, right-click for the rest, drag to move.
 */
export function layerRow(ed: Editor, id: string, manifest: LayerManifest, state: LayerState, selected: boolean): HTMLElement {
  const row = el('div', 'ed-row is-layer');
  row.tabIndex = 0;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-current', String(selected));
  row.dataset.layer = id;
  const badge = el('span', 'ed-row-icon');
  const text = el('span', 'ed-row-text');
  const label = el('span', 'ed-row-label');
  const detail = el('span', 'ed-row-detail');
  text.append(label, detail);
  const eye = setting('button.hidden', 'list:eye', el('button', 'ed-row-eye'));
  eye.type = 'button';
  eye.setAttribute('role', 'switch');
  // The side stays readable for tests and screen readers; the rail heading shows it.
  const side = el('span', 'ed-row-side');
  side.hidden = true;
  row.append(badge, text, side, eye);
  const open = (): void => ed.go({ kind: 'layer', id });
  row.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('.ed-row-eye, .ed-rename')) return;
    // Ctrl, ⌘ or Shift adds a row to the selection, as in Office (#399): Hide and Remove act on them all.
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      event.preventDefault();
      if (id === ed.target()) return;
      if (ed.also.has(id)) ed.also.delete(id);
      else ed.also.add(id);
      ed.render();
      return;
    }
    if (ed.also.size) ed.also.clear();
    open();
  });
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    } else if (event.key === 'F2') {
      event.preventDefault();
      rename(ed, id);
    }
  });
  row.addEventListener('dblclick', (event) => {
    if (!(event.target as HTMLElement).closest('.ed-row-eye')) rename(ed, id);
  });
  row.addEventListener('contextmenu', (event) => rowMenu(ed, event, id));
  eye.addEventListener('click', (event) => {
    event.stopPropagation();
    const hidden = Boolean(ed.store.state.layers[id]?.button?.hidden);
    void ed.send('scene.set', { layer: id, button: { hidden: hidden ? null : true } });
  });
  ed.sync.set(id, (next) => {
    const button = layerButton(id, manifest, next, defaultSideOf(ed.store, id));
    label.textContent = button.name;
    detail.textContent = next.button?.group ?? '';
    detail.hidden = !next.button?.group;
    badge.replaceChildren(icon(button.icon));
    side.textContent = button.side === 'right' ? 'Right' : 'Left';
    const hidden = Boolean(next.button?.hidden);
    row.classList.toggle('is-hidden', hidden);
    eye.replaceChildren(icon(hidden ? 'eye-off' : 'eye', 14));
    eye.setAttribute('aria-checked', String(!hidden));
    const words = layerRowWords(button.name, button.side, hidden);
    eye.ariaLabel = words.eyeLabel;
    eye.title = words.eyeTitle;
    row.title = words.title;
    // A layer in trouble shows a red dot and says why (#259).
    row.dataset.troubleTitle = row.title;
    markTrouble(row, next);
  });
  return row;
}

/** Renames a layer's button in the list. */
export function rename(ed: Editor, id: string): void {
  const row = ed.tree.querySelector<HTMLElement>(`.ed-row.is-layer[data-layer="${CSS.escape(id)}"]`);
  const state = ed.store.state.layers[id];
  const manifest = state && ed.store.manifest(state.layer);
  if (!row || !state || !manifest) return;
  renameInline(
    row,
    layerButton(id, manifest, state).name,
    (name) => void ed.send('scene.set', { layer: id, button: { name: name === manifest.name ? null : name } }),
    // A change that came in while typing redraws the list now.
    () => ed.treeWaiting && ed.render(),
  );
}

/** A copy of a layer, or of an item, just above it: its settings, its button and its items. */
export async function duplicate(ed: Editor, id: string): Promise<void> {
  const state = ed.store.state.layers[id];
  const manifest = state && ed.store.manifest(state.layer);
  if (!state || !manifest) return;
  const parent = state.parent ?? null;
  const siblings = ed.siblings(parent);
  const name = layerButton(id, manifest, state).name;
  const { index, button } = copyPlace(siblings, id, name, state, isAmbient(manifest));
  const result = await ed.send('scene.add', {
    use: manifest.id,
    ...(parent ? { parent } : {}),
    index,
    params: state.params,
    active: state.active,
    ...(button ? { button } : {}),
    ...(state.hide?.length ? { hide: state.hide } : {}),
  });
  if (!result?.id) return;
  // Its items come along, in the same order.
  for (const item of ed.siblings(id)) {
    const child = ed.store.state.layers[item];
    const childManifest = child && ed.store.manifest(child.layer);
    if (child && childManifest) await ed.send('scene.add', { use: childManifest.id, parent: result.id, params: child.params, active: comesOn(ed, item) });
  }
  ed.added = result.id;
  ed.render();
}

/** Takes a layer or an item out, with Undo on the notice: Delete is one key press. */
export async function removeLayer(ed: Editor, id: string): Promise<void> {
  const state = ed.store.state.layers[id];
  const manifest = state && ed.store.manifest(state.layer);
  if (!state || !manifest) return;
  const name = layerButton(id, manifest, state).name;
  const done = await ed.send('scene.remove', { layer: id });
  if (done) ed.history.undoable(`Removed ${name}`, 'Undo puts it back with its settings.');
}

/** The right-click menu of a layer, an item or a piece of the map at rest. */
export function rowMenu(ed: Editor, event: MouseEvent, id: string): void {
  event.preventDefault();
  const state = ed.store.state.layers[id];
  const manifest = state && ed.store.manifest(state.layer);
  if (!state || !manifest) return;
  const layer = !state.parent && !isAtRest(manifest, state);
  // The same commands as the ribbon, by the same names (#392); Settings… selects it (docs/editor-ui.md, "Right-click").
  const h = ed.handlers;
  const settings: MenuItem = { label: 'Settings…', icon: 'settings', run: () => (state.parent ? ed.go({ kind: 'layer', id: state.parent }, id) : layer ? ed.go({ kind: 'layer', id }) : ((ed.homeItem = id), ed.go({ kind: 'home' }))) };
  const items: MenuItem[] = [];
  if (layer) {
    const hidden = Boolean(state.button?.hidden);
    items.push(
      menuItem('layer.rename', h, id),
      menuItem('layer.duplicate', h, id),
      menuItem('dialog.inside', h, id),
      'line',
      { label: hidden ? 'Show on the controller' : 'Hide from the controller', icon: hidden ? 'eye' : 'eye-off', run: () => void ed.send('scene.set', { layer: id, button: { hidden: hidden ? null : true } }) },
    );
  } else items.push(menuItem('layer.toggle', h, id), menuItem('layer.up', h, id), menuItem('layer.down', h, id), menuItem('layer.duplicate', h, id));
  items.push(menuItem('layer.reset', h, id), 'line', menuItem('layer.remove', h, id, { danger: true }), 'line', settings);
  contextMenu(items, { x: event.clientX, y: event.clientY }, ed.shell, `${layerButton(id, manifest, state).name}`);
}
