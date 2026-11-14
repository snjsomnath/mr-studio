import { isVisible } from '@mrstudio/sdk';
import type { Connection, Control, LayerManifest, LayerState, PanelHandlers, Role } from '@mrstudio/sdk';

import { baseContext, paramSender } from './layer-manager.ts';
import { layerModule } from './registry.ts';
import type { Store } from './store.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One generated control. `sync` shows a value from the host; `row` is its element. */
interface Widget {
  control: Control;
  row: HTMLElement;
  sync(value: unknown): void;
}

function formatNumber(value: number, control: Extract<Control, { type: 'range' }>): string {
  const decimals = control.step && control.step < 1 ? Math.min(3, String(control.step).split('.')[1]?.length ?? 0) : 0;
  return `${value.toFixed(decimals)}${control.unit ? ` ${control.unit}` : ''}`;
}

function widget(control: Control, send: (value: unknown) => void, act: () => void): Widget {
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

/**
 * The controller: one card per layer with an on/off switch, the controls
 * generated from its manifest, and (on the TV and in dev) the layer's panel.
 */
export class Controller {
  private cards = new Map<string, { sync(state: LayerState): void }>();
  private readonly store: Store;
  private readonly connection: Connection;
  private readonly role: Role;

  constructor(root: HTMLElement, store: Store, connection: Connection, role: Role) {
    this.store = store;
    this.connection = connection;
    this.role = role;
    for (const manifest of store.manifests) {
      const state = store.state.layers[manifest.id];
      if (!state) continue;
      root.append(this.card(manifest));
      this.cards.get(manifest.id)!.sync(state);
    }
    store.onLayer((id, state) => this.cards.get(id)?.sync(state));
  }

  private card(manifest: LayerManifest): HTMLElement {
    const { store, connection, role } = this;
    const phone = role === 'phone';
    const card = el('section', 'layer-card');
    const header = el('header');
    const title = el('div', 'layer-title');
    title.append(el('h2', undefined, manifest.name));
    if (manifest.description) title.append(el('p', undefined, manifest.description));
    header.append(title);

    const power = el('input');
    Object.assign(power, { type: 'checkbox', className: 'switch', ariaLabel: `Turn ${manifest.name} on or off` });
    power.addEventListener('change', () => {
      connection.request('layer.activate', { layer: manifest.id, active: power.checked }).catch(() => (power.checked = !power.checked));
    });
    // Phones cannot turn layers on or off, so they are not offered the switch.
    if (!phone) header.append(power);
    card.append(header);

    const body = el('div', 'layer-body');
    const send = paramSender(connection, manifest.id);
    const widgets = (manifest.controls ?? [])
      .filter((control) => !phone || control.phone)
      .map((control) =>
        widget(
          control,
          (value) => send({ [control.id]: value }),
          () => void connection.request('layer.action', { layer: manifest.id, action: control.id }).catch(() => {}),
        ),
      );
    const controls = el('div', 'controls');
    controls.append(...widgets.map((w) => w.row));

    // The layer's own panel, mounted only while the layer is on.
    const module = phone ? undefined : layerModule(manifest.id);
    const panelHost = el('div', 'layer-panel');
    let panel: { handlers: PanelHandlers; cleanups: (() => void)[] } | null = null;
    const mount = () => {
      if (!module?.panel || panel) return;
      const cleanups: (() => void)[] = [];
      const ctx = Object.assign(Object.create(baseContext(store, connection, manifest.id)), { onCleanup: (c: () => void) => cleanups.push(c) });
      try {
        panel = { handlers: module.panel(ctx, panelHost) ?? {}, cleanups };
      } catch (error) {
        console.error(`[${manifest.id}] panel failed`, error);
      }
    };
    const unmount = () => {
      if (!panel) return;
      for (const cleanup of panel.cleanups) cleanup();
      panel = null;
      panelHost.replaceChildren();
    };

    if (module?.panel) body.append(panelHost);
    body.append(controls);
    card.append(body);

    this.cards.set(manifest.id, {
      sync: (state) => {
        power.checked = state.active;
        card.classList.toggle('is-active', state.active);
        body.hidden = !state.active;
        for (const w of widgets) {
          w.row.hidden = !isVisible(w.control, state.params);
          w.sync(state.params[w.control.id]);
        }
        if (state.active) {
          mount();
          try {
            panel?.handlers.update?.();
          } catch (error) {
            console.error(`[${manifest.id}] panel failed`, error);
          }
        } else {
          unmount();
        }
      },
    });
    return card;
  }
}
