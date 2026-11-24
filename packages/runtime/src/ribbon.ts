// The table's ribbons (#78): the projector's blank space around the model, used for a
// glanceable strip of numbers, small keys or the join QR. Rules in docs/contracts/present.md, Ribbon.
//
// Where: the free band on each side between the model and the edge of the image, worked out
// from where the model lands (the calibration) and the table's size in cm. Which sides:
// `table.ribbons`, defaulting to the front edge (`table.front`) on auto. What: the open layer's
// ribbon panels, otherwise the home ribbon (the join QR). Every ribbon faces its own edge.

import { LOOK_ATTRIBUTES, resolveProps, themeVariables, validateRibbon } from '@mrstudio/dashboard';
import type { PanelInput, WidgetDefinition, WidgetHandle } from '@mrstudio/dashboard';
import type { Connection } from '@mrstudio/sdk';

import { isAmbient } from './controls.ts';
import { panelInput } from './dashboard.ts';
import { qrSvg } from './join.ts';
import { t } from './i18n.ts';
import { widgets, withTeamWidgets } from './registry.ts';
import { ribbonBands } from './ribbon-bands.ts';
import type { Band, Side } from './ribbon-bands.ts';
import type { Store } from './store.ts';

/** Where the model is in the host's pixels, and the host's size. */
type Measured = { footprint: [number, number][]; surface: { width: number; height: number } };

/** What a ribbon shows. */
type Content = { kind: 'layer'; instance: string; inputs: PanelInput[] } | { kind: 'join'; url: string; code: string } | null;

interface Strip {
  el: HTMLElement;
  inner: HTMLElement;
  mounted: { input: PanelInput; widget: WidgetDefinition; handle: WidgetHandle; title: HTMLElement }[];
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Draws the ribbons on a surface. `host` holds them; `measure` says where the model is in the
 * host's pixels and how big the host is. On the projected table the host is the table surface
 * itself; in the editor it is the frame around the map, and the ribbons are a preview.
 */
export class Ribbons {
  private readonly registry = widgets;
  private strips = new Map<Side, Strip>();
  private bands: Band[] = [];
  private content: Content = null;
  private contentKey = '';
  /** Layers in the order they were turned on, the last most recent. */
  private opened: string[] = [];
  private readonly inputs = new Map<string, PanelInput[]>();
  private queued = false;

  private readonly host: HTMLElement;
  private readonly store: Store;
  private readonly connection: Connection;
  private readonly measure: () => Measured | null;
  private readonly preview: boolean;

  constructor(host: HTMLElement, store: Store, connection: Connection, measure: () => Measured | null, preview = false) {
    this.host = host;
    this.store = store;
    this.connection = connection;
    this.measure = measure;
    this.preview = preview;
    for (const id of store.state.scene) if (store.state.layers[id]?.active) this.opened.push(id);
    store.onLayer((id, state, previous) => {
      if (state.active && !previous?.active) this.opened = [...this.opened.filter((o) => o !== id), id];
      if (!state.active) this.opened = this.opened.filter((o) => o !== id);
      this.queue();
    });
    store.onScene(() => {
      this.opened = this.opened.filter((id) => store.state.scene.includes(id));
      this.queue();
    });
    store.onParticipants(() => this.queue());
    store.onTv(() => this.layout());
    // The visitors' language changed (#80): every strip draws again in it.
    window.addEventListener('mrs-language', () => {
      this.inputs.clear();
      this.contentKey = '-';
      this.queue();
    });
    this.layout();
  }

  /** Works out the bands again: call when the surface or the calibration changed. */
  layout(): void {
    const table = this.store.state.site.table;
    const measured = this.measure();
    this.bands = table && measured ? ribbonBands({ ...measured, table, preview: this.preview }) : [];
    for (const [side, strip] of this.strips) {
      if (!this.bands.some((band) => band.side === side)) {
        this.unmount(strip);
        strip.el.remove();
        this.strips.delete(side);
      }
    }
    for (const band of this.bands) {
      let strip = this.strips.get(band.side);
      if (!strip) {
        const outer = el('div', 'table-ribbon');
        outer.dataset.side = band.side;
        const inner = el('div', 'table-ribbon-inner mrs-dash');
        outer.append(inner);
        this.host.append(outer);
        strip = { el: outer, inner, mounted: [] };
        this.strips.set(band.side, strip);
        this.contentKey = '';
      }
      this.place(strip, band);
    }
    this.sync();
  }

  private place(strip: Strip, band: Band): void {
    const { el: outer, inner } = strip;
    const { left, top, width, height } = band.rect;
    outer.classList.toggle('is-preview', this.preview);
    outer.classList.toggle('is-front', band.front);
    Object.assign(outer.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    // The content is laid out along the edge, then turned to face it.
    const sideways = band.side === 'left' || band.side === 'right';
    const [length, thick] = sideways ? [height, width] : [width, height];
    Object.assign(inner.style, { width: `${length}px`, height: `${thick}px`, transform: `translate(-50%, -50%) rotate(${band.turn}deg)` });
    // The unit the dashboard's type scale is built on: a tile's title, number and padding fill the band.
    inner.style.setProperty('--mrs-u', `${thick / 19}px`);
    const { variables } = themeVariables(this.store.state.site.tv?.theme);
    for (const [name, value] of Object.entries(variables)) {
      if (LOOK_ATTRIBUTES[name]) inner.dataset[LOOK_ATTRIBUTES[name]!] = value;
      else inner.style.setProperty(name, value);
    }
  }

  private queue(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.sync();
    });
  }

