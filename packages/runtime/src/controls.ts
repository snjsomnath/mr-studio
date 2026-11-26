import { entityOverrides, entityValues, formatClock, formatUnit, isVisible, parseNumber, profileColumns } from '@mrstudio/sdk';
import type { Connection, Control, Participant, EntityFeature, EntitySet, LayerManifest, LegendRow, TextControl, LayerState, PanelContext, PanelHandlers, Role, TvAbout } from '@mrstudio/sdk';

import { AttractLoop, effectOf } from './attract.ts';
import { icon } from './editor/icons.ts';
import { LANGUAGE_NAMES, language, offered, say, t } from './i18n.ts';
import type { Language } from './i18n.ts';
import { entitySender, baseContext, isAtRest, paramSender } from './layer-manager.ts';
import { loadEntities } from './entities.ts';

export { isAtRest };
import { mountStage } from './dashboard.ts';
import { layerModule } from './registry.ts';
import { customHero, hasCustomHero } from './custom-hero.ts';
import { MEDIA_KINDS, canAddMedia, mediaItems, onMediaChanged, requestAddMedia, sizeOf, titleOf, valueOf } from './media.ts';
import { Picker } from './picker.ts';
import type { Choice, PickerAction } from './picker.ts';
import { PHONE_SEND_INTERVAL, toolSection, wordsField } from './phone-tools.ts';
import type { Store } from './store.ts';
import { avatarOf, nameOf } from './avatars.ts';
import { canJoin, chosenLayers, joinLayer } from './two-layers.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One generated control. `sync` shows a value from the host, with the layer's other params; `row` is its element. */
export interface Widget {
  control: Control;
  row: HTMLElement;
  sync(value: unknown, params?: Record<string, unknown>, shared?: Record<string, unknown>): void;
}

/** A time of day in hours as a clock reads it: 12.5 is 12:30, 24 is 24:00. */
export function clock(hours: number): string {
  return formatClock(hours);
}

function formatNumber(value: number, control: Extract<Control, { type: 'range' }>): string {
  // Hours read as a clock (#64), not as a decimal.
  const decimals = control.step && control.step < 1 ? Math.min(3, String(control.step).split('.')[1]?.length ?? 0) : 0;
  // One formatter (#397): the session's decimal mark, and 270° but 5 m/s.
  return formatUnit(value, control.unit, decimals, { clock: control.max <= 24 });
}

/**
 * A typed value for a range control: a number in its unit ("5.5", "5,5", "5.5 m/s"), or a time
 * of day for hours ("13:30", "9"). Kept inside the range and on its steps; null when it is not a number.
 */
export function parseValue(text: string, control: Extract<Control, { type: 'range' }>): number | null {
  const clean = text.trim();
  const time = /^(\d{1,2})[:.,h](\d{2})$/.exec(clean);
  // A typed number reads with a point or a comma, and its unit after it is ignored (#397).
  let value = control.unit === 'h' && time ? Number(time[1]) + Number(time[2]) / 60 : parseNumber(clean.replace(/[^\d.,\s\u00a0−-]+$/, ''));
  if (value === null || !Number.isFinite(value)) return null;
  value = Math.min(control.max, Math.max(control.min, value));
  if (control.step) value = control.min + Math.round((value - control.min) / control.step) * control.step;
  return Number(value.toFixed(6));
}

