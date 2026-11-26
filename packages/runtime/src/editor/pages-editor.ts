/**
 * Design › Controller pages… (#155): the controller's hand-made pages, made in the editor rather
 * than in site.json. A page list on the left, the page's 12 by 6 grid in the middle with what it
 * spends of the screen's budget, and the selected panel's widget, size, layer and props on the
 * right. Without pages the controller lays out the open layers' panels by itself.
 *
 * Nothing is dragged (docs/editor-ui.md, rule 7): a panel goes in the first free place, moves a
 * cell at a time with the arrow buttons or keys, or goes where a highlighted empty cell is clicked.
 * Every change is saved at once (`site.tv`), and the dashboard's own rules say what is wrong.
 */
import { DATA_SLOTS, GRID, ROTATE_S, SCREEN, SIZES, TEXT, validatePage } from '@mrstudio/dashboard';
import type { PropSpec, WidgetDefinition } from '@mrstudio/dashboard';
import type { PanelSize, PanelSpec } from '@mrstudio/sdk';

import { el } from '../controls.ts';
import { widgets } from '../registry.ts';
import { freeId, moved, newPanel, pageBudget, resized } from './pages-model.ts';
import type { Page } from './pages-model.ts';
import { setting } from './settings-list.ts';
import type { TableSettingsHost } from './table-settings.ts';

/** What each size is called in the editor. */
const SIZE_NAMES: Record<PanelSize, string> = {
  chip: 'Chip, 2 by 1',
  tile: 'Tile, 3 by 2',
  wide: 'Wide, 6 by 2',
  tall: 'Tall, 3 by 4',
  block: 'Block, 6 by 4',
  hero: 'Hero, 9 by 4',
  band: 'Band, 12 by 1',
  strip: 'Strip, 12 by 2',
};

/** Widgets an author places by hand: `custom` belongs to a layer's own code. */
const placeable = (): WidgetDefinition[] => widgets.list().filter((w) => w.type !== 'custom' && w.type !== 'control');

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const row = el('label', 'ed-field');
  row.append(el('span', undefined, label), input);
  if (!hint) return row;
  const wrap = el('div', 'ed-field-wrap');
  wrap.append(row, el('p', 'ed-hint', hint));
  return wrap;
}