  /**
   * The open layer's ribbon panels (the one turned on last that has some), otherwise the home
   * ribbon while the controller is at home: no layer open but the map at rest and tools kept
   * alongside, such as the phones' sketch (the same rule as the controller's home screen, #74).
   */
  private pick(): Content {
    const { store } = this;
    const open = this.opened.filter((id) => {
      const manifest = store.manifest(store.state.layers[id]?.layer ?? '');
      return manifest && !isAmbient(manifest);
    });
    for (const id of [...open].reverse()) {
      const inputs = this.layerInputs(id);
      if (inputs.length) return { kind: 'layer', instance: id, inputs };
    }
    const chosen = open.some((id) => {
      const state = store.state.layers[id]!;
      return !state.parent && !state.shown_by && !store.manifest(state.layer)?.alongside;
    });
    if (chosen) return null;
    const { join_url: url, code } = store.state.session;
    return url ? { kind: 'join', url, code } : null;
  }

  private layerInputs(id: string): PanelInput[] {
    const manifest = this.store.manifest(this.store.state.layers[id]?.layer ?? '');
    const specs = manifest ? withTeamWidgets(manifest.id, manifest.panels?.filter((spec) => spec.ribbon) ?? []) : [];
    if (!specs.length) return [];
    const cached = this.inputs.get(id);
    if (cached) return cached;
    const issues = validateRibbon(specs, this.registry);
    for (const issue of issues) console.warn(`[${manifest!.id}] ribbon ${issue.path} ${issue.message}`);
    const inputs = issues.length ? [] : specs.map((spec) => panelInput(this.store, this.connection, id, spec, `${id}/ribbon/${spec.id}`, undefined, false));
    this.inputs.set(id, inputs);
    return inputs;
  }

  /** Brings every strip in step with what should show and the values it shows. */
  private sync(): void {
    const content = this.pick();
    const key = !content ? '' : content.kind === 'join' ? `join:${content.url}:${content.code}` : `layer:${content.instance}`;
    if (key !== this.contentKey) {
      this.contentKey = key;
      this.content = content;
      for (const strip of this.strips.values()) this.fill(strip);
    }
    for (const strip of this.strips.values()) this.update(strip);
    for (const strip of this.strips.values()) strip.el.hidden = !this.content || (this.content.kind === 'layer' && strip.mounted.every((m) => m.title.parentElement!.hidden));
  }

  private fill(strip: Strip): void {
    this.unmount(strip);
    const { inner } = strip;
    inner.replaceChildren();
    const content = this.content;
    inner.dataset.content = content?.kind ?? '';
    if (!content) return;
    if (content.kind === 'join') {
      const qr = el('div', 'table-ribbon-qr');
      qr.append(qrSvg(content.url));
      const words = el('div', 'table-ribbon-join');
      words.append(el('p', 'mrs-panel-title', t('Join from your phone')), el('p', 'table-ribbon-code', content.code));
      inner.append(qr, words);
      return;
    }
    for (const input of content.inputs) {
      const widget = this.registry.get(input.spec.widget)!;
      const panel = el('section', `mrs-panel mrs-size-${input.spec.size}`);
      panel.dataset.widget = widget.type;
      const title = el('h2', 'mrs-panel-title', input.spec.title ?? '');
      const body = el('div', 'mrs-panel-body');
      panel.append(title, body);
      inner.append(panel);
      try {
        const handle = widget.mount(body, { size: input.spec.size, custom: input.custom, controls: input.controls });
        strip.mounted.push({ input, widget, handle, title });
      } catch (error) {
        console.error(`[${input.key}] ribbon panel failed to mount`, error);
        panel.remove();
      }
    }
  }

  private update(strip: Strip): void {
    for (const { input, widget, handle, title } of strip.mounted) {
      const source = input.source();
      const when = input.spec.visibleWhen;
      const panel = title.parentElement!;
      panel.hidden = (input.active && !input.active()) || (when ? !Object.entries(when).every(([k, v]) => (Array.isArray(v) ? v.includes(source.params[k]) : source.params[k] === v)) : false);
      if (panel.hidden) continue;
      try {
        handle.update(resolveProps(widget, input.spec.props, input.spec.size, source));
      } catch (error) {
        console.error(`[${input.key}] ribbon panel failed`, error);
      }
    }
  }

  private unmount(strip: Strip): void {
    for (const { input, handle } of strip.mounted) {
      try {
        handle.destroy?.();
        input.onRemove?.();
      } catch (error) {
        console.error(`[${input.key}] ribbon panel failed to clean up`, error);
      }
    }
    strip.mounted = [];
  }
}