/** A source as `/api/sources` lists it: never its key. */
interface SourceSummary {
  id: string;
  kind: string;
  name: string;
  ready: boolean;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const shellInvoke = (): Invoke | undefined => (window as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;

/** The sources set up on this computer. Asked again when the window comes back into focus, as after the Sources page. */
let sourceList: Promise<SourceSummary[]> | null = null;
function sources(): Promise<SourceSummary[]> {
  sourceList ??= fetch('/api/sources', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { sources: [] }))
    .then((page: { sources?: SourceSummary[] }) => page.sources ?? [])
    .catch(() => []);
  return sourceList;
}

/**
 * A text control that names a source from the Sources manager (#41): a list of the sources
 * of the kinds it takes, and a way to set one up. Pages that cannot read the list (a phone)
 * still show the chosen id.
 */
function sourcePicker(row: HTMLElement, label: HTMLLabelElement, id: string, control: TextControl, send: (value: unknown) => void): (value: unknown) => void {
  const select = el('select', 'control-source');
  select.id = id;
  const manage = shellInvoke();
  let current = '';
  let known: SourceSummary[] = [];
  const render = () => {
    const options = [new Option('None', '')];
    for (const s of known) options.push(new Option(s.ready ? s.name : `${s.name} (needs a key)`, s.id));
    if (current && !known.some((s) => s.id === current)) options.push(new Option(`${current} (not set up on this computer)`, current));
    if (manage) options.push(new Option('Set up sources…', '__manage__'));
    select.replaceChildren(...options);
    select.value = current;
  };
  const refresh = () =>
    void sources().then((list) => {
      known = list.filter((s) => control.sources!.includes(s.kind));
      render();
    });
  select.addEventListener('change', () => {
    if (select.value === '__manage__') {
      select.value = current;
      void manage?.('open_sources');
      return;
    }
    send(select.value);
  });
  window.addEventListener('focus', () => {
    sourceList = null;
    if (select.isConnected) refresh();
  });
  render();
  refresh();
  row.append(label, select);
  return (value) => {
    if (typeof value !== 'string' || value === current) return;
    current = value;
    render();
  };
}

/**
 * A text control that names something the table has (#306): a dataset or file (`media`), a
 * column of another control's dataset (`columnsOf`), or layers of a map service (`serviceLayers`).
 * A list to pick from, with type-ahead, instead of a name to type; and Add media in the editor.
 */
function namePicker(row: HTMLElement, label: HTMLLabelElement, id: string, control: TextControl, send: (value: unknown) => void): (value: unknown, params?: Record<string, unknown>) => void {
  let params: Record<string, unknown> = {};
  const text = (key: string | undefined) => (key && typeof params[key] === 'string' ? (params[key] as string) : '');
  const kinds = control.media ?? [];
  const by = control.mediaBy ?? 'name';
  const actions: PickerAction[] = [];
  if (kinds.length && canAddMedia()) {
    actions.push({
      label: 'Add media…',
      icon: 'plus',
      run: async () => {
        const item = await requestAddMedia(kinds);
        return item && kinds.includes(item.kind) ? valueOf(item, by) : null;
      },
    });
  }
  let load: () => Promise<Choice[]>;
  let empty = 'Nothing to choose yet.';
  if (control.serviceLayers) {
    const keys = control.serviceLayers;
    empty = 'The service lists no layers.';
    load = async () => {
      const query = new URLSearchParams({ url: text(keys.url), service: text(keys.service) || 'wms', source: text(keys.source) });
      if (!query.get('url') && !query.get('source')) throw new Error('give the service address first');
      const answer = await fetch(`/api/wms/layers?${query}`);
      const page = (await answer.json().catch(() => ({}))) as { layers?: { name: string; title: string }[]; error?: string };
      if (!answer.ok) throw new Error(page.error ?? `the service answered ${answer.status}`);
      return (page.layers ?? []).map((l) => ({ value: l.name, label: l.title, detail: l.title === l.name ? undefined : l.name }));
    };
  } else if (control.columnsOf) {
    const of = control.columnsOf;
    empty = 'Choose the data first: its columns are listed here.';
    load = async () => {
      const name = text(of);
      if (!name) return [];
      const item = (await mediaItems()).find((i) => i.name === name || i.path === name);
      if (!item) return [];
      return columnsOfFile(item.path);
    };
  } else {
    const kindsLabel = kinds.map((k) => MEDIA_KINDS[k].plural.toLowerCase()).join(' or ');
    empty = `This table has no ${kindsLabel} yet.${actions.length ? ' Add some with Add media.' : ''}`;
    load = async () =>
      (await mediaItems())
        .filter((item) => kinds.includes(item.kind))
        .map((item) => ({
          value: valueOf(item, by),
          label: titleOf(item),
          detail: item.missing ? 'Missing from the table folder' : [item.name ? item.path.split('/').pop() : '', sizeOf(item.bytes)].filter(Boolean).join(' · '),
          group: kinds.length > 1 ? MEDIA_KINDS[item.kind].plural : undefined,
          icon: MEDIA_KINDS[item.kind].icon,
        }));
  }
  const picker = new Picker({
    id,
    label: control.label,
    none: control.none ?? (control.serviceLayers ? undefined : 'None'),
    multiple: Boolean(control.serviceLayers),
    eager: !control.serviceLayers,
    load,
    actions,
    empty,
    loading: control.serviceLayers ? 'Asking the service for its layers…' : undefined,
    pick: (value) => send(value),
  });
  const stop = onMediaChanged(() => {
    if (!row.isConnected) stop();
    else if (!control.serviceLayers) picker.forget();
  });
  row.append(label, picker.element);
  // The list depends on the other settings it names: asked again when one of them changes.
  const depends = control.serviceLayers ? [control.serviceLayers.url, control.serviceLayers.service, control.serviceLayers.source] : control.columnsOf ? [control.columnsOf] : [];
  return (value, next) => {
    if (next) {
      const changed = depends.some((key) => key && next[key] !== params[key]);
      params = next;
      if (changed) picker.forget();
    }
    if (typeof value === 'string') picker.set(value);
  };
}

/** The columns of a GeoJSON or CSV file of the table, for a "Colour by" list. */
async function columnsOfFile(path: string): Promise<Choice[]> {
  const response = await fetch(`/site/${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('the file could not be read');
  let rows: Record<string, unknown>[];
  if (/\.csv$/i.test(path)) {
    const lines = (await response.text()).split(/\r?\n/).filter(Boolean);
    const separator = (lines[0]?.match(/;/g)?.length ?? 0) > (lines[0]?.match(/,/g)?.length ?? 0) ? ';' : ',';
    const head = (lines[0] ?? '').split(separator).map((h) => h.trim().replace(/^"|"$/g, ''));
    rows = lines.slice(1, 501).map((line) => Object.fromEntries(line.split(separator).map((v, i) => [head[i] ?? String(i), v.trim().replace(/^"|"$/g, '')])));
  } else {
    const json = (await response.json()) as { features?: { properties?: Record<string, unknown> | null }[] };
    rows = (json.features ?? []).map((f) => f.properties ?? {});
  }
  return profileColumns(rows).map((c) => ({ value: c.name, label: c.name, detail: c.kind === 'number' ? 'Numbers' : `${c.distinct} ${c.distinct === 1 ? 'value' : 'values'}` }));
}

/** Four or more choices are laid out in rows where space is tight (the editor's inspector): 2 × 2 for four, three across for more. */
function columns(group: HTMLElement, count: number) {
  if (count >= 4) group.dataset.columns = count === 4 ? '2' : '3';
}

/** The controls people see: all but `tier: 'state'`, which a layer keeps for itself (#194). */
export function visibleControls(controls: readonly Control[] | undefined): Control[] {
  return (controls ?? []).filter((control) => control.tier !== 'state');
}

/**
 * One control. `exact` (the editor, #64) lets a range's value be typed: click the number,
 * type, press Enter.
 */
export function widget(control: Control, send: (value: unknown) => void, act: (words?: string) => void, options: { exact?: boolean } = {}): Widget {
  const row = el('div', `control control-${control.type}`);
  const id = `c-${Math.random().toString(36).slice(2)}`;
  const label = el('label', 'control-label', control.label);
  label.htmlFor = id;
  if (control.help) row.title = control.help;
  let sync: (value: unknown, params?: Record<string, unknown>, shared?: Record<string, unknown>) => void = () => {};

  switch (control.type) {
    case 'range': {
      const input = el('input');
      const readout = el('output', 'control-value');
      Object.assign(input, { id, type: 'range', min: String(control.min), max: String(control.max), step: String(control.step ?? 'any') });
      // While a finger is on the slider the host's echoes must not move it.
      let held = false;
      input.addEventListener('pointerdown', () => (held = true));
      for (const type of ['pointerup', 'pointercancel', 'blur']) input.addEventListener(type, () => (held = false));
      // `shows`: what the layer publishes for this value reads better than the number (#338).
      let shown = '';
      input.addEventListener('input', () => {
        if (!shown) readout.textContent = formatNumber(input.valueAsNumber, control);
        send(input.valueAsNumber);
      });
      let saved: number | null = null;
      sync = (value, _params, shared) => {
        const published = control.shows ? shared?.[control.shows] : undefined;
        shown = typeof published === 'string' || typeof published === 'number' ? String(published) : '';
        if (shown) readout.textContent = shown;
        if (held || typeof value !== 'number') return;
        saved = value;
        input.value = String(value);
        if (!shown) readout.textContent = formatNumber(value, control);
      };
      const head = el('div', 'control-head');
      head.append(label, readout);
      row.append(head, input);
      if (options.exact) {
        // The number is a field in disguise: click it, type a value, Enter keeps it, Escape does not.
        readout.tabIndex = 0;
        readout.classList.add('is-exact');
        readout.setAttribute('role', 'button');
        readout.title = control.unit === 'h' ? 'Click to type a time, such as 13:30' : `Click to type a value from ${control.min} to ${control.max}${control.unit ? ` ${control.unit}` : ''}`;
        const edit = (): void => {
          if (head.querySelector('.control-exact')) return;
          const field = el('input', 'control-exact');
          Object.assign(field, { type: 'text', inputMode: control.unit === 'h' ? 'text' : 'decimal', value: saved === null ? '' : control.unit === 'h' ? clock(saved) : String(saved) });
          field.setAttribute('aria-label', `${control.label}${control.unit ? `, ${control.unit === 'h' ? 'time' : control.unit}` : ''}`);
          readout.hidden = true;
          readout.after(field);
          let done = false;
          const finish = (keep: boolean): void => {
            if (done) return;
            done = true;
            const value = keep ? parseValue(field.value, control) : null;
            field.remove();
            readout.hidden = false;
            if (value !== null && value !== saved) {
              saved = value;
              input.value = String(value);
              readout.textContent = formatNumber(value, control);
              send(value);
            }
          };
          field.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') finish(true);
            else if (event.key === 'Escape') finish(false);
            else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              // The arrows step the typed value, as on the slider.
              event.preventDefault();
              const now = parseValue(field.value, control) ?? saved ?? control.min;
              const step = (control.step ?? (control.max - control.min) / 100) * (event.shiftKey ? 10 : 1);
              const next = parseValue(String(now + (event.key === 'ArrowUp' ? step : -step)), control) ?? now;
              field.value = control.unit === 'h' ? clock(next) : String(next);
            }
          });
          field.addEventListener('blur', () => finish(true));
          field.focus();
          field.select();
        };
        readout.addEventListener('click', edit);
        readout.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            edit();
          }
        });
      }
      break;
    }
    case 'select': {
      const group = el('div', 'segmented');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', control.label);
      const buttons = control.options.map((option) => {
        const button = el('button', undefined, option.label);
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.addEventListener('click', () => send(option.value));
        group.append(button);
        return [option.value, button] as const;
      });
      columns(group, buttons.length);
      sync = (value) => {
        for (const [option, button] of buttons) button.setAttribute('aria-checked', String(option === value));
      };
      row.append(el('div', 'control-label', control.label), group);
      break;
    }
    case 'toggle': {
      const input = el('input');
      Object.assign(input, { id, type: 'checkbox', className: 'switch' });
      input.addEventListener('change', () => send(input.checked));
      sync = (value) => (input.checked = value === true);
      row.append(label, input);
      break;
    }
    case 'date':
      if (control.presets?.length) {
        // Days as one tap each, and the full date beside them for any other day.
        const group = el('div', 'segmented');
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', control.label);
        const input = el('input');
        Object.assign(input, { id, type: 'date', className: 'control-date-more' });
        input.setAttribute('aria-label', t('Another {thing}', { thing: control.label.toLowerCase() }));
        input.addEventListener('input', () => input.value && send(input.value));
        let shown = '';
        const dateOf = (preset: string) => {
          if (preset === 'today') return new Date().toISOString().slice(0, 10);
          const year = /^\d{4}/.exec(shown)?.[0] ?? String(new Date().getFullYear());
          return `${year}-${preset}`;
        };
        const buttons = control.presets.map((preset) => {
          const button = el('button', undefined, preset.label);
          button.type = 'button';
          button.setAttribute('role', 'radio');
          button.addEventListener('click', () => send(dateOf(preset.value)));
          group.append(button);
          return [preset.value, button] as const;
        });
        columns(group, buttons.length);
        sync = (value) => {
          if (typeof value !== 'string') return;
          shown = value;
          if (document.activeElement !== input) input.value = value;
          // Today wins only when no named day is the same date.
          const named = buttons.find(([preset]) => preset !== 'today' && dateOf(preset) === value);
          for (const [preset, button] of buttons) button.setAttribute('aria-checked', String(named ? preset === named[0] : dateOf(preset) === value));
        };
        const line = el('div', 'control-presets');
        line.append(group, input);
        row.append(el('div', 'control-label', control.label), line);
        break;
      }
    // falls through
    case 'color':
    case 'text': {
      if (control.type === 'text' && control.sources?.length) {
        sync = sourcePicker(row, label, id, control, send);
        break;
      }
      if (control.type === 'text' && (control.media?.length || control.columnsOf || control.serviceLayers)) {
        row.classList.add('control-pick');
        sync = namePicker(row, label, id, control, send);
        break;
      }
      const input = el('input');
      Object.assign(input, { id, type: control.type });
      input.addEventListener(control.type === 'text' ? 'change' : 'input', () => input.value && send(input.value));
      sync = (value) => {
        if (document.activeElement !== input && typeof value === 'string') input.value = value;
      };
      row.append(label, input);
      break;
    }
    case 'action': {
      const button = el('button', 'action', control.label);
      button.type = 'button';
      if (control.words) {
        // Pressed with a few words (#462): the field, then the button that sends them.
        const words = wordsField(control.words);
        const form = el('form', 'action-words');
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!words.value.trim()) return;
          act(words.value);
          words.value = '';
        });
        button.type = 'submit';
        form.append(words, button);
        row.append(form);
      } else {
        button.addEventListener('click', () => act());
        row.append(button);
      }
      break;
    }
  }
  return { control, row, sync };
}

/** What an instance is called on screen: the layer's name, plus the instance id when it is not the only one. */
export function instanceTitle(id: string, manifest: LayerManifest): string {
  return id === manifest.id ? manifest.name : `${manifest.name} (${id})`;
}

/** The words and icon a layer goes by on the controller: the site's own, else the layer package's. */
export function layerButton(
  id: string,
  manifest: LayerManifest,
  state?: LayerState,
  defaultSide: 'left' | 'right' = 'left',
): { name: string; description: string; icon: string | undefined; side: 'left' | 'right' } {
  const button = state?.button ?? {};
  return {
    // The site's own words are written in English and said in the visitors' language (#80).
    name: button.name ? t(button.name) : instanceTitle(id, manifest),
    description: button.description ? t(button.description) : (manifest.description ?? ''),
    icon: button.icon ?? manifest.icon,
    side: button.side ?? defaultSide,
  };
}

/** Layers of these categories are the map at rest. They have no button on the controller. */
export function isAmbient(manifest: LayerManifest): boolean {
  return manifest.category === 'base' || manifest.category === 'ambient';
}


/**
 * Layer packages the editor offers to add. The building blocks demo shows the SDK to
 * developers; it is not a layer an author would put on a table (#38). Sites that
 * already have it keep it.
 */
export function isOffered(manifest: LayerManifest): boolean {
  return manifest.id !== 'blocks-demo';
}

/** The side a site's layer buttons default to: `tv.rail`, unless that hides them. */
export function defaultSide(store: Store): 'left' | 'right' {
  return store.state.site.tv?.rail === 'right' ? 'right' : 'left';
}

/** One button on a rail of the controller screen. */
export interface RailButton {
  id: string;
  side: 'left' | 'right';
  /** The group it sits in, such as "Simulations", or undefined for none. */
  group: string | undefined;
}

/**
 * The layer buttons of the controller screen, in the order they sit down their rails.
 *
 * Order: by `button.order` (lowest first; buttons without one follow), then top of the scene
 * first. Buttons of the same group are kept together, where the group's first button is.
 *
 * Side: a button the author placed stays there. When the site names a rail (`tv.rail`), the
 * others go to it. Otherwise they are shared out so both sides are used: a group at a time,
 * the left side fills to half of all the buttons, then the right.
 */
export function railButtons(store: Store, withHidden = false): RailButton[] {
  const { state } = store;
  const scene = [...state.scene].reverse();
  const ids = scene.filter((id) => {
    const manifest = store.manifest(state.layers[id]?.layer ?? '');
    // A layer's items have no button: they come on with their layer. A hidden button stays in the
    // table, off the rails (#58); the editor's list still shows it where it would be.
    return manifest !== undefined && !isAtRest(manifest, state.layers[id]) && !state.layers[id]?.parent && (withHidden || !state.layers[id]?.button?.hidden);
  });
  const order = (id: string) => state.layers[id]?.button?.order ?? Number.POSITIVE_INFINITY;
  const sorted = [...ids].sort((a, b) => order(a) - order(b) || scene.indexOf(a) - scene.indexOf(b));
  const groupOf = (id: string) => state.layers[id]?.button?.group?.trim() || undefined;
  // Runs of buttons that move together: one per named group, and one per ungrouped button.
  const runs: string[][] = [];
  const named = new Map<string, string[]>();
  for (const id of sorted) {
    const group = groupOf(id);
    if (group === undefined) runs.push([id]);
    else if (named.has(group)) named.get(group)!.push(id);
    else {
      const run = [id];
      named.set(group, run);
      runs.push(run);
    }
  }
  const rail = state.site.tv?.rail;
  const half = Math.ceil(ids.length / 2);
  let left = ids.filter((id) => state.layers[id]?.button?.side === 'left').length;
  const out: RailButton[] = [];
  for (const run of runs) {
    const free = run.filter((id) => !state.layers[id]?.button?.side);
    let side: 'left' | 'right';
    if (rail === 'left' || rail === 'right') side = rail;
    else side = left < half ? 'left' : 'right';
    if (side === 'left') left += free.length;
    for (const id of run) out.push({ id, side: state.layers[id]?.button?.side ?? side, group: groupOf(id) });
  }
  return out;
}

/** The side each layer button sits on, keyed by instance id (see `railButtons`). */
export function buttonSides(store: Store): Map<string, 'left' | 'right'> {
  return new Map(railButtons(store).map((b) => [b.id, b.side]));
}

/** The side a layer's button defaults to when its author has not placed it. */
export function defaultSideOf(store: Store, id: string): 'left' | 'right' {
  return buttonSides(store).get(id) ?? defaultSide(store);
}

interface Card {
  /** On the controller screen: the open layer's part of the centre. */
  body?: HTMLElement;
  element: HTMLElement;
  sync(state: LayerState): void;
  dispose(): void;
}

/**
 * The controller. On a phone and on the developer page it is one card per layer with
 * an on/off switch and the controls generated from its manifest. On the controller
 * screen beside the table (`right` is given) each layer is a button on the left or the
 * right side; pressing one opens that layer and closes the others, and the open layer's
 * words and controls are in the centre. The map's ambient layers have no button.
 * The layer's panels are on the dashboard canvas.
 */
/**
 * Full screen from the controller (#198). In the app the table's window goes in or out of
 * full screen; in a browser, as on the Chalmers demo, the controller's own page does.
 */
function fullScreen(): void {
  if ((window as { __MRS_SHELL__?: boolean }).__MRS_SHELL__) {
    // The app's shell takes the address and stays on this page.
    window.location.href = '/__shell/fullscreen';
    return;
  }
  // Safari before 16.4 and WKWebView spell it with a prefix, or have none at all (#420).
  const page = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (document.fullscreenElement ?? page.webkitFullscreenElement) {
    if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
    else page.webkitExitFullscreen?.();
  } else if (root.requestFullscreen) void root.requestFullscreen().catch(() => {});
  else root.webkitRequestFullscreen?.();
}

/** Whether this page can go full screen: in the app's shell, or a browser that offers it (#420). */
function canFullScreen(): boolean {
  if ((window as { __MRS_SHELL__?: boolean }).__MRS_SHELL__) return true;
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  return typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function';
}

/**
 * The language switch (#80): the languages' codes side by side, flag-free, the current one pressed.
 * Each says its own name to a screen reader.
 */
export function languageSwitch(languages: Language[], now: Language, pick: (language: Language) => void): HTMLElement {
  const group = el('div', 'language-switch');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('Language'));
  for (const code of languages) {
    const press = el('button', 'language-option', code.toUpperCase());
    press.type = 'button';
    press.lang = code;
    press.title = LANGUAGE_NAMES[code];
    press.setAttribute('aria-label', LANGUAGE_NAMES[code]);
    press.setAttribute('aria-pressed', String(code === now));
    press.addEventListener('click', () => code !== now && pick(code));
    group.append(press);
  }
  return group;
}

/** The About page on the controller screen: the site's words and its credits. */
function aboutPage(about: TvAbout, fallback: string, siteLogo: string | null): HTMLElement {
  const page = el('section', 'layer-card layer-open about-page');
  page.hidden = true;
  // The logos of the people behind the table, as the Chalmers demo has them (#198).
  const logos = (about.logos ?? (siteLogo ? [{ path: siteLogo }] : [])).filter((l) => l && typeof l.path === 'string' && l.path);
  if (logos.length > 0) {
    const row = el('div', 'about-logos');
    for (const logo of logos) {
      const image = el('img', 'about-logo');
      image.src = `/site/${logo.path.replace(/^\/+/, '')}`;
      image.alt = logo.name ?? '';
      image.addEventListener('error', () => image.remove());
      row.append(image);
    }
    page.append(row);
  }
  page.append(el('h2', 'layer-open-name', about.title ? t(about.title) : fallback));
  if (about.text) page.append(el('p', 'layer-about', t(about.text)));
  const credits = (about.credits ?? []).filter((c) => c && typeof c.name === 'string');
  if (credits.length > 0) {
    const list = el('dl', 'about-credits');
    for (const credit of credits) {
      const item = el('div', 'about-credit');
      item.append(el('dt', undefined, credit.role ? t(credit.role) : ''), el('dd', undefined, credit.name));
      if (credit.note) item.append(el('dd', 'about-note', t(credit.note)));
      list.append(item);
    }
    page.append(list);
  }
  // The maps and data on the table now, in the words their services ask for (#37).
  page.append(el('p', 'about-map'));
  return page;
}

/**
 * ◀ ▶, play and the info strip for a layer with steps (docs/contracts/present.md, Steps):
 * a slideshow's current step (counter, title, one line, source) and the sub-steps of the
 * layer on show, which Next reveals one at a time. Hidden for a layer without steps.
 */
function stepStrip(id: string, store: Store, connection: Connection): { element: HTMLElement; sync(state: LayerState): void } {
  const strip = el('div', 'step-strip');
  strip.hidden = true;
  const nav = el('div', 'step-nav');
  const button = (label: string, name: string, run: () => void) => {
    const press = el('button', 'step-button');
    press.type = 'button';
    press.title = label;
    press.setAttribute('aria-label', label);
    press.append(icon(name, 26));
    press.addEventListener('click', run);
    nav.append(press);
    return press;
  };
  const step = (to: string) => void connection.request('layer.step', { layer: id, to }).catch(() => {});
  const previous = button(t('Previous step'), 'previous', () => step('previous'));
  const play = button(t('Play the steps'), 'play', () => {
    const playing = store.state.layers[id]?.step?.playing ?? false;
    void connection.request('layer.play', { layer: id, playing: !playing }).catch(() => {});
  });
  const next = button(t('Next step'), 'next', () => step('next'));
  play.classList.add('is-play');
  const words = el('div', 'step-words');
  const count = el('div', 'step-count');
  const title = el('h3', 'step-title');
  const line = el('p', 'step-line');
  const source = el('p', 'step-source');
  words.append(count, title, line, source);
  const subs = el('ol', 'step-subs');
  strip.append(nav, words, subs);
  let playing: boolean | undefined;
  return {
    element: strip,
    sync(state) {
      const at = state.step;
      strip.hidden = !at || at.count === 0;
      if (!at || at.count === 0) return;
      const sequence = Boolean(store.manifest(state.layer)?.sequence);
      // The layer the slideshow shows now, for its name and its sub-steps' names.
      const shown = sequence ? shownBy(store, id) : undefined;
      const shownState = shown ? store.state.layers[shown] : undefined;
      const shownName = shownState ? (shownState.button?.name ? t(shownState.button.name) : (store.manifest(shownState.layer)?.name ?? '')) : '';
      // A step's words come from the site (a slide's title) or from the layer (its own steps).
      const words = store.manifest((sequence ? shownState?.layer : state.layer) ?? state.layer);
      count.textContent = sequence ? t('{n} of {count}', { n: Math.min(at.index + 1, at.count), count: at.count }) : t('{n} of {count} shown', { n: at.index, count: at.count });
      title.textContent = at.title ? say(at.title, words) : shownName;
      title.hidden = !title.textContent;
      line.textContent = say(at.description ?? '', words);
      line.hidden = !line.textContent;
      source.textContent = at.source ? t('Source: {source}', { source: at.source }) : '';
      source.hidden = !at.source;
      // Sub-steps: the slideshow mirrors the shown layer's; any other layer has its own.
      const sub = sequence ? at.sub : { index: at.index, count: at.count };
      const names = (sequence ? shownState?.step?.titles : at.titles) ?? [];
      subs.hidden = !sub || sub.count === 0 || (sequence === false && names.length === 0);
      if (sub && sub.count > 0) {
        const items = Array.from({ length: sub.count }, (_, i) => {
          const item = el('li', 'step-sub', names[i] ? say(names[i]!, store.manifest((shownState ?? state).layer)) : String(i + 1));
          item.classList.toggle('is-shown', i < sub.index);
          item.classList.toggle('is-current', i === sub.index - 1);
          return item;
        });
        subs.replaceChildren(...items);
      }
      previous.disabled = sequence ? at.index === 0 && (at.sub?.index ?? 0) === 0 && state.steps?.loop === false : at.index === 0;
      next.disabled = !sequence && at.index >= at.count;
      if (playing !== at.playing) {
        playing = at.playing;
        play.replaceChildren(icon(at.playing ? 'pause' : 'play', 26));
        play.title = at.playing ? t('Pause the steps') : t('Play the steps');
        play.setAttribute('aria-label', play.title);
        play.setAttribute('aria-pressed', String(at.playing));
      }
    },
  };
}

/** The layer a slideshow shows now, or undefined. */
function shownBy(store: Store, sequence: string): string | undefined {
  return store.state.scene.find((other) => store.state.layers[other]?.shown_by === sequence);
}

/**
 * The legend zone of the stage (#76): big swatches for what is on the table. The rows come
 * from what the layer published (`ctx.legend`, or a `legend` list in `shared`), otherwise from
 * layer.json. A slideshow shows the legend of the layer on show. Rows named by the sub-steps
 * follow the reveal: those still to come are faint, and the one just revealed is marked.
 */
function legendZone(id: string, store: Store): { element: HTMLElement; sync(state: LayerState): boolean } {
  const zone = el('ul', 'stage-legend');
  zone.setAttribute('aria-label', t('Legend'));
  zone.hidden = true;
  let drawn = '';
  return {
    element: zone,
    sync(state) {
      const source = (store.manifest(state.layer)?.sequence ? shownBy(store, id) : undefined) ?? id;
      const from = source ? store.state.layers[source] : undefined;
      const shared = (from?.shared ?? {}) as { legend?: unknown; legend_highlight?: unknown; legend_shown?: unknown };
      const published = Array.isArray(shared.legend) ? (shared.legend as LegendRow[]) : [];
      const rows = (published.length > 0 ? published : (from ? store.manifest(from.layer)?.legend : undefined) ?? []).filter((row) => row && typeof row.label === 'string');
      const key = (row: LegendRow) => row.id ?? row.label;
      // The reveal: sub-steps named like the rows say which rows are on the table yet.
      const titles = from?.step?.titles ?? [];
      const revealed = from?.step && titles.length > 0 ? Math.min(from.step.index, titles.length) : 0;
      const partial = revealed > 0 && revealed < titles.length;
      const listed = Array.isArray(shared.legend_shown) ? new Set((shared.legend_shown as string[]).map(String)) : undefined;
      const current = typeof shared.legend_highlight === 'string' ? shared.legend_highlight : revealed > 0 ? titles[revealed - 1] : undefined;
      const look = rows.map((row) => {
        const index = titles.indexOf(row.label);
        const waiting = listed ? !listed.has(key(row)) : partial && index >= revealed;
        return { row, waiting, current: current !== undefined && (key(row) === current || row.label === current) };
      });
      zone.hidden = rows.length === 0;
      // When the rows name the sub-steps, the legend shows the reveal and the strip's row of names steps aside.
      const follows = rows.some((row) => titles.includes(row.label));
      const next = JSON.stringify(look);
      if (next === drawn) return follows;
      drawn = next;
      zone.replaceChildren(
        ...look.map(({ row, waiting, current: now }) => {
          const item = el('li', 'legend-row');
          item.classList.toggle('is-waiting', waiting);
          item.classList.toggle('is-current', now);
          const swatch = el('i', 'legend-swatch');
          swatch.dataset.shape = row.shape ?? 'fill';
          if (row.color) swatch.style.setProperty('--swatch', row.color);
          item.append(swatch, el('span', 'legend-label', say(row.label, from ? store.manifest(from.layer) : undefined)));
          return item;
        }),
      );
      return follows;
    },
  };
}

/**
 * What a layer is waiting for (#278): `busy: { label, progress }` published while a service
 * works, shown under the layer's name with a bar, so no layer draws its own spinner.
 */
function busyZone(store: Store): { element: HTMLElement; sync(state: LayerState): void } {
  const zone = el('div', 'stage-busy');
  zone.setAttribute('role', 'status');
  zone.hidden = true;
  const label = el('span', 'stage-busy-label');
  const bar = el('span', 'stage-busy-bar');
  const fill = el('i');
  bar.append(fill);
  zone.append(label, bar);
  return {
    element: zone,
    sync(state) {
      const busy = state.shared?.busy as { label?: unknown; progress?: unknown } | null | undefined;
      const on = Boolean(busy && typeof busy.label === 'string');
      zone.hidden = !on;
      if (!on) return;
      label.textContent = say(String(busy!.label), store.manifest(state.layer));
      const progress = typeof busy!.progress === 'number' ? Math.max(0, Math.min(1, busy!.progress)) : undefined;
      bar.classList.toggle('is-open', progress === undefined);
      fill.style.width = progress === undefined ? '' : `${Math.round(progress * 100)}%`;
    },
  };
}

/**
 * The entity inspector (#279): for each of a layer's entity sets, the picked entity's name and
 * its own controls, a list to pick one without the table, Back to default, and "Apply to all
 * of <group>" when the set has a group. Picks and values go through the host, so the table, the
 * editor and every controller agree. No layer code takes part.
 */
function entityZone(id: string, manifest: LayerManifest, store: Store, connection: Connection): { element: HTMLElement; sync(state: LayerState): void } {
  const zone = el('div', 'stage-entities');
  const sets = manifest.entities ?? [];
  zone.hidden = sets.length === 0;
  const setEntity = entitySender(connection, id);
  const parts = sets.map((set) => entitySetPart(id, set, manifest, store, connection, setEntity));
  zone.append(...parts.map((part) => part.element));
  return {
    element: zone,
    sync(state) {
      for (const part of parts) part.sync(state);
    },
  };
}

function entitySetPart(
  id: string,
  set: EntitySet,
  manifest: LayerManifest,
  store: Store,
  connection: Connection,
  setEntity: (set: string, ids: string | string[], values: Record<string, unknown> | null) => void,
): { element: HTMLElement; sync(state: LayerState): void } {
  const part = el('section', 'entity-set');
  part.dataset.set = set.id;
  const kind = say(set.name ?? 'Item', manifest);
  const head = el('header', 'entity-head');
  const words = el('div', 'entity-words');
  const kicker = el('span', 'entity-kicker', kind);
  const name = el('h3', 'entity-name');
  const hint = el('p', 'entity-hint', t('Tap one on the table, or choose it from the list.'));
  words.append(kicker, name, hint);
  const list = el('select', 'entity-list');
  list.setAttribute('aria-label', t('Choose a {thing}', { thing: kind.toLowerCase() }));
  head.append(words, list);
  const controls = el('div', 'controls entity-controls');
  const actions = el('div', 'entity-actions');
  const reset = el('button', 'entity-button', t('Back to default'));
  reset.type = 'button';
  const all = el('button', 'entity-button');
  all.type = 'button';
  const count = el('span', 'entity-count');
  actions.append(reset, all, count);
  // Tap to read (#38): the picked one's facts, read only.
  const facts = el('dl', 'entity-facts');
  facts.hidden = true;
  part.append(head, facts, controls, actions);
  if (set.controls.length === 0) actions.hidden = true;

  let features: EntityFeature[] = [];
  let picked: string | null = null;
  const widgets = set.controls.map((control) =>
    widget(
      { ...control, label: say(control.label, manifest) } as Control,
      (value) => picked !== null && setEntity(set.id, picked, { [control.id]: value }),
      () => {},
    ),
  );
  controls.append(...widgets.map((w) => w.row));
  list.addEventListener('change', () => {
    void connection.request('layer.select', { layer: id, set: set.id, id: list.value || null }).catch(() => {});
  });
  reset.addEventListener('click', () => picked !== null && setEntity(set.id, picked, null));
  all.addEventListener('click', () => {
    const feature = features.find((f) => f.id === picked);
    if (!feature?.group) return;
    const ids = features.filter((f) => f.group === feature.group).map((f) => f.id);
    setEntity(set.id, ids, entityValues(set, store.layer(id).params, feature.id));
  });

  let listed = '';
  const sync = (state: LayerState) => {
    const selection = state.selection?.set === set.id ? state.selection.id : null;
    picked = selection;
    const feature = features.find((f) => f.id === selection);
    const changed = Object.keys(entityOverrides(state.params, set.id));
    const key = JSON.stringify([features.length, changed]);
    if (key !== listed) {
      listed = key;
      const marked = new Set(changed);
      const choose = el('option', undefined, t('Choose…'));
      choose.value = '';
      const options = [...features]
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
        .map((f) => {
          const option = el('option', undefined, marked.has(f.id) ? `${f.label} •` : f.label);
          option.value = f.id;
          return option;
        });
      list.replaceChildren(choose, ...options);
    }
    list.value = selection ?? '';
    part.classList.toggle('is-picked', selection !== null);
    name.textContent = feature?.label ?? selection ?? '';
    name.hidden = selection === null;
    hint.hidden = selection !== null;
    const rows = feature?.facts ?? [];
    facts.hidden = rows.length === 0;
    facts.replaceChildren(...rows.flatMap(([term, value]) => [el('dt', undefined, say(term, manifest)), el('dd', undefined, value)]));
    controls.hidden = selection === null;
    const values = selection !== null ? entityValues(set, state.params, selection) : {};
    for (const w of widgets) {
      w.row.hidden = !isVisible(w.control, values);
      w.sync(values[w.control.id], values);
    }
    reset.hidden = selection === null || !changed.includes(selection);
    all.hidden = selection === null || !feature?.group;
    if (feature?.group) all.textContent = t('Apply to all of {group}', { group: feature.group });
    count.textContent = changed.length > 0 ? t('{count} changed', { count: changed.length }) : '';
  };
  void loadEntities(store.state.site, set).then((list) => {
    features = list;
    sync(store.layer(id));
  });
  return { element: part, sync };
}

/** A sound a layer published for the controller (#150). */
interface SoundRow {
  id: string;
  label: string;
  colour: string;
  at: [number, number];
  playing: boolean;
}

/**
 * Sound cards (#150): one card per sound a layer published (`shared.sounds`), in the point's
 * colour, lit while it plays. Tapping a card plays that sound on the table, through the layer's
 * `sound` tool at the point. A slideshow shows the cards of the layer on show.
 */
function soundZone(id: string, store: Store, connection: Connection): { element: HTMLElement; sync(state: LayerState): void } {
  const zone = el('div', 'stage-sounds');
  zone.setAttribute('aria-label', t('Sounds'));
  zone.hidden = true;
  let drawn = '';
  return {
    element: zone,
    sync(state) {
      const source = (store.manifest(state.layer)?.sequence ? shownBy(store, id) : undefined) ?? id;
      const from = store.state.layers[source];
      const list = (from?.shared as { sounds?: unknown } | undefined)?.sounds;
      const rows = Array.isArray(list) ? (list as SoundRow[]).filter((row) => row && typeof row.label === 'string' && Array.isArray(row.at)) : [];
      zone.hidden = rows.length === 0;
      const next = JSON.stringify([source, rows]);
      if (next === drawn) return;
      drawn = next;
      zone.replaceChildren(
        ...rows.slice(0, 12).map((row) => {
          const card = el('button', 'sound-card') as HTMLButtonElement;
          card.type = 'button';
          card.classList.toggle('is-playing', Boolean(row.playing));
          card.style.setProperty('--sound', row.colour || 'var(--accent)');
          card.setAttribute('aria-pressed', String(Boolean(row.playing)));
          const dot = el('i', 'sound-dot');
          const words = el('span', 'sound-words');
          words.append(el('b', undefined, row.label), el('small', undefined, row.playing ? t('Playing') : t('Tap to play')));
          card.append(dot, words);
          card.addEventListener('click', () => {
            void connection.request('tool.input', { layer: source, tool: 'sound', geometry: { type: 'Point', coordinates: row.at } }).catch(() => {});
          });
          return card;
        }),
      );
    },
  };
}

export class Controller {
  private cards = new Map<string, Card>();
  private backListened = false;
  /** The side each button was last placed on. */
  private sides = new Map<string, string>();
  private readonly right: HTMLElement | undefined;
  /** Where the open layer's words and controls go on the controller screen. */
  private readonly centre: HTMLElement | undefined;
  /** The home screen: the site's title over the attract loop (#74). */
  private readonly welcome: HTMLElement;
  private readonly attract: AttractLoop | undefined;
  /** When someone last touched the controller, for the idle reset (#74). */
  private lastInput = performance.now();
  /** The site's About page in the centre, when `tv.about` gives it words. */
  private readonly about: HTMLElement | undefined;
  private aboutButton: HTMLButtonElement | undefined;
  /** With two layers open (#473): the one whose controls the centre shows, when the visitor swapped to it. */
  private focus: string | undefined;
  /** The newest open layer when the centre was last drawn: a layer opened since puts its controls in front. */
  private newest: string | undefined;
  /** The chip for the other open layer: press it to swap, × to close it. */
  private pair: { element: HTMLElement; swap: HTMLButtonElement; name: HTMLElement; mark: HTMLElement; close: HTMLButtonElement } | undefined;
  private readonly root: HTMLElement;
  private readonly store: Store;
  private readonly connection: Connection;
  private readonly role: Role;

  constructor(root: HTMLElement, store: Store, connection: Connection, role: Role, right?: HTMLElement, centre?: HTMLElement) {
    this.root = root;
    this.right = right;
    this.centre = centre;
    const { site } = store.state;
    this.store = store;
    const heading = t(site.branding.title ?? site.name);
    const welcome = site.branding.welcome ? t(site.branding.welcome) : undefined;
    if (centre) {
      const credits = (site.tv?.about?.credits ?? []).map((c) => (c.role ? `${t(c.role)}: ${c.name}` : c.name)).join('  ·  ');
      this.attract = new AttractLoop(heading, () => this.attractStops(), { stepS: site.tv?.attract_s, credits: credits || undefined, welcome, logo: site.branding.logo });
      this.welcome = this.attract.element;
    } else {
      this.welcome = el('div', 'layer-welcome');
      this.welcome.append(el('h2', undefined, heading), el('p', undefined, welcome ?? t('Choose a layer to bring it to the table.')));
    }
    this.connection = connection;
    this.role = role;
    this.about = centre && site.tv?.about ? aboutPage(site.tv.about, heading, site.branding.logo) : undefined;
    if (centre) this.pair = this.pairChip();
    this.arrange();
    this.creditMaps();
    if (centre) {
      this.listenForKeys();
      this.idleReset();
      this.phoneCue(centre);
    }
    store.onLayer((id, state) => {
      // Opening a layer closes the About page.
      const manifest = store.manifest(state.layer);
      if (state.active && !state.parent && this.aboutOpen && manifest && !isAtRest(manifest, state)) this.showAbout(false);
      this.cards.get(id)?.sync(state);
      this.creditMaps();
      // The slideshow's stage speaks for the layer it shows: its legend and step names follow that layer.
      if (state.shown_by && store.state.layers[state.shown_by]) this.cards.get(state.shown_by)?.sync(store.state.layers[state.shown_by]!);
      // A button moves when its author changes its side, and the buttons shared out around it may move too.
      if (this.right && this.sides.has(id) && this.layoutKey() !== this.shown) this.arrange();
    });
    store.onRemoved((id) => {
      this.cards.get(id)?.dispose();
      this.cards.delete(id);
    });
    store.onScene(() => this.arrange());
  }

  /**
   * When a visitor's phone turns a layer on or off (#335), a short line at the top of the
   * centre says so, with a dot in that phone's colour, so whoever is at the controller knows
   * where the change came from.
   */
  private cue: HTMLElement | undefined;

  private phoneCue(centre: HTMLElement): void {
    const cue = el('div', 'phone-cue');
    this.cue = cue;
    cue.setAttribute('role', 'status');
    cue.hidden = true;
    const dot = el('span', 'phone-cue-dot');
    const words = el('span');
    cue.append(dot, words);
    centre.prepend(cue);
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.connection.on('phone.switched', (p: { layer: string; active: boolean; participant?: Participant }) => {
      const state = this.store.state.layers[p.layer];
      const manifest = state && this.store.manifest(state.layer);
      if (!state || !manifest) return;
      const name = layerButton(p.layer, manifest, state).name;
      // "Sunny Fox turned on Wind", with the fox on that phone's colour (#339).
      const who = p.participant;
      if (who) words.textContent = p.active ? t('{who} turned on {name}', { who: nameOf(who), name }) : t('{who} turned off {name}', { who: nameOf(who), name });
      else words.textContent = p.active ? t('{name} turned on from a phone', { name }) : t('{name} turned off from a phone', { name });
      dot.textContent = who ? avatarOf(who) : '';
      dot.style.background = who?.colour ?? 'currentColor';
      cue.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => (cue.hidden = true), 4000);
    });
  }

  /** The rails as last laid out, to tell when a change of side, group or order moves a button. */
  private shown = '';

  private layoutKey(): string {
    return JSON.stringify(railButtons(this.store));
  }

  /**
   * Lays the cards out, making cards for layers that are new. On the controller screen the
   * buttons follow `railButtons` (order, groups, sides), with a group's name above it;
   * elsewhere the top of the scene comes first.
   */
  private arrange(): void {
    const { store } = this;
    const elements: HTMLElement[] = [];
    const onRight: HTMLElement[] = [];
    const make = (id: string, manifest: LayerManifest, state: LayerState) => {
      let card = this.cards.get(id);
      if (!card) {
        card = this.right ? this.button(id, manifest) : this.card(id, manifest);
        this.cards.set(id, card);
        card.sync(state);
      }
      return card;
    };
    if (this.right) {
      const last = { left: null as string | null | undefined, right: null as string | null | undefined };
      for (const { id, side, group } of railButtons(store)) {
        const state = store.state.layers[id]!;
        const card = make(id, store.manifest(state.layer)!, state);
        this.sides.set(id, side);
        const list = side === 'right' ? onRight : elements;
        // A gap and the group's name start each group; an ungrouped button after a group gets the gap only.
        if (list.length > 0 && group !== last[side]) list.push(el('div', 'rail-gap'));
        if (group !== undefined && group !== last[side]) list.push(el('div', 'rail-group', group));
        last[side] = group;
        list.push(card.element);
      }
    } else {
      for (const id of [...store.state.scene].reverse()) {
        const state = store.state.layers[id];
        const manifest = state && store.manifest(state.layer);
        if (!manifest) continue;
        // A button the author hid is off phones too (#58); the developer page keeps everything.
        if (this.role === 'phone' && state.button?.hidden) continue;
        elements.push(make(id, manifest, state).element);
      }
    }
    this.root.replaceChildren(...elements);
    this.right?.replaceChildren(...onRight);
    if (this.right) this.shown = this.layoutKey();
    if (this.centre) {
      // The layer that was opened comes first; a tool kept alongside it follows.
      const ids = [...store.state.scene].reverse();
      const kept = (id: string) => Boolean(store.manifest(store.state.layers[id]?.layer ?? '')?.alongside);
      const bodies = [...ids.filter((id) => !kept(id)), ...ids.filter(kept)].flatMap((id) => this.cards.get(id)?.body ?? []);
      this.centre.replaceChildren(...(this.cue ? [this.cue] : []), this.welcome, ...(this.about ? [this.about] : []), ...(this.pair ? [this.pair.element] : []), ...bodies);
      this.rest();
    }
  }

  /** Opens a layer on the controller screen. The others close, except the ones made to run alongside. */
  private async open(id: string): Promise<void> {
    const { store, connection } = this;
    const mine = store.manifest(store.state.layers[id]?.layer ?? '');
    // A layer a slideshow shows leaves the slideshow when it is opened, so it is opened first:
    // closing the slideshow after that no longer takes it off.
    const fromShow = Boolean(store.state.layers[id]?.shown_by);
    const activate = connection.request('layer.activate', { layer: id, active: true }).catch(() => {});
    if (fromShow) await activate;
    if (!mine?.alongside) closeOthers(store, connection, id);
  }

  /**
   * A layer on the controller screen: a button on one side, and in the centre, while the
   * layer is open, its name, its line of description and its controls.
   */
  private button(id: string, manifest: LayerManifest): Card {
    const { store, connection } = this;
    const card = el('div', 'layer-button-card');
    const press = el('button', 'layer-button');
    press.type = 'button';
    const badge = el('span', 'layer-button-icon');
    const name = el('span', 'layer-button-name');
    // A layer that is on but not running (#259) says so under its name, never a dead button.
    const note = el('span', 'layer-button-note', t('Not available right now'));
    note.hidden = true;
    press.append(badge, name, note);
    // Hold the button (or Shift-click it) to add the layer to the open one (#473). A ring grows
    // round the icon; letting go or leaving the button before it closes adds nothing.
    let hold: { timer: number; started: number } | undefined;
    let swallow = false;
    const HOLD_SHOWS_MS = 180;
    const HOLD_MS = 750;
    const stopHold = (cancelled: boolean) => {
      if (!hold) return;
      clearTimeout(hold.timer);
      if (cancelled && performance.now() - hold.started >= HOLD_SHOWS_MS) swallow = true;
      hold = undefined;
      press.classList.remove('is-holding');
    };
    press.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !canJoin(store, id)) return;
      swallow = false;
      const started = performance.now();
      const show = window.setTimeout(() => {
        if (hold?.started === started) press.classList.add('is-holding');
      }, HOLD_SHOWS_MS);
      hold = {
        started,
        timer: window.setTimeout(() => {
          clearTimeout(show);
          hold = undefined;
          press.classList.remove('is-holding');
          swallow = true;
          void joinLayer(store, connection, id).catch(() => {});
        }, HOLD_MS),
      };
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) press.addEventListener(type, () => stopHold(true));
    // A long press on a touch screen would open the browser's menu.
    press.addEventListener('contextmenu', (event) => event.preventDefault());
    press.addEventListener('click', (event) => {
      if (swallow) {
        swallow = false;
        return;
      }
      if (event.shiftKey && canJoin(store, id)) {
        void joinLayer(store, connection, id).catch(() => {});
        return;
      }
      const state = store.state.layers[id];
      // A layer a slideshow is showing is opened from its own button: it leaves the slideshow and stays.
      if (state?.active && !state.shown_by) void connection.request('layer.activate', { layer: id, active: false }).catch(() => {});
      else void this.open(id);
    });
    card.append(press);

    const body = el('section', 'layer-card layer-open');
    body.dataset.layer = id;
    // A tool kept alongside the open layer (the phones' sketch) takes one line under it.
    body.classList.toggle('is-alongside', Boolean(manifest.alongside));
    const heading = el('h2', 'layer-open-name');
    const about = el('p', 'layer-about');
    const words = el('header', 'layer-open-head');
    const mark = el('span', 'layer-button-icon');
    const text = el('div');
    text.append(heading, about);
    words.append(mark, text);
    // While the layer is in trouble (#259) the centre says so above its controls.
    const troubleLine = el('p', 'layer-trouble', t('Not available right now. It is starting again by itself.'));
    troubleLine.hidden = true;
    const send = paramSender(connection, id);
    const widgets = visibleControls(manifest.controls).map((control) =>
      widget(
        control,
        (value) => send({ [control.id]: value }),
        (words) => void connection.request('layer.action', { layer: id, action: control.id, ...(words ? { words } : {}) }).catch(() => {}),
      ),
    );
    // The layer's hero, its one large way in, sits under its name (#137).
    const hero = el('div', 'layer-hero');
    hero.hidden = true;
    const heroCleanups: (() => void)[] = [];
    let heroHandlers: PanelHandlers | void = undefined;
    const module = layerModule(manifest.id);
    // A custom layer has no code; its hero is a small map of its data and its places (#342).
    const heroOf =
      module?.hero ??
      (!module && hasCustomHero(manifest.custom) ? (ctx: PanelContext, place: HTMLElement) => customHero(ctx, place, () => store.manifest(manifest.id)?.custom) : undefined);
    if (heroOf) {
      const ctx: PanelContext = Object.assign(Object.create(baseContext(store, connection, id)), {
        panel: 'hero',
        onCleanup: (cleanup: () => void) => heroCleanups.push(cleanup),
      });
      try {
        heroHandlers = heroOf(ctx, hero);
        hero.hidden = false;
      } catch (error) {
        console.error(`[${id}] hero`, error);
      }
    }
    // The layer's own stage (#283): the centre under its name, for a map app of its own.
    const stage = el('div', 'layer-stage');
    stage.hidden = true;
    const stageCleanups: (() => void)[] = [];
    let stageHandlers: PanelHandlers | void = undefined;
    // A layout of panels (#357): the centre built from widgets, with no code.
    let stagePanels: { sync(): void; dispose(): void } | undefined;
    const layout = typeof manifest.stage === 'object' && manifest.stage !== null ? manifest.stage : undefined;
    if (layout) {
      stage.classList.add('layer-stage-panels');
      try {
        stagePanels = mountStage(stage, store, connection, id, layout);
        stageCleanups.push(() => stagePanels!.dispose());
        stage.hidden = false;
      } catch (error) {
        console.error(`[${id}] stage`, error);
      }
    }
    if (manifest.stage === 'custom' && module?.stage) {
      const ctx: PanelContext = Object.assign(Object.create(baseContext(store, connection, id)), {
        panel: 'stage',
        onCleanup: (cleanup: () => void) => stageCleanups.push(cleanup),
      });
      try {
        stageHandlers = module.stage(ctx, stage);
        stage.hidden = false;
      } catch (error) {
        console.error(`[${id}] stage`, error);
      }
    }
    // Controls by tier: primary ones large and first, then the rest in a row, then "More settings", closed.
    const tierOf = (w: Widget) => w.control.tier ?? 'secondary';
    const primary = el('div', 'controls controls-primary');
    const controls = el('div', 'controls');
    const more = el('details', 'controls-more');
    const moreRows = el('div', 'controls');
    more.append(el('summary', undefined, t('More settings')), moreRows);
    primary.append(...widgets.filter((w) => tierOf(w) === 'primary').map((w) => w.row));
    controls.append(...widgets.filter((w) => tierOf(w) === 'secondary').map((w) => w.row));
    moreRows.append(...widgets.filter((w) => tierOf(w) === 'more').map((w) => w.row));
    // A layer with steps (a slideshow, or a map revealed part by part) gets ◀ ▶, play and the info strip (#43, #76).
    const strip = stepStrip(id, store, connection);
    const legend = legendZone(id, store);
    const sounds = soundZone(id, store, connection);
    const busy = busyZone(store);
    const entities = entityZone(id, manifest, store, connection);
    // With no table window open, no layer runs, so nothing publishes its legend or live values (#412).
    const noTable = el('p', 'stage-no-table', t('Open the table to see live values here.'));
    const showNoTable = () => (noTable.hidden = store.state.session.tables !== 0);
    showNoTable();
    store.onParticipants(showNoTable);
    body.append(words, troubleLine, busy.element, noTable, strip.element);
    if (!hero.hidden) body.append(hero);
    // The picked entity's own controls come before the layer's, as the thing in hand (#279).
    if (!entities.element.hidden) body.append(entities.element);
    if (!stage.hidden) body.append(stage);
    // A layout of panels is the view: the generated control rows stay away unless it asks for them.
    const generated = !layout || layout.controls === true;
    if (generated) for (const group of [primary, controls]) if (group.childElementCount > 0) body.append(group);
    body.append(legend.element, sounds.element);
    // "More settings" closes the primary row when there is one, so it costs no height of its own.
    if (generated && moreRows.childElementCount > 0) (primary.childElementCount > 0 ? primary : body).append(more);

    // The time slider and the stage's panels follow the play head between the table's updates (#373).
    const stopClock = store.onClock((layer) => {
      if (layer !== id || !store.state.layers[id]?.active) return;
      followClock(store, id, widgets);
      stagePanels?.sync();
      try {
        heroHandlers?.update?.();
      } catch (error) {
        console.error(`[${id}] hero`, error);
      }
    });

    let shown: string | undefined;
    return {
      element: card,
      body,
      dispose: () => {
        stopClock();
        for (const cleanup of heroCleanups) cleanup();
        for (const cleanup of stageCleanups) cleanup();
        body.remove();
      },
      sync: (state) => {
        const button = layerButton(id, manifest, state, defaultSideOf(store, id));
        name.textContent = button.name;
        heading.textContent = button.name;
        if (shown !== button.icon) {
          badge.replaceChildren(icon(button.icon, 20));
          mark.replaceChildren(icon(button.icon, 24));
        }
        shown = button.icon;
        about.textContent = button.description;
        about.hidden = !button.description;
        // A layer the slideshow is showing is part of the slideshow: its button is marked, not pressed,
        // and the slideshow's strip speaks for it in the centre.
        const open = state.active && !state.shown_by;
        press.setAttribute('aria-pressed', String(open));
        press.classList.toggle('is-shown', Boolean(state.active && state.shown_by));
        card.classList.toggle('is-active', open);
        card.classList.toggle('is-trouble', Boolean(state.health));
        note.hidden = !state.health;
        troubleLine.hidden = !state.health;
        press.title = state.health ? t('Not available right now') : '';
        body.hidden = !open;
        strip.sync(state);
        strip.element.classList.toggle('legend-follows', legend.sync(state));
        sounds.sync(state);
        busy.sync(state);
        entities.sync(state);
        // A slideshow made of layers is driven by its steps: its own slide controls step aside.
        const stepped = Boolean(manifest.sequence && state.step);
        for (const w of widgets) {
          w.row.hidden = stepped || !isVisible(w.control, state.params) || Boolean(state.hide?.includes(w.control.id));
          w.sync(clockParam(store, id, w.control, state.params), state.params, state.shared);
        }
        more.hidden = ![...moreRows.children].some((row) => !(row as HTMLElement).hidden);
        // The stage's panels read the layer's values; one sync a frame is plenty (#357).
        if (state.active && stagePanels) requestAnimationFrame(() => stagePanels!.sync());
        if (state.active && stageHandlers) {
          try {
            stageHandlers.update?.();
          } catch (error) {
            console.error(`[${id}] stage`, error);
          }
        }
        if (state.active && heroHandlers) {
          try {
            heroHandlers.update?.();
          } catch (error) {
            console.error(`[${id}] hero`, error);
          }
        }
        this.rest();
      },
    };
  }

  /** The layers open on the controller: on, with a button, not part of another layer. */
  private openLayers(): string[] {
    const { store } = this;
    return store.state.scene.filter((id) => {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      return Boolean(state?.active && !state.parent && !state.shown_by && manifest && !isAtRest(manifest, state));
    });
  }

  /** The open layer that Next and Previous move: the one with steps, not a tool kept alongside. */
  private stepping(): string | undefined {
    const { store } = this;
    return this.openLayers().find((id) => store.state.layers[id]?.step && !store.manifest(store.state.layers[id]!.layer)?.alongside);
  }

  /**
   * Arrow keys and a presentation clicker (Page Up and Page Down) move the open layer's steps;
   * Shift with → skips the rest of a step's sub-steps, as on the Chalmers demo.
   */
  private listenForKeys(): void {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, select, textarea, [contenteditable="true"]') || event.altKey || event.ctrlKey || event.metaKey) return;
      const forward = event.key === 'ArrowRight' || event.key === 'PageDown';
      const back = event.key === 'ArrowLeft' || event.key === 'PageUp';
      if (!forward && !back) return;
      const id = this.stepping();
      if (!id) return;
      event.preventDefault();
      const to = back ? 'previous' : event.shiftKey ? 'skip' : 'next';
      void this.connection.request('layer.step', { layer: id, to }).catch(() => {});
    });
  }

  /** The centre says what to do while no layer is open. */
  private rest(): void {
    if (!this.centre) return;
    // A tool kept alongside (the phones' sketch) is not a layer the visitor chose.
    const chosen = this.openLayers().filter((id) => !this.store.manifest(this.store.state.layers[id]!.layer)?.alongside);
    // One with a viewer of its own (the field walk's photos) leads while nothing else is open, as a layer would.
    let leads = false;
    const open = new Set(this.openLayers());
    for (const [id, card] of this.cards) {
      const body = card.body;
      if (!body?.classList.contains('is-alongside')) continue;
      // Cleared when it closes too, or its full-width look would keep a closed one on screen.
      const lead = open.has(id) && chosen.length === 0 && Boolean(body.querySelector(':scope > .layer-hero:not([hidden])'));
      body.classList.toggle('is-lead', lead);
      leads ||= lead;
    }
    this.welcome.hidden = this.aboutOpen || chosen.length > 0 || leads;
    if (this.attract) this.attract.active = !this.welcome.hidden;
    this.showPair();
  }

  /** The two open layers (#473), as [the one in front, the other]: the newest, unless the visitor swapped. */
  private pairOf(): [string | undefined, string | undefined] {
    const open = chosenLayers(this.store);
    if (open.at(-1) !== this.newest) this.focus = undefined;
    this.newest = open.at(-1);
    if (this.focus && !open.includes(this.focus)) this.focus = undefined;
    const front = this.focus ?? open.at(-1);
    return [front, open.filter((id) => id !== front).at(-1)];
  }

  /** With two layers open, the centre shows the front one's controls and a chip for the other. */
  private showPair(): void {
    const [front, other] = this.pairOf();
    for (const id of chosenLayers(this.store)) {
      const card = this.cards.get(id);
      if (!card) continue;
      if (card.body && id !== front) card.body.hidden = true;
      card.element.classList.toggle('is-second', id === other);
    }
    if (front) {
      const body = this.cards.get(front)?.body;
      const state = this.store.state.layers[front];
      if (body && state?.active && !state.shown_by) body.hidden = false;
    }
    if (!this.pair) return;
    const { element, swap, name, mark, close } = this.pair;
    element.hidden = !other || this.aboutOpen;
    if (!other) return;
    const state = this.store.state.layers[other]!;
    const manifest = this.store.manifest(state.layer)!;
    const button = layerButton(other, manifest, state, defaultSideOf(this.store, other));
    name.textContent = button.name;
    mark.replaceChildren(icon(button.icon, 18));
    swap.setAttribute('aria-label', t('Show the controls of {name}', { name: button.name }));
    close.setAttribute('aria-label', t('Close {name}', { name: button.name }));
    swap.dataset.layer = other;
    // The front one goes after the other in the centre, so the chip sits right above it.
    if (front) {
      const body = this.cards.get(front)?.body;
      if (body && element.nextElementSibling !== body) body.before(element);
    }
  }

  private pairChip(): NonNullable<Controller['pair']> {
    const element = el('div', 'layer-pair');
    element.hidden = true;
    const swap = el('button', 'layer-pair-swap') as HTMLButtonElement;
    swap.type = 'button';
    const plus = el('span', 'layer-pair-plus', '+');
    const mark = el('span', 'layer-pair-icon');
    const name = el('span', 'layer-pair-name');
    swap.append(plus, mark, name);
    const close = el('button', 'layer-pair-close') as HTMLButtonElement;
    close.type = 'button';
    close.append(icon('close', 16));
    swap.addEventListener('click', () => {
      this.focus = swap.dataset.layer;
      this.rest();
    });
    close.addEventListener('click', () => {
      const other = swap.dataset.layer;
      if (other) void this.connection.request('layer.activate', { layer: other, active: false }).catch(() => {});
    });
    element.append(swap, close);
    return { element, swap, name, mark, close };
  }

  /** The layers the attract loop shows, in the order of the rails. */
  private attractStops() {
    return railButtons(this.store).flatMap(({ id }) => {
      const state = this.store.state.layers[id];
      const manifest = state && this.store.manifest(state.layer);
      if (!manifest) return [];
      const { name, description } = layerButton(id, manifest, state);
      return [{ id, name, description, effect: effectOf(manifest) }];
    });
  }

  /**
   * After a quiet spell the controller goes home, as if Reset were pressed (#74), so the next
   * visitor finds the welcome, not the last visitor's layer. `tv.idle_reset_s` sets the spell
   * (default 3 minutes, 0 for never); `?idle=` in the address overrides it on this screen.
   */
  private idleReset(): void {
    const touched = () => (this.lastInput = performance.now());
    for (const kind of ['pointerdown', 'keydown', 'wheel'] as const) window.addEventListener(kind, touched, { capture: true, passive: true });
    const fromAddress = Number(new URLSearchParams(location.search).get('idle'));
    setInterval(() => {
      const seconds = Number.isFinite(fromAddress) && fromAddress > 0 ? fromAddress : (this.store.state.site.tv?.idle_reset_s ?? 180);
      if (seconds <= 0 || performance.now() - this.lastInput < seconds * 1000) return;
      if (this.welcome.hidden) this.reset();
      touched();
    }, 1000);
  }

  /** The Credits page names the base map's service, and any other credit a layer on the table published as `source`. */
  private creditMaps(): void {
    const line = this.about?.querySelector<HTMLElement>('.about-map');
    if (!line) return;
    const { state } = this.store;
    const credits = new Set<string>();
    for (const id of state.scene) {
      const layer = state.layers[id];
      const source = layer?.active ? layer.shared?.source : undefined;
      if (typeof source === 'string' && source.trim()) credits.add(source.trim());
    }
    line.textContent = credits.size > 0 ? t('Maps and data: {credits}', { credits: [...credits].join(' · ') }) : '';
    line.hidden = credits.size === 0;
  }

  /**
   * Ribbon (#231): when more than one open layer has ribbon panels, the operator picks which
   * one the table's ribbon shows. Each press moves on: Auto (the layer turned on last), then
   * each of those layers in rail order. The choice holds until that layer closes.
   */
  private ribbonChoice(action: (label: string, iconName: string, run: () => void) => HTMLButtonElement): void {
    const { store } = this;
    const candidates = (): string[] =>
      railButtons(store)
        .map((b) => b.id)
        .filter((id) => {
          const state = store.state.layers[id];
          const manifest = state && store.manifest(state.layer);
          return Boolean(state?.active && manifest && !isAmbient(manifest) && manifest.panels?.some((p) => p.ribbon));
        });
    const chosen = () => store.state.session?.ribbon ?? null;
    const choose = (layer: string | null) => void this.connection.request('session.ribbon', { layer }).catch(() => {});
    const button = action(t('Ribbon'), 'ribbon', () => {
      const list = candidates();
      const at = chosen() ? list.indexOf(chosen()!) : -1;
      choose(at + 1 < list.length ? list[at + 1]! : null);
    });
    const show = () => {
      const list = candidates();
      const current = chosen();
      // The chosen layer closed: back to Auto for everyone.
      if (current && !list.includes(current) && !store.state.layers[current]?.active) choose(null);
      button.style.display = list.length < 2 ? 'none' : '';
      const state = current && list.includes(current) ? store.state.layers[current] : undefined;
      const manifest = state && store.manifest(state.layer);
      const name = state && manifest ? layerButton(current!, manifest, state).name : t('Auto');
      button.setAttribute('aria-pressed', String(Boolean(state)));
      button.title = t('Ribbon: {name}', { name });
      button.querySelector('.layer-button-name')!.textContent = t('Ribbon: {name}', { name });
    };
    show();
    store.onLayer(() => show());
    store.onScene(() => show());
    store.onParticipants(() => show());
  }

  private soundOn(): boolean {
    return this.store.state.session?.sound !== false;
  }

  private get aboutOpen(): boolean {
    return this.about !== undefined && !this.about.hidden;
  }

  private showAbout(show: boolean): void {
    if (!this.about) return;
    this.about.hidden = !show;
    this.aboutButton?.setAttribute('aria-pressed', String(show));
    this.rest();
  }

  /**
   * Reset view: closes the About page and puts the table back the way it starts, so the
   * controller goes back to its welcome.
   * Tools made to run alongside (the phones' sketch) stay on, as they do when a layer opens.
   */
  reset(): void {
    this.showAbout(false);
    // The host puts every layer back the way the table starts: what was opened goes off, the
    // map at rest comes back, and changed settings return to the saved ones (#198).
    void this.connection.request('layers.reset', {}).catch(() => this.closeLayers());
  }

  /** Closes the open layers, leaving tools kept alongside (the phones' sketch) on. */
  private closeLayers(): void {
    for (const id of this.openLayers()) {
      if (this.store.manifest(this.store.state.layers[id]!.layer)?.alongside) continue;
      void this.connection.request('layer.activate', { layer: id, active: false }).catch(() => {});
    }
  }

  /**
   * The core's own buttons at the foot of the controller screen's rail, drawn dashed so they
   * read as actions, not layers (#75), in the Chalmers demo's groups (#198):
   * - Map controls: Reset view, Full screen and Calibrate. `tv.map_controls: false` leaves Reset alone.
   * - About: Credits, when the site has `tv.about`.
   */
  actions(): HTMLElement {
    const box = el('div', 'rail-actions');
    const operator = this.store.state.site.tv?.map_controls !== false;
    const action = (label: string, iconName: string, run: () => void) => {
      const press = el('button', 'layer-button action-button');
      press.type = 'button';
      press.title = label;
      const badge = el('span', 'layer-button-icon');
      badge.append(icon(iconName, 20));
      press.append(badge, el('span', 'layer-button-name', label));
      press.addEventListener('click', run);
      box.append(press);
      return press;
    };
    if (operator) box.append(el('div', 'rail-group', t('Map controls')));
    action(operator ? t('Reset view') : t('Reset'), 'reset', () => this.reset());
    if (operator) {
      // A page that cannot fill the screen (an embedded preview) shows no button that does nothing.
      if (canFullScreen()) action(t('Full screen'), 'fullscreen', () => fullScreen());
      // Calibrate opens the projector calibration on the table, and closes it again.
      let calibrating = false;
      const calibrate = action(t('Calibrate'), 'overscan', () => {
        void this.connection.request('calibration.mode', { active: !calibrating }).catch(() => {});
      });
      calibrate.setAttribute('aria-pressed', 'false');
      this.connection.on('calibration.mode', (p: { active: boolean }) => {
        calibrating = Boolean(p.active);
        calibrate.setAttribute('aria-pressed', String(calibrating));
      });
      // Sound (#282): mutes the table's speakers for the session, every sound and voice bed.
      // The rings and colours that follow the sound carry on.
      const sound = action(t('Sound'), 'sound', () => {
        void this.connection.request('session.sound', { on: !this.soundOn() }).catch(() => {});
      });
      const showSound = () => {
        const on = this.soundOn();
        sound.setAttribute('aria-pressed', String(on));
        sound.title = on ? t('Sound') : t('Muted');
        sound.querySelector('.layer-button-name')!.textContent = on ? t('Sound') : t('Muted');
        sound.querySelector('.layer-button-icon')!.replaceChildren(icon(on ? 'sound' : 'muted', 20));
      };
      showSound();
      this.store.onParticipants(() => showSound());
      this.ribbonChoice(action);
    }
    if (this.about) {
      if (operator) box.append(el('div', 'rail-group', t('About')));
      this.aboutButton = action(t('Credits'), 'people', () => {
        const show = !this.aboutOpen;
        if (show) this.closeLayers();
        this.showAbout(show);
      });
      this.aboutButton.setAttribute('aria-pressed', 'false');
    }
    // SV / EN (#80): the table, the controller and the phones that have not chosen for themselves.
    const languages = offered(this.store.state);
    if (languages.length > 1) box.append(languageSwitch(languages, language(), (next) => void this.connection.request('session.language', { language: next }).catch(() => {})));
    return box;
  }

  /**
   * On a phone (#335) the layers are an Apps list: each row opens the layer's own page, with a
   * back button, its switch, and Controls and Map tabs. Opening a page changes nothing on the
   * table; the switch does. The phone's Back button closes the page too.
   */
  private phoneOpen: string | null = null;
  private openApp(id: string | null, fromHistory = false): void {
    if (this.phoneOpen === id) return;
    const was = this.phoneOpen;
    this.phoneOpen = id;
    this.root.classList.toggle('has-open', id !== null);
    document.body.classList.toggle('has-open-app', id !== null);
    if (was) this.cards.get(was)?.sync(this.store.state.layers[was]!);
    if (id) this.cards.get(id)?.sync(this.store.state.layers[id]!);
    this.root.closest('.cards:not(.cards-inner)')?.scrollTo({ top: 0 });
    if (fromHistory) return;
    try {
      if (id && !was) history.pushState({ app: id }, '');
      else if (!id && was && history.state?.app) history.back();
      else if (id) history.replaceState({ app: id }, '');
    } catch {
      // History is a convenience for the phone's own Back button.
    }
  }

  private listenForBack(): void {
    addEventListener('popstate', () => this.openApp(null, true));
  }

  private card(id: string, manifest: LayerManifest): Card {
    const { store, connection, role } = this;
    const phone = role === 'phone';
    if (phone && !this.backListened) {
      this.backListened = true;
      this.listenForBack();
    }
    const name = instanceTitle(id, manifest);
    const card = el('section', 'layer-card');
    card.dataset.layer = id;
    const header = el('header');
    const title = el('div', 'layer-title');
    const heading = el('h2', undefined, name);
    const about = el('p', undefined, manifest.description ?? '');
    about.hidden = !manifest.description;
    title.append(heading, about);
    const back = el('button', 'app-back');
    if (phone) {
      // The row opens the layer's page; on the page, the arrow goes back to the list.
      const badge = el('span', 'app-icon');
      if (manifest.icon) badge.append(icon(manifest.icon, 22));
      const open = el('button', 'app-open');
      open.type = 'button';
      open.setAttribute('aria-label', t('Open {name}', { name }));
      open.addEventListener('click', () => this.openApp(this.phoneOpen === id ? null : id));
      back.type = 'button';
      back.setAttribute('aria-label', t('Back to all layers'));
      back.append(icon('back', 22));
      back.addEventListener('click', () => this.openApp(null));
      open.append(badge, title);
      header.append(back, open);
    } else header.append(title);

    const power = el('input');
    Object.assign(power, { type: 'checkbox', className: 'switch', ariaLabel: t('Turn {name} on or off', { name }) });
    power.addEventListener('change', () => {
      const on = power.checked;
      // A phone opens a layer the way the controller does (#335): it joins the open one when the two
      // can share the table, else the open one makes way (#473).
      const turned = phone && on && !manifest.alongside ? joinLayer(store, connection, id) : connection.request('layer.activate', { layer: id, active: on });
      turned.catch(() => (power.checked = !on));
    });
    // Phones turn layers on and off too (#335), unless the table, the layer or a tour holds them back.
    header.append(power);
    card.append(header);

    const body = el('div', 'layer-body');
    const send = paramSender(connection, id, { minInterval: phone ? PHONE_SEND_INTERVAL : 0 });
    // On a phone, the layer's tools: a map of the table to tap and draw on, with the buttons that act on it.
    const tools = phone && manifest.tools?.length ? toolSection(id, manifest, store, connection) : null;
    const widgets = visibleControls(manifest.controls)
      .filter((control) => !phone || phoneControl(control))
      .filter((control) => !tools?.presses.includes(control.id))
      .map((control) =>
        widget(
          control,
          (value) => send({ [control.id]: value }),
          (words) => void connection.request('layer.action', { layer: id, action: control.id, ...(words ? { words } : {}) }).catch(() => {}),
        ),
      );
    const controls = el('div', 'controls');
    controls.append(...widgets.map((w) => w.row));

    // A phone's page has Controls and Map tabs when the layer has both; the map comes first for a
    // layer that is mostly drawing, such as the sketch.
    let tab: 'controls' | 'map' = tools && (widgets.length === 0 || manifest.alongside) ? 'map' : 'controls';
    const tabs = el('div', 'segmented phone-tabs');
    tabs.setAttribute('role', 'tablist');
    const tabButtons = (['controls', 'map'] as const).map((which) => {
      const button = el('button', undefined, which === 'map' ? t('Map') : t('Controls'));
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => {
        tab = which;
        showTab();
      });
      tabs.append(button);
      return [which, button] as const;
    });
    const showTab = () => {
      for (const [which, button] of tabButtons) button.setAttribute('aria-selected', String(which === tab));
      if (tools) tools.element.hidden = tab !== 'map' && widgets.length > 0;
      controls.hidden = tab !== 'controls' && Boolean(tools);
    };
    const off = el('p', 'phone-off', t('Turn it on to see it on the table and use it here.'));
    off.hidden = true;
    if (phone && tools && widgets.length > 0) body.append(tabs);
    if (tools) body.append(tools.element);
    if (widgets.length > 0) body.append(controls);
    if (phone) body.append(off);
    showTab();
    card.append(body);
    // A layer with nothing a phone can use, not even its switch, is left off the phone.
    const nothingElse = phone && !tools && widgets.length === 0;
    const allowSwitch = () => {
      const may = !phone || phoneMaySwitch(store, manifest);
      power.hidden = !may;
      if (nothingElse) card.hidden = !may;
    };
    allowSwitch();
    const stopTv = phone ? store.onTv(allowSwitch) : () => {};
    const stopLayers = phone ? store.onLayer(allowSwitch) : () => {};
    const stopClock = store.onClock((layer) => layer === id && followClock(store, id, widgets));

    return {
      element: card,
      dispose: () => {
        tools?.sync(false);
        stopTv();
        stopLayers();
        stopClock();
        if (this.phoneOpen === id) this.openApp(null);
      },
      sync: (state) => {
        // The site's author may have renamed the layer's button.
        const button = layerButton(id, manifest, state);
        heading.textContent = button.name;
        about.textContent = button.description;
        about.hidden = !button.description;
        power.checked = state.active;
        card.classList.toggle('is-active', state.active);
        if (phone) {
          const open = this.phoneOpen === id;
          card.classList.toggle('is-open', open);
          back.hidden = !open;
          body.hidden = !open;
          off.hidden = state.active;
          off.textContent = power.hidden ? t('This layer is turned on from the controller.') : t('Turn it on to see it on the table and use it here.');
          for (const part of [tabs, controls, ...(tools ? [tools.element] : [])]) part.classList.toggle('is-off', !state.active);
        } else body.hidden = !state.active;
        for (const w of widgets) {
          w.row.hidden = !isVisible(w.control, state.params) || (phone && Boolean(state.hide?.includes(w.control.id)));
          w.sync(clockParam(store, id, w.control, state.params), state.params, state.shared);
        }
        tools?.sync(state.active && (!phone || this.phoneOpen === id));
      },
    };
  }
}

/** A control's value to show: for the layer's time control, the play head while it runs (#373). */
function clockParam(store: Store, id: string, control: Control, params: Record<string, unknown>): unknown {
  return control.clock === 'hour' || control.clock === 'progress' ? store.paramsNow(id)[control.id] : params[control.id];
}

/** Moves a layer's time slider to the play head (#373). A slider under a finger stays where it is. */
function followClock(store: Store, id: string, widgets: Widget[]): void {
  const state = store.state.layers[id];
  if (!state) return;
  for (const w of widgets) {
    if (w.control.clock === 'hour' || w.control.clock === 'progress') w.sync(clockParam(store, id, w.control, state.params), state.params, state.shared);
  }
}

/** Phones get a control the layer says they may use, and by default its primary controls (#335). */
export function phoneControl(control: { phone?: boolean; tier?: string }): boolean {
  return control.phone ?? control.tier === 'primary';
}

/**
 * Whether a phone may turn this layer on or off now (#335): the table allows it
 * (`tv.phone_switch`), the layer does (`phone_switch` in layer.json), and no slideshow or tour
 * is showing. The host checks the same.
 */
export function phoneMaySwitch(store: Store, manifest: LayerManifest): boolean {
  if (store.state.site?.tv?.phone_switch === false || manifest.phone_switch === false) return false;
  return !Object.values(store.state.layers).some((layer) => layer.shown_by);
}

/** Closes the open layers other than `id`, as opening a layer from its button does. Tools kept alongside, the map at rest and a slideshow's layers (the host takes those off with it) stay. */
function closeOthers(store: Store, connection: Connection, id: string): void {
  for (const other of store.state.scene) {
    const state = store.state.layers[other];
    const manifest = state && store.manifest(state.layer);
    if (other === id || !state?.active || state.parent || state.shown_by || !manifest || isAtRest(manifest, state) || manifest.alongside) continue;
    void connection.request('layer.activate', { layer: other, active: false, cue: false }).catch(() => {});
  }
}