function button(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', 'ed-button', text);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** The Controller pages dialog's body. */
export function pagesEditor(host: TableSettingsHost): HTMLElement {
  const { store, send } = host;
  const root = el('div', 'pe');
  let pages: Page[] = structuredClone((store.state.site.tv?.pages ?? []) as Page[]);
  let current = 0;
  let selected: string | null = null;
  let note = '';
  /** What this dialog sent and the host has not echoed yet, oldest first (#572). */
  const sent: string[] = [];

  const page = (): Page | undefined => pages[current];
  const panel = (): PanelSpec | undefined => page()?.panels.find((p) => p.id === selected);
  const save = (): void => {
    sent.push(JSON.stringify(pages));
    if (sent.length > 50) sent.shift();
    void send('site.tv', { tv: { pages: pages.length ? pages : null } });
    draw();
  };
  const say = (text: string): void => {
    note = text;
    draw();
  };

  /** The page list, its title and the time each page shows. */
  const pageList = (): HTMLElement => {
    const side = el('section', 'pe-pages');
    side.append(el('h3', undefined, 'Pages'));
    const list = setting('controller.pages', 'dialog:pages', el('ol', 'pe-page-list'));
    pages.forEach((p, index) => {
      const item = el('li');
      const pick = el('button', `pe-page${index === current ? ' is-current' : ''}`, p.title || `Page ${index + 1}`);
      pick.type = 'button';
      pick.dataset.page = p.id;
      pick.addEventListener('click', () => {
        current = index;
        selected = null;
        note = '';
        draw();
      });
      item.append(pick);
      list.append(item);
    });
    if (!pages.length) list.append(el('li', 'pe-empty', 'No pages. The controller shows the open layers’ panels by itself.'));
    const add = button('Add page', () => {
      pages.push({ id: freeId(pages, 'page'), title: `Page ${pages.length + 1}`, panels: [] });
      current = pages.length - 1;
      selected = null;
      note = '';
      save();
    });
    add.dataset.command = 'pages.add';
    side.append(list, add);
    const p = page();
    if (p) {
      const title = el('input');
      Object.assign(title, { type: 'text', value: p.title ?? '', maxLength: TEXT.title, placeholder: `Page ${current + 1}` });
      title.addEventListener('change', () => {
        p.title = title.value.trim() || undefined;
        save();
      });
      const tools = el('div', 'pe-row');
      const up = button('Move up', () => {
        [pages[current - 1], pages[current]] = [pages[current]!, pages[current - 1]!];
        current--;
        save();
      });
      up.disabled = current === 0;
      const down = button('Move down', () => {
        [pages[current + 1], pages[current]] = [pages[current]!, pages[current + 1]!];
        current++;
        save();
      });
      down.disabled = current === pages.length - 1;
      const remove = button('Remove page', () => {
        pages.splice(current, 1);
        current = Math.max(0, current - 1);
        selected = null;
        save();
      });
      remove.dataset.command = 'pages.remove';
      tools.append(up, down, remove);
      side.append(field('Page title', title), tools);
    }
    const rotate = setting('controller.rotate', 'dialog:pages', el('div', 'ed-number'));
    const seconds = el('input');
    Object.assign(seconds, { type: 'number', min: String(ROTATE_S.min), max: String(ROTATE_S.max), value: String(store.state.site.tv?.rotate_s ?? ROTATE_S.default) });
    seconds.addEventListener('change', () => {
      const n = Number(seconds.value);
      if (!Number.isFinite(n)) return;
      const s = Math.min(ROTATE_S.max, Math.max(ROTATE_S.min, Math.round(n)));
      void send('site.tv', { tv: { rotate_s: s === ROTATE_S.default ? null : s } });
    });
    rotate.append(seconds, el('span', undefined, 's'));
    side.append(field('Each page shows for', rotate, 'With more than one page, they take turns.'));
    return side;
  };

  /** The page's grid: its panels, the empty cells, the budget and what the rules say. */
  const grid = (): HTMLElement => {
    const middle = el('section', 'pe-middle');
    const p = page();
    if (!p) {
      middle.append(el('p', 'pe-start', 'Add a page to place panels on the controller by hand: numbers, charts, keys, maps and words, each bound to what a layer publishes.'));
      return middle;
    }
    const budget = pageBudget(p, widgets);
    const meter = el('div', 'pe-budget');
    const bar = el('span', 'pe-bar');
    bar.style.setProperty('--used', String(Math.min(1, budget.reads / SCREEN.reads)));
    meter.append(el('b', undefined, `${budget.reads} of ${SCREEN.reads} reads`), bar, el('span', undefined, `${budget.panels} of ${SCREEN.panels} panels`));
    meter.classList.toggle('is-over', budget.reads > SCREEN.reads);
    const board = el('div', 'pe-grid');
    board.style.setProperty('--cols', String(GRID.columns));
    board.style.setProperty('--rows', String(GRID.rows));
    const chosen = panel();
    for (let row = 1; row <= GRID.rows; row++) {
      for (let col = 1; col <= GRID.columns; col++) {
        const cell = el('button', 'pe-cell');
        cell.type = 'button';
        cell.style.gridArea = `${row} / ${col}`;
        cell.dataset.cell = `${col},${row}`;
        // With a panel selected, the cells it fits at take it there.
        const to = chosen && moved(p.panels, chosen, col - (chosen.at?.col ?? col), row - (chosen.at?.row ?? row));
        if (to) {
          cell.classList.add('can-take');
          cell.title = `Put ${chosen.title || 'the panel'} here`;
          cell.addEventListener('click', () => {
            chosen.at = to;
            save();
          });
        } else {
          cell.tabIndex = -1;
          cell.addEventListener('click', () => {
            selected = null;
            draw();
          });
        }
        board.append(cell);
      }
    }
    for (const spec of p.panels) {
      const size = SIZES[spec.size];
      const widget = widgets.get(spec.widget);
      const box = el('button', `pe-panel${spec.id === selected ? ' is-selected' : ''}`);
      box.type = 'button';
      box.dataset.panel = spec.id;
      if (spec.at && size) box.style.gridArea = `${spec.at.row} / ${spec.at.col} / span ${size.rows} / span ${size.cols}`;
      box.append(el('b', undefined, spec.title || widget?.name || spec.widget), el('span', undefined, widget?.name ?? spec.widget));
      box.addEventListener('click', () => {
        selected = spec.id;
        note = '';
        draw();
        root.querySelector<HTMLElement>(`.pe-panel[data-panel="${spec.id}"]`)?.focus();
      });
      box.addEventListener('keydown', (event) => {
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!step || spec.id !== selected) return;
        event.preventDefault();
        const to = moved(p.panels, spec, step[0]!, step[1]!);
        if (!to) return;
        spec.at = to;
        save();
        root.querySelector<HTMLElement>(`.pe-panel[data-panel="${spec.id}"]`)?.focus();
      });
      board.append(box);
    }
    const adder = el('div', 'pe-add');
    const pick = el('select');
    pick.ariaLabel = 'Widget';
    for (const w of placeable()) pick.append(new Option(w.name, w.type));
    const add = button('Add panel', () => {
      const widget = widgets.get(pick.value);
      if (!widget) return;
      const made = newPanel(pages, p, widget, widgets);
      if (typeof made === 'string') return say(made);
      p.panels.push(made);
      selected = made.id;
      note = '';
      save();
    });
    add.dataset.command = 'pages.panel';
    adder.append(pick, add);
    const problems = el('ul', 'pe-problems');
    for (const issue of validatePage(p, widgets)) problems.append(el('li', undefined, `${issue.path.split('.').slice(2).join(' › ') || 'Page'}: ${issue.message}`));
    middle.append(meter, board, adder);
    if (note) middle.append(el('p', 'pe-note', note));
    if (problems.childElementCount) middle.append(problems);
    return middle;
  };

  /** The selected panel's settings. */
  const inspector = (): HTMLElement => {
    const right = el('section', 'pe-inspector');
    const p = page();
    const spec = panel();
    if (!p || !spec) {
      right.append(el('p', 'pe-start', p ? 'Select a panel to set its widget, size, layer and what it shows. Add one under the grid.' : ''));
      return right;
    }
    const widget = widgets.get(spec.widget);
    right.append(el('h3', undefined, widget?.name ?? spec.widget));
    if (widget) right.append(el('p', 'ed-hint', widget.description));
    const title = el('input');
    Object.assign(title, { type: 'text', value: spec.title ?? '', maxLength: TEXT.title });
    title.addEventListener('change', () => {
      spec.title = title.value.trim();
      save();
    });
    right.append(field('Title', title));
    if (widget) {
      const size = el('select');
      for (const s of widget.sizes) {
        const option = new Option(SIZE_NAMES[s], s, false, s === spec.size);
        option.disabled = s !== spec.size && !resized(p.panels, spec, s);
        size.append(option);
      }
      size.addEventListener('change', () => {
        const to = resized(p.panels, spec, size.value as PanelSize);
        if (!to) return;
        spec.size = size.value as PanelSize;
        spec.at = to;
        save();
      });
      right.append(field('Size', size, `${SIZES[spec.size].use}. Holds ${SIZES[spec.size].reads} reads.`));
    }
    const layer = el('select');
    layer.append(new Option('None', ''));
    for (const id of store.state.scene) {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      if (!manifest || state.parent) continue;
      layer.append(new Option(state.button?.name ?? manifest.name, id, false, spec.layer === id));
    }
    layer.addEventListener('change', () => {
      spec.layer = layer.value || undefined;
      save();
    });
    right.append(field('Layer', layer, 'Its values fill what the panel shows, and the panel is up while the layer is on.'));
    // What the panel's layer offers to bind to: what it publishes, then its settings.
    const state = spec.layer ? store.state.layers[spec.layer] : undefined;
    const paths = state ? [...Object.keys(state.shared ?? {}).map((k) => `shared.${k}`), ...Object.keys(state.params ?? {}).filter((k) => k !== 'entities').map((k) => `params.${k}`)] : [];
    if (widget) for (const [key, prop] of Object.entries(widget.props)) right.append(propField(spec, key, prop, paths, save));
    const nudge = el('div', 'pe-row pe-nudge');
    for (const [label, dx, dy] of [['←', -1, 0], ['↑', 0, -1], ['↓', 0, 1], ['→', 1, 0]] as const) {
      const b = button(label, () => {
        const to = moved(p.panels, spec, dx, dy);
        if (to) {
          spec.at = to;
          save();
        }
      }, 'Move the panel a cell');
      b.disabled = !moved(p.panels, spec, dx, dy);
      nudge.append(b);
    }
    const remove = button('Remove panel', () => {
      p.panels = p.panels.filter((x) => x.id !== spec.id);
      selected = null;
      save();
    });
    remove.dataset.command = 'pages.panel.remove';
    right.append(field('Move', nudge, 'Or click a highlighted cell, or use the arrow keys.'), remove);
    return right;
  };

  const draw = (): void => {
    current = Math.min(current, Math.max(0, pages.length - 1));
    root.replaceChildren(pageList(), grid(), inspector());
  };
  // Another author or the MCP server changed the pages: start from theirs.
  store.onTv((tv) => {
    if (!root.isConnected) return;
    const theirs = JSON.stringify(tv?.pages ?? []);
    // The echo of one of our own saves, maybe older than what is on screen now: not another
    // author's change, so it must not take the dialog back or redraw it under the typing.
    const ours = sent.indexOf(theirs);
    if (ours >= 0) {
      sent.splice(0, ours + 1);
      return;
    }
    if (theirs === JSON.stringify(pages)) return;
    pages = structuredClone((tv?.pages ?? []) as Page[]);
    draw();
  });
  draw();
  return root;
}

