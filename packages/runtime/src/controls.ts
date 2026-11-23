import { isVisible } from '@mrstudio/sdk';
import type { Connection, Control, LayerManifest, LegendRow, TextControl, LayerState, PanelContext, PanelHandlers, Role, TvAbout } from '@mrstudio/sdk';

import { AttractLoop, effectOf } from './attract.ts';
import { icon } from './editor/icons.ts';
import { baseContext, isAtRest, paramSender } from './layer-manager.ts';

export { isAtRest };
import { layerModule } from './registry.ts';
import { PHONE_SEND_INTERVAL, toolSection } from './phone-tools.ts';
import type { Store } from './store.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One generated control. `sync` shows a value from the host; `row` is its element. */
export interface Widget {
  control: Control;
  row: HTMLElement;
  sync(value: unknown): void;
}

function formatNumber(value: number, control: Extract<Control, { type: 'range' }>): string {
  const decimals = control.step && control.step < 1 ? Math.min(3, String(control.step).split('.')[1]?.length ?? 0) : 0;
  return `${value.toFixed(decimals)}${control.unit ? ` ${control.unit}` : ''}`;
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

/** Four or more choices are laid out in rows where space is tight (the editor's inspector): 2 × 2 for four, three across for more. */
function columns(group: HTMLElement, count: number) {
  if (count >= 4) group.dataset.columns = count === 4 ? '2' : '3';
}

export function widget(control: Control, send: (value: unknown) => void, act: () => void): Widget {
  const row = el('div', `control control-${control.type}`);
  const id = `c-${Math.random().toString(36).slice(2)}`;
  const label = el('label', 'control-label', control.label);
  label.htmlFor = id;
  let sync: (value: unknown) => void = () => {};

  switch (control.type) {
    case 'range': {
      const input = el('input');
      const readout = el('output', 'control-value');
      Object.assign(input, { id, type: 'range', min: String(control.min), max: String(control.max), step: String(control.step ?? 'any') });
      // While a finger is on the slider the host's echoes must not move it.
      let held = false;
      input.addEventListener('pointerdown', () => (held = true));
      for (const type of ['pointerup', 'pointercancel', 'blur']) input.addEventListener(type, () => (held = false));
      input.addEventListener('input', () => {
        readout.textContent = formatNumber(input.valueAsNumber, control);
        send(input.valueAsNumber);
      });
      sync = (value) => {
        if (held || typeof value !== 'number') return;
        input.value = String(value);
        readout.textContent = formatNumber(value, control);
      };
      const head = el('div', 'control-head');
      head.append(label, readout);
      row.append(head, input);
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
        input.setAttribute('aria-label', `Another ${control.label.toLowerCase()}`);
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
      button.addEventListener('click', act);
      row.append(button);
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
    name: button.name ?? instanceTitle(id, manifest),
    description: button.description ?? manifest.description ?? '',
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
export function railButtons(store: Store): RailButton[] {
  const { state } = store;
  const scene = [...state.scene].reverse();
  const ids = scene.filter((id) => {
    const manifest = store.manifest(state.layers[id]?.layer ?? '');
    // A layer's items have no button: they come on with their layer.
    return manifest !== undefined && !isAtRest(manifest, state.layers[id]) && !state.layers[id]?.parent;
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
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen().catch(() => {});
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
  page.append(el('h2', 'layer-open-name', about.title ?? fallback));
  if (about.text) page.append(el('p', 'layer-about', about.text));
  const credits = (about.credits ?? []).filter((c) => c && typeof c.name === 'string');
  if (credits.length > 0) {
    const list = el('dl', 'about-credits');
    for (const credit of credits) {
      const item = el('div', 'about-credit');
      item.append(el('dt', undefined, credit.role ?? ''), el('dd', undefined, credit.name));
      if (credit.note) item.append(el('dd', 'about-note', credit.note));
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
  const previous = button('Previous step', 'previous', () => step('previous'));
  const play = button('Play the steps', 'play', () => {
    const playing = store.state.layers[id]?.step?.playing ?? false;
    void connection.request('layer.play', { layer: id, playing: !playing }).catch(() => {});
  });
  const next = button('Next step', 'next', () => step('next'));
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
      const shownName = shownState ? (shownState.button?.name ?? store.manifest(shownState.layer)?.name ?? '') : '';
      count.textContent = sequence ? `${Math.min(at.index + 1, at.count)} of ${at.count}` : `${at.index} of ${at.count} shown`;
      title.textContent = at.title ?? shownName;
      title.hidden = !title.textContent;
      line.textContent = at.description ?? '';
      line.hidden = !line.textContent;
      source.textContent = at.source ? `Source: ${at.source}` : '';
      source.hidden = !at.source;
      // Sub-steps: the slideshow mirrors the shown layer's; any other layer has its own.
      const sub = sequence ? at.sub : { index: at.index, count: at.count };
      const names = (sequence ? shownState?.step?.titles : at.titles) ?? [];
      subs.hidden = !sub || sub.count === 0 || (sequence === false && names.length === 0);
      if (sub && sub.count > 0) {
        const items = Array.from({ length: sub.count }, (_, i) => {
          const item = el('li', 'step-sub', names[i] ?? String(i + 1));
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
        play.title = at.playing ? 'Pause the steps' : 'Play the steps';
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
  zone.setAttribute('aria-label', 'Legend');
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
          item.append(swatch, el('span', 'legend-label', row.label));
          return item;
        }),
      );
      return follows;
    },
  };
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
  zone.setAttribute('aria-label', 'Sounds');
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
          words.append(el('b', undefined, row.label), el('small', undefined, row.playing ? 'Playing' : 'Tap to play'));
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
    if (centre) {
      const credits = (site.tv?.about?.credits ?? []).map((c) => (c.role ? `${c.role}: ${c.name}` : c.name)).join('  ·  ');
      this.attract = new AttractLoop(site.branding.title ?? site.name, () => this.attractStops(), { stepS: site.tv?.attract_s, credits: credits || undefined, welcome: site.branding.welcome ?? undefined });
      this.welcome = this.attract.element;
    } else {
      this.welcome = el('div', 'layer-welcome');
      this.welcome.append(el('h2', undefined, site.branding.title ?? site.name), el('p', undefined, site.branding.welcome ?? 'Choose a layer to bring it to the table.'));
    }
    this.connection = connection;
    this.role = role;
    this.about = centre && site.tv?.about ? aboutPage(site.tv.about, site.branding.title ?? site.name, site.branding.logo) : undefined;
    this.arrange();
    this.creditMaps();
    if (centre) {
      this.listenForKeys();
      this.idleReset();
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
      this.centre.replaceChildren(this.welcome, ...(this.about ? [this.about] : []), ...bodies);
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
    for (const other of mine?.alongside ? [] : store.state.scene) {
      const state = store.state.layers[other];
      const manifest = state && store.manifest(state.layer);
      // Layers a slideshow shows go off with it; the host does that.
      if (other === id || !state?.active || state.parent || state.shown_by || !manifest || isAtRest(manifest, state) || manifest.alongside) continue;
      void connection.request('layer.activate', { layer: other, active: false }).catch(() => {});
    }
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
    press.append(badge, name);
    press.addEventListener('click', () => {
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
    const send = paramSender(connection, id);
    const widgets = (manifest.controls ?? []).map((control) =>
      widget(
        control,
        (value) => send({ [control.id]: value }),
        () => void connection.request('layer.action', { layer: id, action: control.id }).catch(() => {}),
      ),
    );
    // The layer's hero, its one large way in, sits under its name (#137).
    const hero = el('div', 'layer-hero');
    hero.hidden = true;
    const heroCleanups: (() => void)[] = [];
    let heroHandlers: PanelHandlers | void = undefined;
    const module = layerModule(manifest.id);
    if (module?.hero) {
      const ctx: PanelContext = Object.assign(Object.create(baseContext(store, connection, id)), {
        panel: 'hero',
        onCleanup: (cleanup: () => void) => heroCleanups.push(cleanup),
      });
      try {
        heroHandlers = module.hero(ctx, hero);
        hero.hidden = false;
      } catch (error) {
        console.error(`[${id}] hero`, error);
      }
    }
    // Controls by tier: primary ones large and first, then the rest in a row, then "More settings", closed.
    const tierOf = (w: Widget) => w.control.tier ?? 'secondary';
    const primary = el('div', 'controls controls-primary');
    const controls = el('div', 'controls');
    const more = el('details', 'controls-more');
    const moreRows = el('div', 'controls');
    more.append(el('summary', undefined, 'More settings'), moreRows);
    primary.append(...widgets.filter((w) => tierOf(w) === 'primary').map((w) => w.row));
    controls.append(...widgets.filter((w) => tierOf(w) === 'secondary').map((w) => w.row));
    moreRows.append(...widgets.filter((w) => tierOf(w) === 'more').map((w) => w.row));
    // A layer with steps (a slideshow, or a map revealed part by part) gets ◀ ▶, play and the info strip (#43, #76).
    const strip = stepStrip(id, store, connection);
    const legend = legendZone(id, store);
    const sounds = soundZone(id, store, connection);
    body.append(words, strip.element);
    if (!hero.hidden) body.append(hero);
    for (const group of [primary, controls]) if (group.childElementCount > 0) body.append(group);
    body.append(legend.element, sounds.element);
    // "More settings" closes the primary row when there is one, so it costs no height of its own.
    if (moreRows.childElementCount > 0) (primary.childElementCount > 0 ? primary : body).append(more);

    let shown: string | undefined;
    return {
      element: card,
      body,
      dispose: () => {
        for (const cleanup of heroCleanups) cleanup();
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
        body.hidden = !open;
        strip.sync(state);
        strip.element.classList.toggle('legend-follows', legend.sync(state));
        sounds.sync(state);
        // A slideshow made of layers is driven by its steps: its own slide controls step aside.
        const stepped = Boolean(manifest.sequence && state.step);
        for (const w of widgets) {
          w.row.hidden = stepped || !isVisible(w.control, state.params) || Boolean(state.hide?.includes(w.control.id));
          w.sync(state.params[w.control.id]);
        }
        more.hidden = ![...moreRows.children].some((row) => !(row as HTMLElement).hidden);
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
    this.welcome.hidden = this.aboutOpen || chosen.length > 0;
    if (this.attract) this.attract.active = !this.welcome.hidden;
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
    line.textContent = credits.size > 0 ? `Maps and data: ${[...credits].join(' · ')}` : '';
    line.hidden = credits.size === 0;
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
    if (operator) box.append(el('div', 'rail-group', 'Map controls'));
    action(operator ? 'Reset view' : 'Reset', 'reset', () => this.reset());
    if (operator) {
      action('Full screen', 'fullscreen', () => fullScreen());
      // Calibrate opens the projector calibration on the table, and closes it again.
      let calibrating = false;
      const calibrate = action('Calibrate', 'overscan', () => {
        void this.connection.request('calibration.mode', { active: !calibrating }).catch(() => {});
      });
      calibrate.setAttribute('aria-pressed', 'false');
      this.connection.on('calibration.mode', (p: { active: boolean }) => {
        calibrating = Boolean(p.active);
        calibrate.setAttribute('aria-pressed', String(calibrating));
      });
    }
    if (this.about) {
      if (operator) box.append(el('div', 'rail-group', 'About'));
      this.aboutButton = action('Credits', 'people', () => {
        const show = !this.aboutOpen;
        if (show) this.closeLayers();
        this.showAbout(show);
      });
      this.aboutButton.setAttribute('aria-pressed', 'false');
    }
    return box;
  }

  private card(id: string, manifest: LayerManifest): Card {
    const { store, connection, role } = this;
    const phone = role === 'phone';
    const name = instanceTitle(id, manifest);
    const card = el('section', 'layer-card');
    const header = el('header');
    const title = el('div', 'layer-title');
    const heading = el('h2', undefined, name);
    const about = el('p', undefined, manifest.description ?? '');
    about.hidden = !manifest.description;
    title.append(heading, about);
    header.append(title);

    const power = el('input');
    Object.assign(power, { type: 'checkbox', className: 'switch', ariaLabel: `Turn ${name} on or off` });
    power.addEventListener('change', () => {
      connection.request('layer.activate', { layer: id, active: power.checked }).catch(() => (power.checked = !power.checked));
    });
    // Phones cannot turn layers on or off, so they are not offered the switch.
    if (!phone) header.append(power);
    card.append(header);

    const body = el('div', 'layer-body');
    const send = paramSender(connection, id, { minInterval: phone ? PHONE_SEND_INTERVAL : 0 });
    const widgets = (manifest.controls ?? [])
      .filter((control) => !phone || control.phone)
      .map((control) =>
        widget(
          control,
          (value) => send({ [control.id]: value }),
          () => void connection.request('layer.action', { layer: id, action: control.id }).catch(() => {}),
        ),
      );
    const controls = el('div', 'controls');
    controls.append(...widgets.map((w) => w.row));

    // On a phone, the layer's tools: a small map of the table to tap and draw on.
    const tools = phone && manifest.tools?.length ? toolSection(id, manifest, store, connection) : null;
    if (tools) body.append(tools.element);
    if (widgets.length > 0) body.append(controls);
    card.append(body);
    // A layer with nothing a phone can use is left off the phone.
    if (phone && !tools && widgets.length === 0) card.hidden = true;

    return {
      element: card,
      dispose: () => tools?.sync(false),
      sync: (state) => {
        // The site's author may have renamed the layer's button.
        const button = layerButton(id, manifest, state);
        heading.textContent = button.name;
        about.textContent = button.description;
        about.hidden = !button.description;
        power.checked = state.active;
        card.classList.toggle('is-active', state.active);
        body.hidden = !state.active;
        for (const w of widgets) {
          w.row.hidden = !isVisible(w.control, state.params) || (phone && Boolean(state.hide?.includes(w.control.id)));
          w.sync(state.params[w.control.id]);
        }
        tools?.sync(state.active);
      },
    };
  }
}
