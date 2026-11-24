// The layer builder (#38) with its styler (#95), colour by data (#94) and the table's
// palette (#93). A custom layer is data, then a look, then motion, then interaction,
// saved as a recipe in site.json (site.md, Custom layers). The builder is the inspector
// of a custom layer: every change is saved at once (`custom.save`), and the table, the
// editor's map and the projector all restyle live, so there is no separate preview.

import {
  LOOK_DEFAULTS,
  MOTIONS_FOR,
  MOTION_DEFAULTS,
  PALETTE_SETS,
  PALETTE_SLOTS,
  SLOT_ROLES,
  compileLook,
  lookFor,
  paletteHex,
  profileColumns,
  projectionWarning,
  readShapes,
  recipeLegend,
  resolvePalette,
  tableFrame,
  ICONS,
  POINT_SHAPES,
  timeColumns,
  PLACE_DATA_HELP,
  PLACE_MOTIONS,
  SHARED_KNOBS,
  placeMotion,
  soundColumns,
  soundPath,
  columnCategories,
  schemeFor,
  CATEGORY_SCHEMES,
  paintScale,
  LISTEN_KEY,
  TEST_DATA,
  makeTestData,
} from '@mrstudio/sdk';
import type { CustomLayer, GeometryKind, LayerManifest, Paint, RecipeBlock, ResolvedPalette, Shapes, SitePalette, Size, TestDataDef } from '@mrstudio/sdk';

import { el, layerButton } from '../controls.ts';
import { dataUrl, loadData } from '../recipe-player.ts';
import type { Store } from '../store.ts';
import { icon } from './icons.ts';
import './builder.css';

export interface BuilderHost {
  store: Store;
  /** Sends a request to the host and shows "Saved" or the problem. */
  send(method: string, params: object): Promise<any>;
  /** Opens the Add data dialog. */
  addData(): void;
  /** Adds a layer from the catalogue to the table and selects it. */
  addLayer(use: string): Promise<void>;
  /** Holds back the reload a site change causes, so several files and a layer land as one (#308). */
  hold?(on: boolean): void;
}

// ---- Shared bits -------------------------------------------------------------------

function button(className: string, label: string, iconName?: string): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName, 14));
  node.append(el('span', undefined, label));
  return node;
}

function field(label: string, ...inputs: HTMLElement[]): HTMLElement {
  const row = el('div', 'ed-field');
  const wrap = el('div', 'lb-inputs');
  wrap.append(...inputs);
  row.append(el('span', undefined, label), wrap);
  return row;
}

function segmented<T extends string>(options: readonly (readonly [T, string])[], value: T, onPick: (value: T) => void, label: string): HTMLElement {
  const group = el('div', 'segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  for (const [option, text] of options) {
    const b = el('button', undefined, text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(option === value));
    b.addEventListener('click', () => {
      for (const other of group.children) other.setAttribute('aria-checked', String(other === b));
      onPick(option);
    });
    group.append(b);
  }
  return group;
}

/** A slider with its value, in the unit given. */
function slider(value: number, min: number, max: number, step: number, unit: string, onInput: (value: number) => void): HTMLElement {
  const wrap = el('div', 'lb-slider');
  const input = el('input');
  Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const shown = el('output', undefined, `${value}${unit}`);
  input.addEventListener('input', () => {
    shown.textContent = `${input.value}${unit}`;
    onInput(Number(input.value));
  });
  wrap.append(input, shown);
  return wrap;
}

const SHAPE_SVG: Record<string, string> = {
  circle: '<circle cx="12" cy="12" r="8"/>',
  square: '<rect x="5" y="5" width="14" height="14"/>',
  diamond: '<path d="M12 2l10 10-10 10L2 12z"/>',
  triangle: '<path d="M12 3l10 17H2z"/>',
  ring: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="3.5"/>',
  icon: '<path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.2 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/>',
};
const SHAPE_LABEL: Record<string, string> = { circle: 'Circle', square: 'Square', diamond: 'Diamond', triangle: 'Triangle', ring: 'Ring', icon: 'Pictogram' };

/** A row of small picture buttons, one of them pressed. */
function swatches(options: { value: string; title: string; svg: string }[], value: string, onPick: (value: string) => void, label: string): HTMLElement {
  const row = el('div', 'lb-swatches');
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', label);
  for (const option of options) {
    const b = el('button', 'lb-swatch');
    b.type = 'button';
    b.title = option.title;
    b.setAttribute('aria-label', option.title);
    b.setAttribute('aria-pressed', String(option.value === value));
    b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">${option.svg}</svg>`;
    b.addEventListener('click', () => {
      for (const other of row.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === b));
      onPick(option.value);
    });
    row.append(b);
  }
  return row;
}

function toggle(checked: boolean, onChange: (checked: boolean) => void, label: string): HTMLElement {
  const input = el('input');
  Object.assign(input, { type: 'checkbox', className: 'switch', checked });
  input.ariaLabel = label;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

const RECENT_KEY = 'mrs-recent-colours';
function recentColours(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]').filter((c: unknown) => typeof c === 'string').slice(0, 8);
  } catch {
    return [];
  }
}
function rememberColour(hex: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([hex, ...recentColours().filter((c) => c !== hex)].slice(0, 8)));
  } catch {
    // No storage: no recent colours.
  }
}

/**
 * The one colour picker (#93): the table's palette slots first, then recent colours, then
 * any colour (with the eyedropper where the browser has one), warning when a colour is too
 * dark to project. `value` is `@slot` or `#rrggbb`.
 */
