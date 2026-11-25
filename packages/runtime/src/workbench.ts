// The Developer window's workbench (#358): for whoever writes layers and widgets, beside the live
// table on /dev. Widgets at every size with made-up data and their cost, the values each layer
// publishes (a click copies a binding), the controller at its real size, what passes between the
// controller, the table and the phones, and everything the rules refused.

import { DashboardView, examplePanel, SCREEN, SIZES, validatePanel } from '@mrstudio/dashboard';
import type { DashboardView as View } from '@mrstudio/dashboard';
import type { Connection, ConnectionTrace, LayerState, PanelSpec, WidgetDefinition } from '@mrstudio/sdk';

import { el } from './controls.ts';
import { panelInput } from './dashboard.ts';
import { widgets } from './registry.ts';
import type { Store } from './store.ts';

type Tab = 'widgets' | 'values' | 'stage' | 'log' | 'problems';
const TABS: [Tab, string][] = [
  ['widgets', 'Widgets'],
  ['values', 'Live values'],
  ['stage', 'Controller'],
  ['log', 'Action log'],
  ['problems', 'Problems'],
];

/** What the page complained about: warnings and errors, the newest last. Installed before anything mounts. */
const complaints: { level: 'warn' | 'error'; text: string; at: number }[] = [];
const complaintListeners = new Set<() => void>();

export function collectProblems(): void {
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
      // The runtime's own complaints name their owner in brackets: a layer, a panel, a widget.
      if (!text.startsWith('[')) return;
      if (complaints.some((c) => c.text === text)) return;
      complaints.push({ level, text, at: performance.now() });
      if (complaints.length > 200) complaints.shift();
      for (const listener of complaintListeners) listener();
    };
  }
  addEventListener('error', (event) => console.error(`[page] ${event.message}`));
}

export class Workbench {
  readonly root = el('aside', 'workbench');
  private readonly body = el('div', 'workbench-body');
  private readonly tabs = new Map<Tab, HTMLButtonElement>();
  private current: Tab = 'widgets';
  private cleanup: (() => void)[] = [];
  private readonly log: { trace: ConnectionTrace; note?: string }[] = [];
  private readonly started = performance.now();

  private readonly store: Store;
  private readonly connection: Connection;
  private readonly dash: View;

