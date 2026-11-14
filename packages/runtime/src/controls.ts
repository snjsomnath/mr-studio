import { isVisible } from '@mrstudio/sdk';
import type { Connection, Control, LayerManifest, LayerState, Role } from '@mrstudio/sdk';

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
export function layerButton(id: string, manifest: LayerManifest, state?: LayerState): { name: string; description: string; icon: string | undefined; side: 'left' | 'right' } {
  const button = state?.button ?? {};
  return {
    name: button.name ?? instanceTitle(id, manifest),
    description: button.description ?? manifest.description ?? '',
    icon: button.icon ?? manifest.icon,
    side: button.side ?? 'left',
  };
}

interface Card {
  element: HTMLElement;
  sync(state: LayerState): void;
  dispose(): void;
}

/**
 * The controller: one card per layer with an on/off switch and the controls
 * generated from its manifest. The layer's panels are on the dashboard canvas.
 */
export class Controller {
  private cards = new Map<string, Card>();
  private readonly root: HTMLElement;
  private readonly store: Store;
  private readonly connection: Connection;
  private readonly role: Role;

  constructor(root: HTMLElement, store: Store, connection: Connection, role: Role) {
    this.root = root;
    this.store = store;
    this.connection = connection;
    this.role = role;
    this.arrange();
    store.onLayer((id, state) => this.cards.get(id)?.sync(state));
    store.onRemoved((id) => {
      this.cards.get(id)?.dispose();
      this.cards.delete(id);
    });
    store.onScene(() => this.arrange());
  }

  /** Lays the cards out with the top of the scene first, making cards for layers that are new. */
  private arrange(): void {
    const { store } = this;
    const elements: HTMLElement[] = [];
    for (const id of [...store.state.scene].reverse()) {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      if (!manifest) continue;
      let card = this.cards.get(id);
      if (!card) {
        card = this.card(id, manifest);
        this.cards.set(id, card);
        card.sync(state);
      }
      elements.push(card.element);
    }
    this.root.replaceChildren(...elements);
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
          w.row.hidden = !isVisible(w.control, state.params);
          w.sync(state.params[w.control.id]);
        }
        tools?.sync(state.active);
      },
    };
  }
}
