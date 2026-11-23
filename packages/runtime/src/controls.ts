import { isVisible } from '@mrstudio/sdk';
import type { Connection, Control, LayerManifest, TextControl, LayerState, PanelContext, PanelHandlers, Role, TvAbout } from '@mrstudio/sdk';

import { icon } from './editor/icons.ts';
import { baseContext, paramSender } from './layer-manager.ts';
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
    return manifest !== undefined && !isAmbient(manifest) && !state.layers[id]?.parent;
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
/** The About page on the controller screen: the site's words and its credits. */
function aboutPage(about: TvAbout, fallback: string): HTMLElement {
  const page = el('section', 'layer-card layer-open about-page');
  page.hidden = true;
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
  return page;
}

export class Controller {
  private cards = new Map<string, Card>();
  /** The side each button was last placed on. */
  private sides = new Map<string, string>();
  private readonly right: HTMLElement | undefined;
  /** Where the open layer's words and controls go on the controller screen. */
  private readonly centre: HTMLElement | undefined;
  private readonly welcome = el('div', 'layer-welcome');
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
    this.welcome.append(el('h2', undefined, site.branding.title ?? site.name), el('p', undefined, 'Choose a layer to bring it to the table.'));
    this.store = store;
    this.connection = connection;
    this.role = role;
    this.about = centre && site.tv?.about ? aboutPage(site.tv.about, site.branding.title ?? site.name) : undefined;
    this.arrange();
    store.onLayer((id, state) => {
      // Opening a layer closes the About page.
      const manifest = store.manifest(state.layer);
      if (state.active && !state.parent && this.aboutOpen && manifest && !isAmbient(manifest)) this.showAbout(false);
      this.cards.get(id)?.sync(state);
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
  private open(id: string): void {
    const { store, connection } = this;
    const mine = store.manifest(store.state.layers[id]?.layer ?? '');
    for (const other of mine?.alongside ? [] : store.state.scene) {
      const state = store.state.layers[other];
      const manifest = state && store.manifest(state.layer);
      if (other === id || !state?.active || state.parent || !manifest || isAmbient(manifest) || manifest.alongside) continue;
      void connection.request('layer.activate', { layer: other, active: false }).catch(() => {});
    }
    void connection.request('layer.activate', { layer: id, active: true }).catch(() => {});
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
      if (store.state.layers[id]?.active) void connection.request('layer.activate', { layer: id, active: false }).catch(() => {});
      else this.open(id);
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
    body.append(words);
    if (!hero.hidden) body.append(hero);
    for (const group of [primary, controls]) if (group.childElementCount > 0) body.append(group);
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
        press.setAttribute('aria-pressed', String(state.active));
        card.classList.toggle('is-active', state.active);
        body.hidden = !state.active;
        for (const w of widgets) {
          w.row.hidden = !isVisible(w.control, state.params) || Boolean(state.hide?.includes(w.control.id));
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
      return Boolean(state?.active && !state.parent && manifest && !isAmbient(manifest));
    });
  }

  /** The centre says what to do while no layer is open. */
  private rest(): void {
    if (!this.centre) return;
    // A tool kept alongside (the phones' sketch) is not a layer the visitor chose.
    const chosen = this.openLayers().filter((id) => !this.store.manifest(this.store.state.layers[id]!.layer)?.alongside);
    this.welcome.hidden = this.aboutOpen || chosen.length > 0;
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
   * Closes the open layer and the About page, so the controller goes back to its welcome.
   * Tools made to run alongside (the phones' sketch) stay on, as they do when a layer opens.
   */
  reset(): void {
    this.showAbout(false);
    for (const id of this.openLayers()) {
      if (this.store.manifest(this.store.state.layers[id]!.layer)?.alongside) continue;
      void this.connection.request('layer.activate', { layer: id, active: false }).catch(() => {});
    }
  }

  /**
   * The core's own buttons at the foot of the controller screen's rail, drawn dashed so they
   * read as actions, not layers (#75): Reset, and About when the site has `tv.about`.
   */
  actions(): HTMLElement {
    const box = el('div', 'rail-actions');
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
    action('Reset', 'reset', () => this.reset());
    if (this.about) {
      this.aboutButton = action('About', 'info', () => {
        const show = !this.aboutOpen;
        if (show) this.reset();
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