  constructor(store: Store, connection: Connection, dash: View) {
    this.store = store;
    this.connection = connection;
    this.dash = dash;
    const head = el('header', 'workbench-head');
    head.append(el('h2', '', 'Workbench'));
    const nav = el('nav', 'workbench-tabs');
    nav.setAttribute('role', 'tablist');
    for (const [tab, label] of TABS) {
      const button = el('button', '', label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.onclick = () => this.show(tab);
      this.tabs.set(tab, button);
      nav.append(button);
    }
    head.append(nav);
    this.root.append(head, this.body);

    // The log runs from the start, whichever tab is open.
    const params = new Map<string, string>();
    connection.trace((trace) => {
      if (trace.kind === 'event' && trace.method === 'state.participants') return;
      let note: string | undefined;
      if (trace.kind === 'event' && trace.method === 'state.layer') {
        // Shared values change every frame; only a change of params (a slider, an entity edit) is news.
        const { layer, state } = trace.payload as { layer: string; state: LayerState };
        const before = params.get(layer);
        const after = safeJson(state.params ?? {});
        params.set(layer, after);
        if (before === undefined || before === after) return;
        note = changedKeys(JSON.parse(before), state.params ?? {}).join(', ');
      }
      this.log.push({ trace, note });
      if (this.log.length > 300) this.log.shift();
      if (this.current === 'log') this.render();
    });
    complaintListeners.add(() => {
      this.count();
      if (this.current === 'problems') this.render();
    });
    this.show('widgets');
  }

  show(tab: Tab): void {
    this.current = tab;
    for (const [name, button] of this.tabs) button.setAttribute('aria-selected', String(name === tab));
    this.render();
  }

  private count(): void {
    const n = this.problems().length;
    this.tabs.get('problems')!.textContent = n ? `Problems (${n})` : 'Problems';
  }

  private render(): void {
    for (const fn of this.cleanup.splice(0)) fn();
    this.body.replaceChildren();
    this.body.dataset.tab = this.current;
    this.count();
    if (this.current === 'widgets') this.renderWidgets();
    else if (this.current === 'values') this.renderValues();
    else if (this.current === 'stage') this.renderStage();
    else if (this.current === 'log') this.renderLog();
    else this.renderProblems();
  }

  // ---- Widgets: each one at every size it takes, with its own made-up data and what it costs.

  private chosenWidget = 'stat';

  private renderWidgets(): void {
    const list = el('ul', 'workbench-widgets');
    const all = widgets.list();
    if (!all.some((w) => w.type === this.chosenWidget)) this.chosenWidget = all[0]?.type ?? '';
    for (const widget of all) {
      const item = el('li');
      const button = el('button', '', widget.name);
      button.type = 'button';
      if (widget.owner) button.append(el('small', '', widget.owner));
      button.setAttribute('aria-pressed', String(widget.type === this.chosenWidget));
      button.onclick = () => {
        this.chosenWidget = widget.type;
        this.render();
      };
      item.append(button);
      list.append(item);
    }
    const detail = el('section', 'workbench-widget');
    const widget = widgets.get(this.chosenWidget);
    if (widget) this.widgetDetail(detail, widget);
    this.body.append(list, detail);
  }

  private widgetDetail(root: HTMLElement, widget: WidgetDefinition): void {
    root.append(el('h3', '', widget.name), el('p', '', widget.description), el('code', 'workbench-type', `"widget": "${widget.type}"`));
    // A widget that reaches its layer (a map, a control) is shown on a layer that is on, if any.
    const on = this.store.state.scene.filter((id) => this.store.state.layers[id]?.active);
    const manifestOf = (id: string) => this.store.manifest(this.store.state.layers[id]!.layer);
    // The layer with the most to show: one with things to pick, then one with controls, then any.
    const layer = on.find((id) => manifestOf(id)?.entities?.length) ?? on.find((id) => manifestOf(id)?.controls?.length) ?? on[0];
    const manifest = layer ? this.store.manifest(this.store.state.layers[layer]!.layer) : undefined;
    const example: Record<string, unknown> = { ...(widget.example ?? {}) };
    if (widget.type === 'control' && !example.control) example.control = manifest?.controls?.[0]?.id ?? manifest?.actions?.[0]?.id ?? 'none';
    if (widget.type === 'map' && manifest?.entities?.length && !example.entities) example.entities = manifest.entities[0]!.id;

    const table = el('table', 'workbench-costs');
    table.append(row('th', ['Size', 'Grid', 'Reads', 'Budget', '']));
    const specs: PanelSpec[] = [];
    for (const size of widget.sizes) {
      const spec = examplePanel(widget, size, example);
      const props = spec.props ?? {};
      const issues = validatePanel(spec, widgets, size);
      let reads = '';
      try {
        reads = String(widget.reads(props, size));
      } catch {
        reads = '?';
      }
      table.append(row('td', [size, `${SIZES[size].cols} × ${SIZES[size].rows}`, reads, String(SIZES[size].reads), issues.map((i) => i.message).join('; ') || 'ok']));
      if (!issues.length) specs.push(spec);
    }
    root.append(table);
    root.append(el('p', 'workbench-note', `A screen holds ${SCREEN.panels} panels and ${SCREEN.reads} reads. ${layer ? `Shown on the layer '${layer}'.` : 'Turn a layer on to see the map and control widgets with its data.'}`));
    const canvas = el('div', 'workbench-canvas');
    root.append(canvas);
    const view = new DashboardView(canvas, { registry: widgets, dev: true, rotateS: 8 });
    view.setTheme(this.store.state.site.tv?.theme);
    view.setPanels(specs.map((spec) => panelInput(this.store, this.connection, layer, spec, `bench/${spec.id}`)));
    const off = this.store.onLayer(() => view.sync());
    this.cleanup.push(() => {
      off();
      view.destroy();
    });
  }

  // ---- Live values: what each layer publishes and its params; a click copies the binding.

  private renderValues(): void {
    const intro = el('p', 'workbench-note', 'Click a value to copy its binding for a panel in layer.json or a TV page.');
    const out = el('div', 'workbench-values');
    this.body.append(intro, out);
    const draw = () => {
      out.replaceChildren();
      for (const id of this.store.state.scene) {
        const state = this.store.state.layers[id];
        if (!state) continue;
        const group = el('section', 'workbench-layer');
        group.append(el('h3', '', `${id}${state.active ? '' : ' (off)'}`));
        for (const [kind, values] of [
          ['shared', state.shared ?? {}],
          ['params', state.params ?? {}],
        ] as const) {
          const entries = Object.entries(values);
          if (!entries.length) continue;
          const dl = el('dl');
          for (const [key, value] of entries) {
            const term = el('dt');
            const button = el('button', '', `${kind}.${key}`);
            button.type = 'button';
            button.title = 'Copy the binding';
            button.onclick = () => {
              const binding = JSON.stringify({ bind: `${kind}.${key}` });
              void navigator.clipboard?.writeText(binding).catch(() => undefined);
              button.dataset.copied = 'true';
              setTimeout(() => delete button.dataset.copied, 1200);
            };
            term.append(button);
            dl.append(term, el('dd', '', preview(value)));
          }
          group.append(dl);
        }
        out.append(group);
      }
      if (!out.children.length) out.append(el('p', 'workbench-note', 'No layers in the scene.'));
    };
    draw();
    // Values change every frame on a running layer; four times a second is plenty to read.
    let due = false;
    const off = this.store.onLayer(() => (due = true));
    const timer = setInterval(() => {
      if (!due || out.contains(document.activeElement)) return;
      due = false;
      draw();
    }, 250);
    this.cleanup.push(off, () => clearInterval(timer));
  }

  // ---- The controller at the size of the 46-inch screen, scaled to fit beside the live table.

  private renderStage(): void {
    const note = el('p', 'workbench-note', 'The controller as the 46-inch screen shows it (1920 × 1080), scaled to fit. Taps here reach the table on the left.');
    const box = el('div', 'workbench-screen');
    const frame = el('iframe');
    frame.title = 'Controller';
    frame.src = `/tv${location.search ? `${location.search}&` : '?'}idle=0`;
    box.append(frame);
    this.body.append(note, box);
    const fit = () => box.style.setProperty('--scale', String(box.clientWidth / 1920));
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    fit();
    this.cleanup.push(() => observer.disconnect());
  }

  // ---- What passed: this window's requests (with their round trip) and the events it got.

  private renderLog(): void {
    const tools = el('div', 'workbench-row');
    const clear = el('button', '', 'Clear');
    clear.type = 'button';
    clear.onclick = () => {
      this.log.length = 0;
      this.render();
    };
    tools.append(el('p', 'workbench-note', 'Requests from this window (→) with their round trip, and what the host sent (←): actions, picks, tool inputs, param and entity edits from any controller or phone.'), clear);
    const table = el('table', 'workbench-log');
    table.append(row('th', ['Time', '', 'What', 'Detail', 'ms']));
    for (const { trace, note } of [...this.log].reverse()) {
      const tr = row('td', [
        `${((trace.at - this.started) / 1000).toFixed(1)} s`,
        trace.kind === 'request' ? '→' : '←',
        trace.method === 'state.layer' ? 'params' : trace.method,
        note ?? summary(trace.payload),
        trace.ms === undefined ? '' : trace.ms.toFixed(0),
      ]);
      if (trace.ok === false) {
        tr.classList.add('is-error');
        tr.title = trace.error ?? '';
      }
      table.append(tr);
    }
    this.body.append(tools, table);
  }

  // ---- Problems: panels the rules refused, bindings that point at nothing, layers that failed.

  private problems(): string[] {
    const found = this.dash.issues.map((i) => `[TV] ${i.path}: ${i.message}`);
    found.push(...this.unboundBindings());
    for (const c of complaints) found.push(c.text);
    return [...new Set(found)];
  }

  /** Bindings in a layer's panels or stage to shared values or params it has not published. */
  private unboundBindings(): string[] {
    const out: string[] = [];
    for (const id of this.store.state.scene) {
      const state = this.store.state.layers[id];
      const manifest = state ? this.store.manifest(state.layer) : undefined;
      if (!state?.active || !manifest) continue;
      const stage = typeof manifest.stage === 'object' ? (manifest.stage.panels ?? []) : [];
      for (const spec of [...(manifest.panels ?? []), ...stage]) {
        for (const path of bindings(spec.props)) {
          const [kind, key] = [path.split('.')[0], path.split('.')[1]];
          const pool = kind === 'shared' ? state.shared : kind === 'params' ? state.params : undefined;
          if (pool && key !== undefined && !(key in pool)) out.push(`[${id}] panel '${spec.id}' reads ${path}, which the layer has not published (yet)`);
        }
      }
    }
    return out;
  }

  private renderProblems(): void {
    const found = this.problems();
    const list = el('ul', 'workbench-problems');
    for (const text of found) list.append(el('li', '', text));
    this.body.append(found.length ? list : el('p', 'workbench-note', 'Nothing refused, and no layer complained.'));
    const timer = setInterval(() => this.count(), 2000);
    this.cleanup.push(() => clearInterval(timer));
  }
}

function row(cell: 'td' | 'th', values: string[]): HTMLTableRowElement {
  const tr = el('tr');
  for (const value of values) tr.append(el(cell, '', value));
  return tr;
}

function bindings(props: unknown, out: string[] = []): string[] {
  if (Array.isArray(props)) for (const item of props) bindings(item, out);
  else if (props && typeof props === 'object') {
    const bind = (props as { bind?: unknown }).bind;
    if (typeof bind === 'string') out.push(bind);
    else for (const value of Object.values(props)) bindings(value, out);
  }
  return out;
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => safeJson(before[k]) !== safeJson(after[k])).map((k) => `${k} → ${preview(after[k])}`);
}

function preview(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (Array.isArray(value)) return `list of ${value.length}`;
  const text = safeJson(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function summary(payload: unknown): string {
  const text = safeJson(payload);
  return text === '{}' ? '' : text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