export function colourPicker(value: string | null, palette: () => ResolvedPalette, onPick: (value: string | null) => void, options: { allowNone?: boolean; label?: string } = {}): HTMLElement {
  const wrap = el('div', 'lb-colour');
  const swatch = el('button', 'lb-swatch-button');
  swatch.type = 'button';
  swatch.ariaLabel = options.label ?? 'Colour';
  const chip = el('span', 'lb-chip');
  const name = el('span', 'lb-colour-name');
  swatch.append(chip, name);
  const show = (next: string | null) => {
    value = next;
    chip.classList.toggle('is-none', !next);
    chip.style.background = next ? paletteHex(next, palette()) : '';
    name.textContent = !next ? 'None' : next.startsWith('@') ? next.slice(1).replace(/^cat(\d)$/, 'Category $1').replace(/^./, (c) => c.toUpperCase()) : next;
  };
  show(value);
  const pop = el('div', 'lb-pop');
  pop.hidden = true;
  const close = () => {
    pop.hidden = true;
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (event: Event) => {
    if (!wrap.contains(event.target as Node)) close();
  };
  const pick = (next: string | null) => {
    show(next);
    if (next && !next.startsWith('@')) rememberColour(next);
    onPick(next);
    draw();
  };
  const draw = () => {
    const resolved = palette();
    const grid = el('div', 'lb-pop-grid');
    for (const slot of PALETTE_SLOTS) {
      const b = el('button', 'lb-swatch');
      b.type = 'button';
      b.style.background = resolved.slots[slot];
      b.title = SLOT_ROLES[slot];
      b.ariaLabel = SLOT_ROLES[slot];
      b.setAttribute('aria-pressed', String(value === `@${slot}`));
      b.addEventListener('click', () => pick(`@${slot}`));
      grid.append(b);
    }
    const recent = recentColours();
    const recentRow = el('div', 'lb-pop-grid');
    for (const hex of recent) {
      const b = el('button', 'lb-swatch');
      b.type = 'button';
      b.style.background = hex;
      b.title = hex;
      b.addEventListener('click', () => pick(hex));
      recentRow.append(b);
    }
    const custom = el('div', 'lb-pop-custom');
    const native = el('input');
    Object.assign(native, { type: 'color', value: value ? paletteHex(value, resolved) : '#ffffff' });
    native.ariaLabel = 'Any colour';
    const hex = el('input');
    Object.assign(hex, { type: 'text', value: value && !value.startsWith('@') ? value : '', placeholder: '#rrggbb', maxLength: 7 });
    hex.ariaLabel = 'Hex colour';
    native.addEventListener('input', () => {
      hex.value = native.value;
      pick(native.value);
    });
    hex.addEventListener('change', () => /^#[0-9a-f]{6}$/i.test(hex.value.trim()) && pick(hex.value.trim().toLowerCase()));
    custom.append(native, hex);
    const dropper = (window as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (dropper) {
      const b = button('lb-small', 'Pick from screen', 'eyedropper');
      b.addEventListener('click', () => void new dropper().open().then((r) => pick(r.sRGBHex)).catch(() => {}));
      custom.append(b);
    }
    const warning = value ? projectionWarning(paletteHex(value, resolved)) : null;
    const nodes: HTMLElement[] = [el('h4', undefined, 'Table palette'), grid];
    if (recent.length) nodes.push(el('h4', undefined, 'Recent'), recentRow);
    nodes.push(el('h4', undefined, 'Any colour'), custom);
    if (options.allowNone) {
      const none = button('lb-small', 'No colour');
      none.addEventListener('click', () => pick(null));
      nodes.push(none);
    }
    if (warning) nodes.push(el('p', 'lb-warning', warning));
    pop.replaceChildren(...nodes);
  };
  swatch.addEventListener('click', () => {
    if (!pop.hidden) return close();
    draw();
    pop.hidden = false;
    document.addEventListener('pointerdown', outside, true);
  });
  wrap.append(swatch, pop);
  return wrap;
}

// ---- Data -----------------------------------------------------------------------

/** The datasets of the site a custom layer can draw: vector files, by name. */
export function vectorDatasets(store: Store): { name: string; path: string }[] {
  return Object.entries(store.state.site.data ?? {})
    .filter(([, path]) => /\.(geo)?json$|\.csv$/i.test(path))
    .map(([name, path]) => ({ name, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const shapeCache = new Map<string, Promise<Shapes>>();
function shapesOf(store: Store, url: string): Promise<Shapes> {
  let shapes = shapeCache.get(url);
  if (!shapes) {
    shapes = loadData(url).then((collection) => readShapes(collection, tableFrame(store.state.site)));
    shapes.catch(() => shapeCache.delete(url));
    shapeCache.set(url, shapes);
  }
  return shapes;
}

function describeShapes(shapes: Shapes): string {
  const parts: string[] = [];
  if (shapes.spots.length) parts.push(`${shapes.spots.length} point${shapes.spots.length === 1 ? '' : 's'}`);
  if (shapes.paths.length) parts.push(`${shapes.paths.length} line${shapes.paths.length === 1 ? '' : 's'}`);
  if (shapes.areas.length) parts.push(`${shapes.areas.length} area${shapes.areas.length === 1 ? '' : 's'}`);
  return parts.join(', ') || 'Nothing on this table';
}

const KIND_ICON: Record<GeometryKind, string> = { points: 'point', lines: 'line', fill: 'polygon' };
const KIND_LABEL: Record<GeometryKind, string> = { points: 'Points', lines: 'Lines', fill: 'Areas' };

/** Presets per geometry (L3): starting points, not the end. */
const PRESETS: Record<GeometryKind, { name: string; props: Record<string, unknown>; motion?: { block: string; props: Record<string, unknown> } }[]> = {
  points: [
    { name: 'Glowing points', props: { color: '@accent', radius_mm: 4, glow: 0.8, core: true, opacity: 1 } },
    { name: 'Pulse from a hub', props: { color: '@warm', radius_mm: 5, glow: 0.6, core: true, opacity: 1 }, motion: { block: 'pulse', props: { period_s: 2, size_mm: 16, rings: 2, direction: 1 } } },
    { name: 'Crowd to places', props: { color: '@warm', radius_mm: 4.5, glow: 0.7, core: true, opacity: 1 }, motion: { block: 'gravity', props: { ...MOTION_DEFAULTS.gravity } } },
    { name: 'Quiet dots', props: { color: '@neutral', radius_mm: 2.5, glow: 0, core: false, opacity: 0.8 } },
  ],
  lines: [
    { name: 'Bright route', props: { color: '@focus', width_mm: 3, glow: 0.5, casing: true, dash: 'solid' } },
    { name: 'Flow lines', props: { color: '@accent', width_mm: 2, glow: 0.4, casing: true, dash: 'solid' }, motion: { block: 'flow', props: { speed_mm: 14 } } },
    { name: 'Commuter flows', props: { color: '@cool', width_mm: 1, glow: 0.2, casing: false, dash: 'solid', opacity: 0.45 }, motion: { block: 'particles', props: { ...MOTION_DEFAULTS.particles } } },
    { name: 'Drawn in', props: { color: '@warm', width_mm: 2.5, glow: 0.3, casing: true, dash: 'solid' }, motion: { block: 'draw-in', props: { duration_s: 2.5, stagger: true } } },
    { name: 'Dashed plan', props: { color: '@cool', width_mm: 1.5, glow: 0, casing: false, dash: 'dashed', dash_mm: 5, gap_mm: 3 } },
  ],
  fill: [
    { name: 'Calm zones', props: { color: '@cool', opacity: 0.35, stroke: '@cool', stroke_mm: 0.5, edge_glow: 0, shadow_mm: 0, hatch: false } },
    { name: 'Glowing edges', props: { color: '@accent', opacity: 0.15, stroke: '@accent', stroke_mm: 0.8, edge_glow: 0.8, shadow_mm: 0, hatch: false } },
    { name: 'Lifted', props: { color: '@warm', opacity: 0.55, stroke: null, stroke_mm: 0, edge_glow: 0, shadow_mm: 3, hatch: false } },
    { name: 'Hatched', props: { color: '@warning', opacity: 0.5, stroke: '@warning', stroke_mm: 0.5, edge_glow: 0, shadow_mm: 0, hatch: true } },
  ],
};

/** An id for a new custom layer from its name, free in the catalogue. */
export function freeId(store: Store, name: string): string {
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom').slice(0, 32);
  const taken = (id: string) => store.manifests.some((m) => m.id === id) || id in store.state.layers;
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken(id)) return id;
  }
}

/** The recipe a dataset starts with: its main geometry gets that geometry's first preset (D2). */
export function startingRecipe(name: string, dataset: string, kind: GeometryKind): CustomLayer {
  const preset = PRESETS[kind][0]!;
  return {
    name,
    icon: kind === 'lines' ? 'route' : kind === 'points' ? 'point' : 'polygon',
    category: 'analysis',
    enter: 'fade',
    data: [{ id: 'data', dataset }],
    look: [{ id: 'look', block: kind, data: 'data', props: { ...LOOK_DEFAULTS[kind], ...preset.props } }],
  };
}

/**
 * A layer for a dataset just brought in, coloured as the author chose in the import (#94):
 * the starting recipe for its geometry with that paint, saved and put on the table.
 */
export async function layerFromImport(host: BuilderHost, layer: { dataset: string; kind: GeometryKind; paint: Paint }): Promise<void> {
  const title = layer.dataset.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const id = freeId(host.store, title);
  const recipe = startingRecipe(title, layer.dataset, layer.kind);
  recipe.look![0]!.props = { ...recipe.look![0]!.props, color: layer.paint };
  if (await host.send('custom.save', { id, recipe })) await host.addLayer(`custom:${id}`);
}

/**
 * New custom layer: pick what it shows from the table's data, and it is made, put on
 * the table and opened in the builder. The New layer gallery (#59) opens the same dialog
 * from its Custom card.
 */
export function newCustomLayer(host: BuilderHost, shell: HTMLElement): void {
  const dialog = el('dialog', 'im-dialog lb-new');
  dialog.ariaLabel = 'New custom layer';
  const head = el('header', 'im-dialog-head');
  const close = el('button', 'ed-icon-button', '×');
  close.type = 'button';
  close.ariaLabel = 'Close';
  close.addEventListener('click', () => dialog.close());
  head.append(el('h2', undefined, 'New custom layer'), close);
  const list = el('div', 'lb-data-list');
  const datasets = vectorDatasets(host.store);
  for (const { name, path } of datasets) {
    const card = el('button', 'lb-data-card');
    card.type = 'button';
    const badge = el('span', 'lb-data-icon');
    badge.append(icon('layers', 20));
    const text = el('span', 'lb-data-text');
    const detail = el('span', 'lb-data-detail', 'Reading…');
    text.append(el('strong', undefined, name), detail);
    card.append(badge, text);
    card.disabled = true;
    let kind: GeometryKind = 'points';
    void shapesOf(host.store, `/site/${path}`).then(
      (shapes) => {
        kind = lookFor(shapes);
        badge.replaceChildren(icon(KIND_ICON[kind], 20));
        detail.textContent = describeShapes(shapes);
        card.disabled = shapes.areas.length + shapes.paths.length + shapes.spots.length === 0;
      },
      () => (detail.textContent = 'Could not be read'),
    );
    card.addEventListener('click', async () => {
      const title = name.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
      const id = freeId(host.store, title);
      const saved = await host.send('custom.save', { id, recipe: startingRecipe(title, name, kind) });
      dialog.close();
      if (saved) await host.addLayer(`custom:${id}`);
    });
    list.append(card);
  }
  const more = button('action', 'Bring in a file…', 'plus');
  more.addEventListener('click', () => {
    dialog.close();
    host.addData();
  });
  // Test data (#308): random points, places, lines or areas on this table, to try looks and motions on.
  const tests = el('div', 'lb-data-list lb-test-list');
  const status = el('p', 'lb-hint');
  const cards: HTMLButtonElement[] = [];
  for (const def of TEST_DATA) {
    const card = el('button', 'lb-data-card');
    card.type = 'button';
    const badge = el('span', 'lb-data-icon is-test');
    badge.append(icon(KIND_ICON[def.geometry], 20));
    const text = el('span', 'lb-data-text');
    text.append(el('strong', undefined, def.label), el('span', 'lb-data-detail', def.about));
    card.append(badge, text);
    card.addEventListener('click', async () => {
      for (const c of cards) c.disabled = true;
      status.textContent = `Making ${def.label.toLowerCase()}…`;
      const made = await addTestData(host, def).catch((error: Error) => error.message);
      if (made === true) return dialog.close();
      status.textContent = made;
      for (const c of cards) c.disabled = false;
    });
    cards.push(card);
    tests.append(card);
  }
  dialog.append(
    head,
    el('p', 'wz-lead', 'Choose what the layer shows. It starts with a look that fits the data, and you style it on the right while the map shows it live.'),
    datasets.length ? list : el('p', 'ed-empty', 'This table has no points, lines or areas of its own yet.'),
    more,
    el('h3', 'lb-new-sub', 'Or try it with test data'),
    el('p', 'lb-hint lb-new-hint', 'Made up on the spot, spread over this table, with columns to colour, size and animate by. Each becomes a dataset of the table, so you can remove it later.'),
    tests,
    status,
  );
  dialog.addEventListener('close', () => dialog.remove());
  shell.append(dialog);
  dialog.showModal();
}

/** A dataset name not yet used on this table: `test-points`, then `test-points-2`… */
function freeDataset(store: Store, base: string, suffixes: readonly string[]): string {
  const data = store.state.site.data ?? {};
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (suffixes.every((s) => !(`${name}${s}` in data))) return name;
  }
}

/** The look each kind of test data starts with: coloured by one of its columns, places already moving. */
function testRecipe(def: TestDataDef, dataset: string): CustomLayer {
  const recipe = startingRecipe(def.label, dataset, def.geometry);
  const look = recipe.look![0]!;
  const props = look.props!;
  if (def.kind === 'points') Object.assign(props, { color: { by: 'kind', kind: 'category' }, radius_mm: { by: 'value', range: [2, 6] } });
  if (def.kind === 'lines') Object.assign(props, { color: { by: 'kind', kind: 'category' } });
  if (def.kind === 'areas') Object.assign(props, { color: { by: 'population', kind: 'number' }, opacity: 0.55 });
  if (def.kind === 'places') {
    Object.assign(props, { color: { by: 'category', kind: 'category' }, radius_mm: { by: 'weight', range: [3, 6] } });
    recipe.motion = [{
      id: `${look.id}-place`,
      block: 'place',
      on: look.id,
      props: { motion: 'orbiters', activity: `${dataset}-activity`, flows: `${dataset}-flows`, links: `${dataset}-links`, colours: 'category' },
    }];
  }
  return recipe;
}

/**
 * Makes test data on this table (#308): its files go through the normal import, as datasets
 * of their own, then a custom layer showing them is saved and put on the table, all as one
 * change. True when done, else the problem in a sentence.
 */
export async function addTestData(host: BuilderHost, def: TestDataDef): Promise<true | string> {
  const files = makeTestData(def.kind, host.store.state.site);
  const dataset = freeDataset(host.store, def.dataset, files.map((f) => f.suffix));
  host.hold?.(true);
  try {
    for (const file of files) {
      const response = await fetch(`/api/data/import?target=${encodeURIComponent(`data:${dataset}${file.suffix}`)}`, {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.filename.replace(def.dataset, dataset)) },
        body: file.text,
      });
      if (response.status !== 200) {
        const report = await response.json().catch(() => null) as { summary?: string } | null;
        return `The table did not take ${file.filename}: ${report?.summary ?? response.status}.`;
      }
    }
    const id = freeId(host.store, def.label);
    if (!(await host.send('custom.save', { id, recipe: testRecipe(def, dataset) }))) return 'The layer could not be saved.';
    await host.addLayer(`custom:${id}`);
    return true;
  } finally {
    host.hold?.(false);
  }
}

/** Where a saved custom layer is used on this table: its buttons, and the slides that show it. */
export function customUses(store: Store, id: string): { id: string; name: string; slide?: string }[] {
  const uses = [];
  for (const instance of store.state.scene) {
    const state = store.state.layers[instance];
    const manifest = state && store.manifest(state.layer);
    if (!state || !manifest?.custom || state.layer !== id) continue;
    const parent = state.parent ? store.state.layers[state.parent] : undefined;
    const parentManifest = parent && store.manifest(parent.layer);
    uses.push({
      id: instance,
      name: layerButton(instance, manifest, state).name,
      slide: parent && parentManifest && state.parent ? layerButton(state.parent, parentManifest, parent).name : undefined,
    });
  }
  return uses;
}

/**
 * Delete custom layers (#154): every saved one, with where it is used. Deleting asks first, takes
 * it off the table and out of any slideshow, then deletes the saved recipe. Undo brings it back.
 */
export function deleteCustomDialog(host: BuilderHost, shell: HTMLElement, only?: string): void {
  const dialog = el('dialog', 'im-dialog lb-new lb-delete');
  dialog.ariaLabel = 'Delete custom layers';
  const head = el('header', 'im-dialog-head');
  const close = el('button', 'ed-icon-button', '×');
  close.type = 'button';
  close.ariaLabel = 'Close';
  close.addEventListener('click', () => dialog.close());
  head.append(el('h2', undefined, only ? 'Delete this custom layer' : 'Delete custom layers'), close);
  const list = el('div', 'lb-data-list');
  // Deleted here: the catalogue on this surface catches up a moment later.
  const gone = new Set<string>();
  const draw = () => {
    const saved = host.store.manifests.filter((m) => m.custom && !gone.has(m.id) && (!only || m.id === only));
    list.replaceChildren();
    if (saved.length === 0) list.append(el('p', 'ed-empty', 'This table has no custom layers.'));
    for (const manifest of saved) {
      const id = manifest.id.replace(/^custom:/, '');
      const uses = customUses(host.store, id);
      const card = el('div', 'lb-data-card lb-delete-card');
      const badge = el('span', 'lb-data-icon');
      badge.append(icon(manifest.icon ?? 'layers', 20));
      const text = el('span', 'lb-data-text');
      const where = uses.map((u) => (u.slide ? `a slide in ${u.slide}` : `the ${u.name} button`));
      text.append(
        el('strong', undefined, manifest.custom?.name ?? manifest.name),
        el('span', 'lb-data-detail', where.length ? `Used by ${where.join(', ')}` : 'Not on the table'),
      );
      const remove = button('action', 'Delete…', 'trash');
      remove.addEventListener('click', async () => {
        const also = where.length ? ` It also comes off the table: ${where.join(', ')}.` : '';
        if (!window.confirm(`Delete the custom layer "${manifest.custom?.name ?? manifest.name}"?${also} Undo brings it back.`)) return;
        remove.disabled = true;
        // Children first: a slide goes before the button it is part of would.
        for (const use of uses) await host.send('scene.remove', { layer: use.id });
        if (await host.send('custom.remove', { id })) gone.add(manifest.id);
        draw();
      });
      card.append(badge, text, remove);
      list.append(card);
    }
  };
  draw();
  dialog.append(head, el('p', 'wz-lead', 'A custom layer is saved with the table even when no button uses it. Delete the ones you no longer need.'), list);
  dialog.addEventListener('close', () => dialog.remove());
  shell.append(dialog);
  dialog.showModal();
}

// ---- The builder ------------------------------------------------------------------

type Tab = 'data' | 'look' | 'motion' | 'interaction' | 'button';
/** The tab last open per custom layer, so a re-render keeps the author where they were; a new layer opens on Look. */
const lastTabs = new Map<string, Tab>();

/**
 * The builder for one custom layer, shown in the inspector: tabs for its data, look,
 * motion and interaction, and its button on the controller (`buttonSection`).
 */
export function builderSection(host: BuilderHost, manifest: LayerManifest, buttonSection: HTMLElement): HTMLElement {
  const id = manifest.id;
  const recipe: CustomLayer = structuredClone(manifest.custom ?? { name: manifest.name });
  recipe.look ??= [];
  recipe.motion ??= [];
  recipe.data ??= [];
  const palette = () => resolvePalette(host.store.state.site.palette);

  // Saves at most every 120 ms while a slider is dragged; the table restyles as each lands.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  let again = false;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 120);
  };
  const flush = async () => {
    timer = null;
    if (saving) {
      again = true;
      return;
    }
    saving = true;
    await updateLegend();
    await host.send('custom.save', { id, recipe });
    saving = false;
    if (again) {
      again = false;
      void flush();
    }
  };

  const shapes = async (block: RecipeBlock): Promise<Shapes | null> => {
    const data = recipe.data!.find((d) => d.id === block.data);
    const url = data && dataUrl(data, host.store.state.site);
    return url ? shapesOf(host.store, url).catch(() => null) : null;
  };

  // The legend follows the looks (S2): every colour on the table has its swatch on the controller.
  const legendBox = el('div', 'lb-legend');
  const updateLegend = async () => {
    const looks = [];
    for (const block of recipe.look!) {
      const s = await shapes(block);
      const look = s && compileLook(block, s, palette(), 1);
      if (look) looks.push(look);
    }
    recipe.legend = recipeLegend(looks).slice(0, 12);
    if (recipe.legend.length === 0) delete recipe.legend;
    drawLegend();
  };
  const drawLegend = () => {
    const rows = (recipe.legend ?? []).map((item) => {
      const row = el('div', 'lb-legend-row');
      const sw = el('span', `lb-legend-swatch is-${item.shape ?? 'fill'}`);
      sw.style.setProperty('--c', item.color ?? '#999');
      row.append(sw, el('span', undefined, item.label));
      return row;
    });
    legendBox.replaceChildren(...(rows.length ? rows : [el('p', 'ed-empty', 'A single colour has no legend rows. Colour by a column to get one, or give the look a legend name.')]));
  };

  const section = el('section', 'ed-section lb');
  const tabs = el('div', 'lb-tabs');
  tabs.setAttribute('role', 'tablist');
  const body = el('div', 'lb-body');
  const TABS: [Tab, string, string][] = [
    ['data', 'Data', 'layers'],
    ['look', 'Look', 'brush'],
    ['motion', 'Motion', 'sparkle'],
    ['interaction', 'Interaction', 'pointer'],
    ['button', 'Button', 'tv'],
  ];
  const show = (tab: Tab) => {
    lastTabs.set(id, tab);
    for (const b of tabs.children) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === tab));
    body.replaceChildren(...(tab === 'data' ? dataTab() : tab === 'look' ? lookTab() : tab === 'motion' ? motionTab() : tab === 'interaction' ? interactionTab() : [buttonSection]));
  };
  for (const [tab, label, iconName] of TABS) {
    const b = button('lb-tab', label, iconName);
    b.dataset.tab = tab;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => show(tab));
    tabs.append(b);
  }

  // -- Data
  const dataTab = (): HTMLElement[] => {
    const nodes: HTMLElement[] = [el('p', 'lb-lead', 'What this layer shows. Each dataset gets its own look.')];
    const datasets = vectorDatasets(host.store);
    for (const data of recipe.data!) {
      const select = el('select');
      for (const { name } of datasets) select.append(Object.assign(el('option'), { value: name, textContent: name, selected: name === data.dataset }));
      if (data.path) select.append(Object.assign(el('option'), { value: '', textContent: data.path, selected: true }));
      const detail = el('span', 'lb-detail');
      const describe = () => {
        const url = dataUrl(data, host.store.state.site);
        if (url) void shapesOf(host.store, url).then((s) => (detail.textContent = describeShapes(s)), () => (detail.textContent = 'Could not be read'));
      };
      describe();
      select.addEventListener('change', () => {
        if (!select.value) return;
        data.dataset = select.value;
        delete data.path;
        describe();
        save();
      });
      nodes.push(field('Dataset', select, detail));
    }
    const add = button('action', 'Show another dataset', 'plus');
    add.disabled = datasets.length === 0;
    add.addEventListener('click', async () => {
      const used = new Set(recipe.data!.map((d) => d.dataset));
      const next = datasets.find((d) => !used.has(d.name)) ?? datasets[0]!;
      let n = recipe.data!.length + 1;
      while (recipe.data!.some((d) => d.id === `data-${n}`)) n++;
      const dataId = `data-${n}`;
      recipe.data!.push({ id: dataId, dataset: next.name });
      const kind = lookFor(await shapesOf(host.store, `/site/${next.path}`).catch(() => ({ areas: [], paths: [], spots: [] }) as Shapes));
      recipe.look!.push({ id: `look-${n}`, block: kind, data: dataId, props: { ...LOOK_DEFAULTS[kind], ...PRESETS[kind][0]!.props } });
      save();
      show('data');
    });
    const bring = button('action', 'Bring in a file…');
    bring.addEventListener('click', () => host.addData());
    const enter = segmented([['fade', 'Fade in'], ['cut', 'Appear']] as const, recipe.enter === 'cut' ? 'cut' : 'fade', (value) => {
      recipe.enter = value;
      save();
    }, 'How it comes on');
    nodes.push(el('div', 'lb-actions'));
    nodes[nodes.length - 1]!.append(add, bring);
    nodes.push(el('h4', undefined, 'Coming onto the table'), field('Enter', enter));
    return nodes;
  };

  // -- Look
  const lookTab = (): HTMLElement[] => {
    const nodes: HTMLElement[] = [];
    if (recipe.look!.length === 0) nodes.push(el('p', 'ed-empty', 'No data yet. Choose a dataset under Data.'));
    for (const block of recipe.look!) nodes.push(lookCard(block));
    nodes.push(el('h4', undefined, 'Legend on the controller'), legendBox);
    drawLegend();
    return nodes;
  };

  const lookCard = (block: RecipeBlock): HTMLElement => {
    const card = el('div', 'lb-card');
    const props = (block.props ??= {});
    const data = recipe.data!.find((d) => d.id === block.data);
    const head = el('header', 'lb-card-head');
    head.append(icon(KIND_ICON[block.block as GeometryKind] ?? 'layers', 16), el('strong', undefined, data?.dataset ?? data?.path ?? block.id));
    const kindRow = el('div', 'lb-kinds');
    const content = el('div', 'lb-card-body');
    card.append(head, kindRow, content);
    void shapes(block).then((s) => {
      // L1: only the looks the data has geometry for.
      const kinds: GeometryKind[] = s ? (['points', 'lines', 'fill'] as const).filter((k) => (k === 'points' ? s.spots : k === 'lines' ? s.paths : s.areas).length > 0) : [block.block as GeometryKind];
      if (kinds.length > 1) {
        kindRow.append(
          segmented(kinds.map((k) => [k, KIND_LABEL[k]] as const), block.block as GeometryKind, (k) => {
            block.block = k;
            block.props = { ...LOOK_DEFAULTS[k], ...PRESETS[k][0]!.props };
            recipe.motion = recipe.motion!.filter((m) => m.on !== block.id);
            save();
            show('look');
          }, 'Draw as'),
        );
      }
      const rows = s ? (block.block === 'points' ? s.spots : block.block === 'lines' ? s.paths : s.areas).map((x) => x.properties) : [];
      content.replaceChildren(...lookFields(block, props, profileColumns(rows), rows));
    });
    return card;
  };

  const lookFields = (block: RecipeBlock, props: Record<string, any>, columns: { name: string; kind: 'number' | 'category' }[], rows: readonly Record<string, unknown>[] = []): HTMLElement[] => {
    const kind = block.block as GeometryKind;
    const set = (key: string, value: unknown) => {
      props[key] = value;
      save();
    };
    const nodes: HTMLElement[] = [];
    const presets = el('div', 'lb-presets');
    for (const preset of PRESETS[kind]) {
      const b = button('lb-preset', preset.name);
      b.addEventListener('click', () => {
        block.props = { ...LOOK_DEFAULTS[kind], ...preset.props };
        recipe.motion = recipe.motion!.filter((m) => m.on !== block.id);
        if (preset.motion) recipe.motion!.push({ id: `${block.id}-${preset.motion.block}`, block: preset.motion.block, on: block.id, props: { ...preset.motion.props } });
        save();
        show('look');
      });
      presets.append(b);
    }
    nodes.push(presets);
    nodes.push(paintField('Colour', props.color as Paint, (paint) => set('color', paint), columns, rows));
    if (kind === 'points') {
      // The mark (#95): a plain shape, or a pictogram on a dark disc.
      const iconRow = el('div', 'lb-sub');
      const drawIcons = () => {
        iconRow.hidden = props.shape !== 'icon';
        iconRow.replaceChildren(field('Pictogram', swatches(Object.entries(ICONS).map(([name, i]) => ({ value: name, title: i.label, svg: `<path d="${i.path}" fill-rule="evenodd"/>` })), props.icon ?? 'star', (v) => set('icon', v), 'Pictogram')));
      };
      drawIcons();
      nodes.push(field('Mark', swatches(POINT_SHAPES.map((name) => ({ value: name, title: SHAPE_LABEL[name]!, svg: SHAPE_SVG[name]! })), props.shape ?? 'circle', (v) => {
        set('shape', v);
        drawIcons();
      }, 'Mark')), iconRow);
      nodes.push(sizeField('Radius', props.radius_mm as Size, 1, 12, 0.5, (v) => set('radius_mm', v), columns));
      nodes.push(field('Glow', slider(props.glow ?? 0, 0, 1, 0.05, '', (v) => set('glow', v))));
      nodes.push(field('White centre', toggle(Boolean(props.core), (v) => set('core', v), 'White centre')));
      nodes.push(field('Outline', colourPicker(props.stroke ?? null, palette, (v) => set('stroke', v), { allowNone: true, label: 'Outline colour' })));
      const label = el('select');
      label.append(Object.assign(el('option'), { value: '', textContent: 'None' }));
      for (const c of columns) label.append(Object.assign(el('option'), { value: c.name, textContent: c.name, selected: c.name === props.label }));
      label.addEventListener('change', () => set('label', label.value || null));
      nodes.push(field('Place name', label), el('p', 'lb-hint', 'Only for place names, a few words each: the map stays almost free of text.'));
    } else if (kind === 'lines') {
      nodes.push(sizeField('Width', props.width_mm as Size, 0.5, 8, 0.25, (v) => set('width_mm', v), columns));
      nodes.push(field('Glow', slider(props.glow ?? 0, 0, 1, 0.05, '', (v) => set('glow', v))));
      nodes.push(field('Dark casing', toggle(Boolean(props.casing), (v) => set('casing', v), 'Dark casing')));
      const dashDetail = el('div', 'lb-sub');
      const drawDash = () => {
        dashDetail.hidden = props.dash !== 'dashed';
        dashDetail.replaceChildren(field('Dash', slider(props.dash_mm ?? 6, 1, 20, 0.5, ' mm', (v) => set('dash_mm', v))), field('Gap', slider(props.gap_mm ?? 4, 1, 20, 0.5, ' mm', (v) => set('gap_mm', v))));
      };
      drawDash();
      nodes.push(field('Line', segmented([['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']] as const, props.dash ?? 'solid', (v) => {
        set('dash', v);
        drawDash();
      }, 'Line')), dashDetail);
      // Arrows (#95): which way a route or a flow goes, without a word on the map.
      const arrowDetail = el('div', 'lb-sub');
      const drawArrows = () => {
        arrowDetail.hidden = (props.arrows ?? 'none') === 'none';
        const rows = [field('Arrow size', slider(props.arrow_mm ?? 4, 2, 12, 0.5, ' mm', (v) => set('arrow_mm', v)))];
        if (props.arrows === 'along') rows.push(field('Every', slider(props.arrow_gap_mm ?? 40, 10, 200, 5, ' mm', (v) => set('arrow_gap_mm', v))));
        arrowDetail.replaceChildren(...rows);
      };
      drawArrows();
      nodes.push(field('Arrows', segmented([['none', 'None'], ['end', 'At the end'], ['along', 'Along']] as const, props.arrows ?? 'none', (v) => {
        set('arrows', v);
        drawArrows();
      }, 'Arrows')), arrowDetail);
    } else {
      nodes.push(field('Fill', segmented([['flat', 'Flat'], ['hatch', 'Hatched']] as const, props.hatch ? 'hatch' : 'flat', (v) => set('hatch', v === 'hatch'), 'Fill')));
      nodes.push(field('Outline', colourPicker(props.stroke ?? null, palette, (v) => set('stroke', v), { allowNone: true, label: 'Outline colour' })));
      nodes.push(field('Outline width', slider(props.stroke_mm ?? 0.6, 0, 3, 0.1, ' mm', (v) => set('stroke_mm', v))));
      nodes.push(field('Edge glow', slider(props.edge_glow ?? 0, 0, 1, 0.05, '', (v) => set('edge_glow', v))));
      nodes.push(field('Shadow', slider(props.shadow_mm ?? 0, 0, 8, 0.5, ' mm', (v) => set('shadow_mm', v))));
      nodes.push(el('p', 'lb-hint', 'The table is seen from above, so areas are never raised: a shadow or a brighter colour lifts them instead.'));
    }
    nodes.push(field('Opacity', slider(props.opacity ?? 1, 0.05, 1, 0.05, '', (v) => set('opacity', v))));
    const legend = el('input');
    Object.assign(legend, { type: 'text', maxLength: 40, value: typeof props.legend === 'string' ? props.legend : '', placeholder: 'For example: Cool routes' });
    legend.addEventListener('change', () => set('legend', legend.value.trim() || undefined));
    nodes.push(field('Legend name', legend));
    return nodes;
  };

  /** Colour: fixed, or by a column (#94: a category per value, or a ramp in classes). */
  const paintField = (label: string, paint: Paint, onChange: (paint: Paint) => void, columns: { name: string; kind: 'number' | 'category' }[], data: readonly Record<string, unknown>[] = []): HTMLElement => {
    const wrap = el('div', 'lb-group');
    const detail = el('div', 'lb-sub');
    let current: Paint = paint ?? '@accent';
    const draw = () => {
      if (typeof current === 'string') {
        detail.replaceChildren(field(label, colourPicker(current, palette, (v) => {
          current = v ?? '@accent';
          onChange(current);
        })));
        return;
      }
      const by = current;
      const column = el('select');
      for (const c of columns) column.append(Object.assign(el('option'), { value: c.name, textContent: `${c.name} (${c.kind === 'number' ? 'number' : 'category'})`, selected: c.name === by.by }));
      column.addEventListener('change', () => {
        const c = columns.find((x) => x.name === column.value)!;
        current = c.kind === 'number' ? { by: c.name, kind: 'number', ramp: 'sun', classes: 'continuous' } : { by: c.name, kind: 'category' };
        onChange(current);
        draw();
      });
      const fields: HTMLElement[] = [field('Based on', column)];
      if (by.kind === 'number') {
        const ramps = el('div', 'lb-ramps');
        for (const [name, colours] of Object.entries(palette().ramps)) {
          const b = el('button', 'lb-ramp');
          b.type = 'button';
          b.title = name;
          b.ariaLabel = `Ramp ${name}`;
          b.style.background = `linear-gradient(to right, ${colours.join(', ')})`;
          b.setAttribute('aria-pressed', String((by.ramp ?? 'sun') === name));
          b.addEventListener('click', () => {
            by.ramp = name;
            onChange(by);
            draw();
          });
          ramps.append(b);
        }
        fields.push(field('Ramp', ramps));
        fields.push(field('Classes', segmented([['continuous', 'Smooth'], ['equal', 'Equal'], ['quantile', 'Quantile'], ['natural', 'Natural']] as const, by.classes ?? 'continuous', (v) => {
          by.classes = v;
          onChange(by);
          draw();
        }, 'Classes')));
        if (by.classes && by.classes !== 'continuous') fields.push(field('How many', slider(by.count ?? 5, 2, 7, 1, '', (v) => {
          by.count = v;
          onChange(by);
        })));
      } else {
        // Category colours (#207): a scheme of the data's own (energy classes A to G), the table
        // palette, or a colour picked per value. Picked colours beat both.
        const found = columnCategories(data, by.by);
        const own = schemeFor(found);
        const scheme = el('select');
        scheme.ariaLabel = 'Category colours';
        const options: [string, string][] = [['auto', own ? `Their own: ${own.label.replace(/ \(.*\)$/, '').toLowerCase()}` : 'Their own, when they have them'], ['palette', 'The table palette'], ...CATEGORY_SCHEMES.map((c) => [c.id, c.label] as [string, string])];
        for (const [value, text] of options) scheme.append(Object.assign(el('option'), { value, textContent: text, selected: (by.scheme ?? 'auto') === value }));
        scheme.addEventListener('change', () => {
          by.scheme = scheme.value === 'auto' ? undefined : scheme.value;
          if (by.scheme === undefined) delete by.scheme;
          onChange(by);
          draw();
        });
        fields.push(field('Colours', scheme));
        const legend = paintScale(by, data, palette()).legend;
        const list = el('div', 'lb-cats');
        for (const entry of legend) {
          const row = el('div', 'lb-cat');
          row.append(el('span', 'lb-cat-name', entry.label), colourPicker(by.colors?.[entry.label] ?? entry.color, palette, (v) => {
            by.colors = { ...(by.colors ?? {}) };
            if (v) by.colors[entry.label] = v;
            else delete by.colors[entry.label];
            if (Object.keys(by.colors).length === 0) delete by.colors;
            onChange(by);
            draw();
          }, { label: `Colour for ${entry.label}` }));
          list.append(row);
        }
        if (legend.length) fields.push(list);
        if (by.colors && Object.keys(by.colors).length) {
          const reset = button('lb-link', 'Use the scheme colours again');
          reset.addEventListener('click', () => {
            delete by.colors;
            onChange(by);
            draw();
          });
          fields.push(reset);
        }
        fields.push(el('p', 'lb-hint', own ? `These values are ${own.label.replace(/ \(.*\)$/, '').toLowerCase()}, so they keep their standard colours and order. Click a colour to change it.` : 'Each value takes the next category colour of the palette. More than six are grouped as Others. Click a colour to change it.'));
      }
      detail.replaceChildren(...fields);
    };
    const mode = segmented([['fixed', 'One colour'], ['data', 'By data']] as const, typeof current === 'string' ? 'fixed' : 'data', (v) => {
      if (v === 'fixed') current = '@accent';
      else {
        const c = columns.find((x) => x.kind === 'category') ?? columns[0];
        if (!c) return;
        current = c.kind === 'number' ? { by: c.name, kind: 'number', ramp: 'sun', classes: 'continuous' } : { by: c.name, kind: 'category' };
      }
      onChange(current);
      draw();
    }, `${label} from`);
    if (columns.length === 0) mode.querySelectorAll('button')[1]?.setAttribute('disabled', '');
    draw();
    wrap.append(field(`${label} from`, mode), detail);
    return wrap;
  };

  /** A size in table mm: fixed, or spread by a numeric column. */
  const sizeField = (label: string, size: Size, min: number, max: number, step: number, onChange: (size: Size) => void, columns: { name: string; kind: string }[]): HTMLElement => {
    const numbers = columns.filter((c) => c.kind === 'number');
    const wrap = el('div', 'lb-group');
    const detail = el('div', 'lb-sub');
    let current: Size = size ?? min * 4;
    const draw = () => {
      if (typeof current === 'number') {
        detail.replaceChildren(field(label, slider(current, min, max, step, ' mm', (v) => {
          current = v;
          onChange(v);
        })));
        return;
      }
      const by = current;
      const column = el('select');
      for (const c of numbers) column.append(Object.assign(el('option'), { value: c.name, textContent: c.name, selected: c.name === by.by }));
      column.addEventListener('change', () => {
        by.by = column.value;
        onChange(by);
      });
      detail.replaceChildren(
        field('Based on', column),
        field('Smallest', slider(by.range[0], min, max, step, ' mm', (v) => {
          by.range = [v, by.range[1]];
          onChange(by);
        })),
        field('Largest', slider(by.range[1], min, max, step, ' mm', (v) => {
          by.range = [by.range[0], v];
          onChange(by);
        })),
      );
    };
    const mode = segmented([['fixed', 'Fixed'], ['data', 'By data']] as const, typeof current === 'number' ? 'fixed' : 'data', (v) => {
      current = v === 'fixed' ? min * 4 : { by: numbers[0]!.name, range: [min * 2, Math.min(max, min * 8)] };
      onChange(current);
      draw();
    }, `${label} from`);
    if (numbers.length === 0) mode.querySelectorAll('button')[1]?.setAttribute('disabled', '');
    draw();
    wrap.append(field(`${label} from`, mode), detail);
    return wrap;
  };

  // -- Motion
  const MOTION_LABEL: Record<string, [string, string]> = {
    pulse: ['Pulse', 'Rings travel out from each point, or an outline swells and fades. Slow, never a blink.'],
    'draw-in': ['Draw in', 'Lines draw themselves in when the layer opens, one after another, with a bright tip.'],
    flow: ['Flow', 'Dashes travel along each line, in the direction it was drawn.'],
    particles: ['Particles', 'Lights travel along every line: traffic, flows, energy on its way.'],
    attract: ['Attract a crowd', 'Particles gather from all around and are pulled into each point. For pull and attention, not for people.'],
    gravity: ['Crowd on the streets', 'People walk to each point along the street network, more to the places that pull harder.'],
    timeline: ['Through time', 'Plays the layer through a date or year column: each feature appears when its time comes, with a brief flare.'],
    sound: ['Sound', 'Points with a sound file (WAV, MP3, OGG) send out rings as they sound, like the bird-sounds demo. The table plays the sound.'],
    place: ['Place motion', 'Twenty-two ways to bring places alive, from ripples and orbiters to gravity wells that bend the streets. Pick one, then tune it.'],
  };
  /** The rows of a sound motion (#150): where the sounds come from, how they play and the rings. */
  const soundRows = (look: RecipeBlock, p: Record<string, any>, set: (key: string, value: unknown) => void, redraw: () => void): HTMLElement[] => {
    const rows: HTMLElement[] = [];
    const source = el('select');
    source.setAttribute('aria-label', 'Sound from');
    const file = el('select');
    file.setAttribute('aria-label', 'Sound file');
    const status = el('p', 'lb-hint');
    const fileRow = field('Sound', file);
    const showFile = () => (fileRow.style.display = p.column ? 'none' : '');
    showFile();
    let rowsOf: Record<string, unknown>[] = [];
    const describe = (sounds: string[]) => {
      const have = new Set(sounds);
      const wanted = rowsOf.map((r) => soundPath(r, { column: p.column ?? null, file: p.file ?? null }));
      const named = wanted.filter(Boolean).length;
      const found = wanted.filter((w) => w && have.has(w)).length;
      status.textContent = named === 0 ? 'No point names a sound yet.' : found === named ? `${found} of ${rowsOf.length} points have a sound.` : `${named - found} of ${named} sounds are not in this table yet. Add them with "Add sounds".`;
    };
    const fill = async () => {
      const sounds = ((await fetch('/api/data/sounds').then((r) => r.json()).catch(() => ({ sounds: [] }))) as { sounds: string[] }).sounds ?? [];
      file.replaceChildren(...sounds.map((path) => Object.assign(el('option'), { value: path.replace(/^data\/sounds\//, ''), textContent: path.replace(/^data\/sounds\//, ''), selected: path.endsWith(`/${p.file}`) })));
      if (!p.column && !p.file && sounds[0]) set('file', sounds[0].replace(/^data\/sounds\//, ''));
      describe(sounds);
    };
    void shapes(look).then((s) => {
      rowsOf = (s?.spots ?? []).map((x) => (x.properties ?? {}) as Record<string, unknown>);
      const columns = soundColumns(rowsOf);
      if (p.column === undefined) p.column = columns[0] ?? null;
      source.replaceChildren(
        ...columns.map((c) => Object.assign(el('option'), { value: c, textContent: `Column: ${c}`, selected: c === p.column })),
        Object.assign(el('option'), { value: '', textContent: 'One sound for every point', selected: !p.column }),
      );
      showFile();
      void fill();
    });
    source.addEventListener('change', () => {
      set('column', source.value || null);
      showFile();
      void fill();
    });
    file.addEventListener('change', () => set('file', file.value || null));
    const add = button('action', 'Add sounds', 'plus');
    add.title = 'WAV, MP3, OGG or M4A files, kept in this table as they are';
    const picker = Object.assign(el('input'), { type: 'file', multiple: true, accept: 'audio/*,.wav,.mp3,.ogg,.m4a', hidden: true });
    add.addEventListener('click', () => picker.click());
    picker.addEventListener('change', async () => {
      for (const f of picker.files ?? []) {
        const response = await fetch(`/api/data/sounds?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
        if (!response.ok) status.textContent = `${f.name}: ${((await response.json().catch(() => ({}))) as { error?: string }).error ?? response.status}`;
      }
      picker.value = '';
      await fill();
      // The table loads the new files on its next restyle.
      set('column', p.column ?? null);
    });
    rows.push(field('Sound from', source), fileRow, field('', add, picker), status);
    rows.push(field('Plays', segmented([['chorus', 'A few at a time'], ['loop', 'All, looping'], ['tap', 'When tapped']] as const, p.trigger === 'loop' || p.trigger === 'tap' ? p.trigger : 'chorus', (v) => {
      set('trigger', v);
      redraw();
    }, 'Plays')));
    if (p.trigger !== 'loop' && p.trigger !== 'tap') {
      rows.push(field('At once', slider(p.voices ?? 3, 1, 8, 1, '', (v) => set('voices', v))));
      rows.push(field('Quiet between', slider(p.gap_s ?? 1.5, 0, 10, 0.5, ' s', (v) => set('gap_s', v))));
    }
    rows.push(field('Volume', slider(Math.round((p.volume ?? 0.8) * 100), 0, 100, 5, ' %', (v) => set('volume', v / 100))));
    rows.push(field('Ring reach', slider(p.reach_mm ?? 45, 10, 150, 5, ' mm', (v) => set('reach_mm', v))));
    rows.push(field('Ring width', slider(p.width_mm ?? 2, 0.4, 5, 0.1, ' mm', (v) => set('width_mm', v))));
    rows.push(field('Rings on', segmented([['0.2', 'Strong calls'], ['0.5', 'Calls'], ['0.85', 'Every note']] as const, (p.sensitivity ?? 0.5) < 0.35 ? '0.2' : (p.sensitivity ?? 0.5) > 0.7 ? '0.85' : '0.5', (v) => set('sensitivity', Number(v)), 'Rings on')));
    let listening = false;
    try {
      listening = localStorage.getItem(LISTEN_KEY) === '1';
    } catch {
      // No storage: the editor stays quiet.
    }
    rows.push(field('Listen here', toggle(listening, (on) => {
      try {
        localStorage.setItem(LISTEN_KEY, on ? '1' : '0');
      } catch {
        // Nothing to remember it in.
      }
    }, 'Listen here')), el('p', 'lb-hint', 'The table plays the sounds. Turn this on to hear them in the editor too; the first click on the page lets the browser play sound.'));
    return rows;
  };

  /** The rows of a place motion (#160-163): which motion, its files, ? help and its knobs. */
  const placeRows = (p: Record<string, any>, set: (key: string, value: unknown) => void, redraw: () => void, dataset?: string): HTMLElement[] => {
    const rows: HTMLElement[] = [];
    const def = placeMotion(p.motion) ?? PLACE_MOTIONS[0]!;
    const pick = el('select');
    pick.setAttribute('aria-label', 'Place motion');
    for (const group of [...new Set(PLACE_MOTIONS.map((m) => m.group))]) {
      const og = Object.assign(el('optgroup'), { label: group });
      for (const m of PLACE_MOTIONS.filter((m) => m.group === group)) og.append(Object.assign(el('option'), { value: m.id, textContent: m.label, selected: m.id === def.id }));
      pick.append(og);
    }
    pick.addEventListener('change', () => {
      // A new motion starts from its own defaults; the shared speed and glow carry over.
      for (const knob of def.knobs) delete p[knob.key];
      set('motion', pick.value);
      redraw();
    });
    const help = button('lb-help-btn', '', 'info');
    help.title = 'How to set up the data for this motion';
    help.setAttribute('aria-label', help.title);
    const panel = el('div', 'lb-place-help');
    panel.hidden = true;
    help.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      help.classList.toggle('on', !panel.hidden);
    });
    const kind = PLACE_DATA_HELP[def.data];
    panel.append(
      el('strong', undefined, kind.file),
      el('p', undefined, kind.what),
      el('pre', undefined, kind.example),
      el('p', undefined, `Columns it reads: ${def.columns.join(', ')}.`),
      ...(def.extra ? [el('p', undefined, def.extra)] : []),
    );
    rows.push(field('Motion', pick, help), el('p', 'lb-hint', def.about), panel);

    // Its other files.
    const datasets = vectorDatasets(host.store);
    const choose = (label: string, key: string, list: { name: string }[], none: string | null, preferred: string[]) => {
      const select = el('select');
      if (none) select.append(Object.assign(el('option'), { value: '', textContent: none }));
      if (p[key] === undefined || (p[key] && !list.some((d) => d.name === p[key]))) p[key] = preferred.find((n) => list.some((d) => d.name === n)) ?? (none ? null : list[0]?.name ?? null);
      for (const d of list) select.append(Object.assign(el('option'), { value: d.name, textContent: d.name, selected: d.name === p[key] }));
      select.addEventListener('change', () => set(key, select.value || null));
      rows.push(field(label, select));
    };
    const csvs = datasets.filter((d) => /\.csv$/i.test(d.path));
    // Tables named after the places come first: test places bring `test-places-activity` and the like (#308).
    const own = (table: string) => (dataset ? [`${dataset}-${table}`, `${dataset}_${table}`] : []);
    if (def.uses?.includes('streets')) choose('Streets', 'streets', datasets, null, ['roads', 'walkways', 'streets']);
    if (def.uses?.includes('buildings')) choose('Buildings', 'buildings', datasets, null, ['buildings', 'buildings_2d']);
    if (def.data === 'targets' || def.data === 'raster' || def.data === 'links') choose(def.data === 'links' ? 'Stars' : 'Targets', 'targets', datasets, 'None', []);
    if (def.data === 'activity' || def.data === 'audio') choose('Activity', 'activity', csvs, 'Ambient (no file)', [...own('activity'), 'activity']);
    if (def.data === 'activity' && p.activity) rows.push(field('Plays through in', slider(p.cycle_s ?? 24, 6, 120, 1, ' s', (v) => set('cycle_s', v))));
    if (def.data === 'flows') choose('Flows', 'flows', csvs, 'Made up from weights', [...own('flows'), 'flows']);
    if (def.data === 'links') choose('Links', 'links', csvs, 'By category', [...own('links'), 'links']);
    rows.push(field('Colours', segmented([['each', 'One each'], ['category', 'By category']] as const, p.colours === 'category' ? 'category' : 'each', (v) => set('colours', v), 'Colours')));

    // Knobs: the shared speed and glow, then the motion's own.
    for (const knob of [...SHARED_KNOBS, ...def.knobs]) rows.push(field(knob.label, slider(p[knob.key] ?? knob.value, knob.min, knob.max, knob.step, knob.unit ?? '', (v) => set(knob.key, v))));
    return rows;
  };

  const motionTab = (): HTMLElement[] => {
    const nodes: HTMLElement[] = [el('p', 'lb-lead', 'Motion is the strongest thing on the table: keep one kind in focus, and make any second one quieter.')];
    for (const look of recipe.look!) {
      const card = el('div', 'lb-card');
      const data = recipe.data!.find((d) => d.id === look.data);
      const head = el('header', 'lb-card-head');
      head.append(icon(KIND_ICON[look.block as GeometryKind] ?? 'layers', 16), el('strong', undefined, `${KIND_LABEL[look.block as GeometryKind] ?? look.block} · ${data?.dataset ?? look.id}`));
      card.append(head);
      for (const name of MOTIONS_FOR[look.block as GeometryKind] ?? []) {
        const existing = recipe.motion!.find((m) => m.on === look.id && m.block === name);
        const [title, about] = MOTION_LABEL[name]!;
        const sub = el('div', 'lb-sub');
        const draw = () => {
          const motion = recipe.motion!.find((m) => m.on === look.id && m.block === name);
          sub.hidden = !motion;
          if (!motion) return sub.replaceChildren();
          const p = (motion.props ??= {}) as Record<string, any>;
          const set = (key: string, value: unknown) => {
            p[key] = value;
            save();
          };
          const rows: HTMLElement[] = [];
          if (name === 'pulse') {
            rows.push(field('Every', slider(p.period_s ?? 2, 1, 4, 0.1, ' s', (v) => set('period_s', v))));
            rows.push(field('Reach', slider(p.size_mm ?? 14, 4, 40, 1, ' mm', (v) => set('size_mm', v))));
            if (look.block === 'points') rows.push(field('Rings', slider(p.rings ?? 2, 1, 4, 1, '', (v) => set('rings', v))));
            rows.push(field('Direction', segmented([['out', 'Outward'], ['in', 'Inward']] as const, (p.direction ?? 1) > 0 ? 'out' : 'in', (v) => set('direction', v === 'out' ? 1 : -1), 'Direction')));
          } else if (name === 'draw-in') {
            rows.push(field('Takes', slider(p.duration_s ?? 1.2, 0.6, 8, 0.1, ' s', (v) => set('duration_s', v))));
            rows.push(field('One by one', toggle(p.stagger ?? true, (v) => set('stagger', v), 'One by one')));
          } else if (name === 'flow') {
            rows.push(field('Speed', slider(p.speed_mm ?? 12, 2, 60, 1, ' mm/s', (v) => set('speed_mm', v))));
          } else if (name === 'particles') {
            rows.push(field('Per line', slider(p.per_line ?? 2, 1, 8, 1, '', (v) => set('per_line', v))));
            rows.push(field('Speed', slider(p.speed_mm ?? 20, 2, 80, 1, ' mm/s', (v) => set('speed_mm', v))));
            rows.push(field('Size', slider(p.size_mm ?? 2.5, 0.5, 6, 0.1, ' mm', (v) => set('size_mm', v))));
          } else if (name === 'attract' || name === 'gravity') {
            if (name === 'gravity') {
              // The streets the crowd walks on: a dataset of lines.
              const streets = el('select');
              const lines = vectorDatasets(host.store);
              const preferred = ['roads', 'walkways', 'streets'].find((n) => lines.some((d) => d.name === n));
              if (!p.network || !lines.some((d) => d.name === p.network)) p.network = preferred ?? lines[0]?.name ?? 'roads';
              for (const d of lines) streets.append(Object.assign(el('option'), { value: d.name, textContent: d.name, selected: d.name === p.network }));
              streets.addEventListener('change', () => set('network', streets.value));
              rows.push(field('Streets', streets));
            }
            rows.push(field('How many', slider(p.count ?? 240, 20, 1000, 10, '', (v) => set('count', v))));
            rows.push(field('Speed', slider(p.speed_mm ?? 10, 2, 50, 1, ' mm/s', (v) => set('speed_mm', v))));
            if (name === 'attract') rows.push(field('From', slider(p.reach_mm ?? 60, 10, 200, 5, ' mm', (v) => set('reach_mm', v))));
            rows.push(field('Size', slider(p.size_mm ?? 2, 0.5, 5, 0.1, ' mm', (v) => set('size_mm', v))));
            if (name === 'gravity') rows.push(field('Trail', toggle(p.trail ?? true, (v) => set('trail', v), 'Trail')));
            // Pull by a column: places with more of it draw more of the crowd.
            const weight = el('select');
            weight.append(Object.assign(el('option'), { value: '', textContent: 'All alike' }));
            void shapes(look).then((s) => {
              for (const c of profileColumns((s?.spots ?? []).map((x) => x.properties)).filter((c) => c.kind === 'number')) weight.append(Object.assign(el('option'), { value: c.name, textContent: c.name, selected: c.name === p.weight }));
            });
            weight.addEventListener('change', () => set('weight', weight.value || null));
            rows.push(field('Pull by', weight));
          } else if (name === 'timeline') {
            const column = el('select');
            void shapes(look).then((s) => {
              const features = look.block === 'points' ? s?.spots : look.block === 'lines' ? s?.paths : s?.areas;
              const found = timeColumns((features ?? []).map((f) => f.properties ?? {}));
              if (found.length === 0) column.append(Object.assign(el('option'), { value: '', textContent: 'No date or year column' }));
              if (!p.column && found[0]) set('column', found[0]);
              for (const c of found) column.append(Object.assign(el('option'), { value: c, textContent: c, selected: c === p.column }));
            });
            column.addEventListener('change', () => set('column', column.value || null));
            rows.push(field('Time from', column));
            rows.push(field('Takes', slider(p.duration_s ?? 12, 4, 60, 1, ' s', (v) => set('duration_s', v))));
            rows.push(field('Hold at the end', slider(p.hold_s ?? 3, 0, 15, 0.5, ' s', (v) => set('hold_s', v))));
            const windowRow = el('div', 'lb-sub');
            const drawWindow = () => {
              windowRow.hidden = p.keep ?? true;
              windowRow.replaceChildren(field('Stays for', slider(Math.round((p.window ?? 0.15) * 100), 2, 50, 1, ' %', (v) => set('window', v / 100))));
            };
            drawWindow();
            rows.push(field('Features', segmented([['keep', 'Stay'], ['window', 'Come and go']] as const, (p.keep ?? true) ? 'keep' : 'window', (v) => {
              set('keep', v === 'keep');
              drawWindow();
            }, 'Features')), windowRow);
            rows.push(el('p', 'lb-hint', 'No date is written on the map. Showing the current date on the controller comes with the controller legend (#76).'));
          } else if (name === 'sound') {
            rows.push(...soundRows(look, p, set, () => draw()));
          } else if (name === 'place') {
            rows.push(...placeRows(p, set, () => draw(), data?.dataset));
          }
          sub.replaceChildren(...rows);
        };
        const on = toggle(Boolean(existing), (checked) => {
          recipe.motion = recipe.motion!.filter((m) => !(m.on === look.id && m.block === name));
          if (checked) recipe.motion!.push({ id: `${look.id}-${name}`, block: name, on: look.id, props: name === 'place' ? { motion: 'ripples' } : name === 'sound' ? { trigger: 'chorus' } : { ...(MOTION_DEFAULTS as Record<string, object>)[name] } });
          save();
          draw();
        }, title);
        const row = el('div', 'lb-motion');
        const text = el('div', 'lb-motion-text');
        text.append(el('strong', undefined, title), el('span', undefined, about));
        row.append(text, on);
        card.append(row, sub);
        draw();
      }
      nodes.push(card);
    }
    const replay = button('action', 'Play the entrance again', 'play');
    replay.title = 'Turns the layer off and on, so draw-in and fade play again on the table';
    replay.addEventListener('click', async () => {
      const instances = Object.entries(host.store.state.layers).filter(([, s]) => s.layer === id && s.active);
      for (const [instance] of instances) await host.send('layer.activate', { layer: instance, active: false });
      for (const [instance] of instances) await host.send('layer.activate', { layer: instance, active: true });
    });
    nodes.push(replay);
    return nodes;
  };

  // -- Interaction
  const interactionTab = (): HTMLElement[] => [
    el('p', 'lb-lead', 'What a visitor can do with this layer.'),
    el('div', 'lb-card lb-soon'),
  ].map((node, i) => {
    if (i === 1) {
      node.append(
        el('strong', undefined, 'Coming in the next steps of the builder'),
        el('span', undefined, 'Tap a feature to read it on the controller, step through categories with Next, sliders on the controller and phones, and a cue at the spot when something changes (#105).'),
      );
    }
    return node;
  });

  section.append(tabs, body);
  show(lastTabs.get(id) ?? 'look');
  return section;
}

// ---- The palette ----------------------------------------------------------------------

/** The table's palette (#93): pick a set, then change any slot. Every layer that uses slots recolours at once. */
export function paletteDialog(host: BuilderHost, shell: HTMLElement): void {
  const dialog = el('dialog', 'im-dialog lb-palette');
  dialog.ariaLabel = 'Palette';
  const head = el('header', 'im-dialog-head');
  const close = el('button', 'ed-icon-button', '×');
  close.type = 'button';
  close.ariaLabel = 'Close';
  close.addEventListener('click', () => dialog.close());
  head.append(el('h2', undefined, 'Table palette'), close);
  let palette: SitePalette = structuredClone(host.store.state.site.palette ?? {}) ?? {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const empty = !palette.set && Object.keys(palette.slots ?? {}).length === 0;
      void host.send('palette.set', { palette: empty ? null : palette });
    }, 120);
  };
  const content = el('div', 'lb-palette-body');
  const draw = () => {
    const resolved = resolvePalette(palette);
    const sets = el('div', 'lb-sets');
    for (const set of PALETTE_SETS) {
      const card = el('button', 'lb-set');
      card.type = 'button';
      card.setAttribute('aria-pressed', String(resolved.set.id === set.id));
      const strip = el('span', 'lb-set-strip');
      for (const slot of ['accent', 'warm', 'cool', 'green', 'cat3', 'cat6'] as const) {
        const s = el('span');
        s.style.background = set.slots[slot];
        strip.append(s);
      }
      card.append(strip, el('strong', undefined, set.name), el('span', undefined, set.description));
      card.addEventListener('click', () => {
        palette = { set: set.id };
        save();
        draw();
      });
      sets.append(card);
    }
    const slots = el('div', 'lb-slots');
    for (const slot of PALETTE_SLOTS) {
      const row = el('div', 'lb-slot');
      const changed = Boolean(palette.slots?.[slot]);
      const picker = el('input');
      Object.assign(picker, { type: 'color', value: resolved.slots[slot] });
      picker.ariaLabel = SLOT_ROLES[slot];
      const warn = el('span', 'lb-slot-warning');
      const setWarning = (hex: string) => {
        const w = projectionWarning(hex);
        warn.textContent = w ? '!' : '';
        warn.title = w ?? '';
      };
      setWarning(resolved.slots[slot]);
      picker.addEventListener('input', () => {
        palette.slots = { ...(palette.slots ?? {}), [slot]: picker.value };
        setWarning(picker.value);
        reset.hidden = false;
        save();
      });
      const reset = button('lb-small', 'Reset');
      reset.hidden = !changed;
      reset.addEventListener('click', () => {
        const next = { ...(palette.slots ?? {}) };
        delete next[slot];
        palette.slots = next;
        save();
        draw();
      });
      row.append(picker, el('span', 'lb-slot-name', SLOT_ROLES[slot]), warn, reset);
      slots.append(row);
    }
    const ramps = el('div', 'lb-ramp-list');
    for (const [name, colours] of Object.entries(resolved.ramps)) {
      const r = el('div', 'lb-ramp is-wide');
      r.style.background = `linear-gradient(to right, ${colours.join(', ')})`;
      r.title = name;
      ramps.append(r, el('span', 'lb-ramp-name', name));
    }
    content.replaceChildren(el('h4', undefined, 'Start from'), sets, el('h4', undefined, 'Colours'), slots, el('h4', undefined, 'Ramps'), ramps);
  };
  draw();
  dialog.append(head, el('p', 'wz-lead', 'Layers use these colours by name, so changing one here recolours every custom layer and its legend at once. Colours marked ! are too dark to read on the projected table.'), content);
  dialog.addEventListener('close', () => dialog.remove());
  shell.append(dialog);
  dialog.showModal();
}