/** One prop of a panel's widget: a fixed value, or (where the widget allows it) a value from the layer. */
function propField(spec: PanelSpec, key: string, prop: PropSpec, paths: readonly string[], save: () => void): HTMLElement {
  const props = (spec.props ??= {});
  const value = props[key];
  const bound = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { bind?: unknown }).bind === 'string';
  const wrap = el('div', 'pe-prop');
  wrap.dataset.prop = key;
  const set = (next: unknown): void => {
    if (next === undefined || next === '') delete props[key];
    else props[key] = next;
    save();
  };
  let input: HTMLElement;
  if (bound) {
    const path = el('input');
    Object.assign(path, { type: 'text', value: (value as { bind: string }).bind, placeholder: 'shared.total' });
    const list = el('datalist');
    list.id = `pe-paths-${spec.id}-${key}`;
    for (const p of paths) list.append(new Option(p));
    path.setAttribute('list', list.id);
    wrap.append(list);
    path.addEventListener('change', () => set(path.value.trim() ? { bind: path.value.trim() } : undefined));
    input = path;
  } else if (prop.kind === 'boolean') {
    const box = el('input');
    Object.assign(box, { type: 'checkbox', checked: value === true });
    box.addEventListener('change', () => set(box.checked));
    input = box;
  } else if (prop.kind === 'enum' || prop.kind === 'slot') {
    const options = prop.kind === 'enum' ? prop.options : Array.from({ length: DATA_SLOTS }, (_, i) => String(i + 1));
    const pick = el('select');
    pick.append(new Option('—', ''));
    for (const o of options) pick.append(new Option(prop.kind === 'slot' ? `Colour ${o}` : o, o, false, String(value ?? '') === o));
    pick.addEventListener('change', () => set(pick.value === '' ? undefined : prop.kind === 'slot' ? Number(pick.value) : pick.value));
    input = pick;
  } else if (prop.kind === 'number') {
    const n = el('input');
    Object.assign(n, { type: 'number', value: typeof value === 'number' ? String(value) : '' });
    if (prop.min !== undefined) n.min = String(prop.min);
    if (prop.max !== undefined) n.max = String(prop.max);
    n.addEventListener('change', () => set(n.value === '' ? undefined : Number(n.value)));
    input = n;
  } else if (prop.kind === 'text' || prop.kind === 'value' || prop.kind === 'colormap') {
    const t = el('input');
    Object.assign(t, { type: 'text', value: value === undefined || typeof value === 'object' ? '' : String(value) });
    if (prop.kind === 'text') t.maxLength = prop.max;
    t.addEventListener('change', () => {
      const v = t.value.trim();
      set(prop.kind === 'value' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
    });
    input = t;
  } else {
    // Lists, series, GeoJSON and colouring rules are written out as JSON.
    const area = el('textarea');
    area.rows = 4;
    area.value = value === undefined ? '' : JSON.stringify(value);
    area.addEventListener('change', () => {
      if (!area.value.trim()) return set(undefined);
      try {
        set(JSON.parse(area.value));
      } catch {
        area.setCustomValidity('This is not JSON');
        area.reportValidity();
      }
    });
    input = area;
  }
  wrap.append(field(prop.label + (prop.required ? '' : ' (optional)'), input));
  if (prop.bindable || prop.kind === 'list') {
    const from = el('label', 'pe-bind');
    const box = el('input');
    Object.assign(box, { type: 'checkbox', checked: bound });
    box.addEventListener('change', () => set(box.checked ? { bind: paths[0] ?? 'shared.' } : undefined));
    from.append(box, el('span', undefined, 'From the layer'));
    wrap.append(from);
  }
  return wrap;
}
