import { isVisible } from '@mrstudio/sdk';
import type { Connection, Control, LayerManifest, LayerState, Role } from '@mrstudio/sdk';

import { icon } from './editor/icons.ts';
import { paramSender } from './layer-manager.ts';
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
    case 'color':
    case 'text': {
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

/** The side a site's layer buttons default to: `tv.rail`, unless that hides them. */
export function defaultSide(store: Store): 'left' | 'right' {
  return store.state.site.tv?.rail === 'right' ? 'right' : 'left';
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
export class Controller {
  private cards = new Map<string, Card>();
  /** The side each button was last placed on. */
  private sides = new Map<string, string>();
  private readonly right: HTMLElement | undefined;
  /** Where the open layer's words and controls go on the controller screen. */
  private readonly centre: HTMLElement | undefined;
  private readonly welcome = el('div', 'layer-welcome');
  private readonly root: HTMLElement;
  private readonly store: Store;
  private readonly connection: Connection;
  private readonly role: Role;

  constructor(root: HTMLElement, store: Store, connection: Connection, role: Role, right?: HTMLElement, centre?: HTMLElement) {
    this.root = root;
    this.right = right;
    this.centre = centre;
    const { site } = store.state;
    this.welcome.append(el('h2', undefined, site.branding.title ?? site.name), el('p', undefined, 'Choose a layer on either side to bring it to the table.'));
    this.store = store;
    this.connection = connection;
    this.role = role;
    this.arrange();
    store.onLayer((id, state) => {
      this.cards.get(id)?.sync(state);
      // A button moves when its author changes its side.
      if (this.right && this.sides.has(id) && this.sides.get(id) !== this.sideOf(id)) this.arrange();
    });
    store.onRemoved((id) => {
      this.cards.get(id)?.dispose();
      this.cards.delete(id);
    });
    store.onScene(() => this.arrange());
  }

  private sideOf(id: string): 'left' | 'right' {
    const state = this.store.state.layers[id];
    const manifest = state && this.store.manifest(state.layer);
    return manifest ? layerButton(id, manifest, state, defaultSide(this.store)).side : 'left';
  }

  /** Lays the cards out with the top of the scene first, making cards for layers that are new. */
  private arrange(): void {
    const { store } = this;
    const elements: HTMLElement[] = [];
    const onRight: HTMLElement[] = [];
    for (const id of [...store.state.scene].reverse()) {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      if (!manifest) continue;
      // The map at rest and a layer's items have no button: items come on with their layer.
      if (this.right && (isAmbient(manifest) || state.parent)) continue;
      let card = this.cards.get(id);
      if (!card) {
        card = this.right ? this.button(id, manifest) : this.card(id, manifest);
        this.cards.set(id, card);
        card.sync(state);
      }
      const side = this.right ? this.sideOf(id) : 'left';
      this.sides.set(id, side);
      (side === 'right' ? onRight : elements).push(card.element);
    }
    this.root.replaceChildren(...elements);
    this.right?.replaceChildren(...onRight);
    if (this.centre) {
      // The layer that was opened comes first; a tool kept alongside it follows.
      const ids = [...store.state.scene].reverse();
      const kept = (id: string) => Boolean(store.manifest(store.state.layers[id]?.layer ?? '')?.alongside);
      const bodies = [...ids.filter((id) => !kept(id)), ...ids.filter(kept)].flatMap((id) => this.cards.get(id)?.body ?? []);
      this.centre.replaceChildren(this.welcome, ...bodies);
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
    const controls = el('div', 'controls');
    controls.append(...widgets.map((w) => w.row));
    body.append(words);
    if (widgets.length > 0) body.append(controls);

    let shown: string | undefined;
    return {
      element: card,
      body,
      dispose: () => body.remove(),
      sync: (state) => {
        const button = layerButton(id, manifest, state, defaultSide(store));
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
        this.rest();
      },
    };
  }

  /** The centre says what to do while no layer is open. */
  private rest(): void {
    if (!this.centre) return;
    const { store } = this;
    const open = store.state.scene.some((id) => {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      return Boolean(state?.active && manifest && !isAmbient(manifest));
    });
    this.welcome.hidden = open;
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
