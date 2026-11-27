// The dashboard canvas: mounts panels on the grid, keeps them in step with the
// state, and turns pages. Nothing here knows about a particular layer or site.

import type { PanelControls, PanelLayer, PanelSpec } from '@mrstudio/sdk';

import { resolveProps } from './bind.ts';
import type { BindSource } from './bind.ts';
import { pack } from './pack.ts';
import type { Page } from './pack.ts';
import type { WidgetDefinition, WidgetHandle, WidgetRegistry } from './registry.ts';
import { GRID, ROTATE_S } from './rules.ts';
import { panelOverflow } from './overflow.ts';
import type { Overflow } from './overflow.ts';
import { LOOK_ATTRIBUTES, themeVariables } from './theme.ts';
import { panelReads, validatePanel } from './validate.ts';
import type { Issue } from './validate.ts';
import { h, setText } from './widgets/dom.ts';
import { coreWidgets } from './widgets/index.ts';

/** A panel offered to the canvas. */
export interface PanelInput {
  /** Unique on the canvas, such as `sunlight/time`. */
  key: string;
  spec: PanelSpec;
  /** The state its bindings and `visibleWhen` read. Called on every sync. */
  source(): BindSource;
  /** Whether it should be up at all, such as "its layer is on". Default: yes. */
  active?(): boolean;
  /** For `custom` panels: the layer's own drawing function. */
  custom?: (el: HTMLElement) => { update?(): void } | void;
  /** For input widgets (#354): the panel's layer's controls. */
  controls?: PanelControls;
  /** For widgets that work with the site and the table (#355): the panel's layer. */
  layer?: PanelLayer;
  /** A widget's own words in the visitors' language (#373). */
  say?: (text: string, vars?: Record<string, string | number>) => string;
  /** Called when the panel leaves the canvas. */
  onRemove?(): void;
  /** For a site's hand-made pages: the page it is on. Requires `spec.at`. */
  page?: number;
}

/** The grid's margin, gap and smallest row, in units (see dashboard.css). */
const MARGIN_U = 3;
const GAP_U = 1.5;
// A row is at least this tall, so a tile (two rows) holds a title, a headline number and its caption (#137).
const MIN_ROW_U = 8;

export interface DashboardOptions {
  registry?: WidgetRegistry;
  /** Show refused panels and theme problems on the canvas instead of only logging them. */
  dev?: boolean;
  /** Seconds per page when there is more than one. */
  rotateS?: number;
  /** Shown when no panel is up. */
  empty?: string;
  /**
   * Called when the panels that spill out of their box change (#681): a key and what spilled,
   * empty when everything fits again. The issues are in `issues` too, with the rule `overflow`.
   */
  onOverflow?(panels: PanelOverflow[]): void;
}

/** A panel whose content spills out of its box: its key, what spilled and by how much. */
export interface PanelOverflow extends Overflow {
  key: string;
}

/** How long after a change the panels are measured, so a burst of updates is measured once. */
const MEASURE_MS = 250;

interface Mounted {
  input: PanelInput;
  widget: WidgetDefinition;
  el: HTMLElement;
  title: HTMLElement;
  handle: WidgetHandle;
}

function visible(input: PanelInput, source: BindSource): boolean {
  if (input.active && !input.active()) return false;
  const when = input.spec.visibleWhen;
  // A list means any of those values, as for controls.
  return !when || Object.entries(when).every(([key, value]) => (Array.isArray(value) ? value.includes(source.params[key]) : source.params[key] === value));
}

export class DashboardView {
  /** Everything the rules refused, for dev mode and tests. */
  issues: Issue[] = [];
  /** The layout as last computed. */
  pages: Page<PanelInput>[] = [];

  private readonly root: HTMLElement;
  private readonly registry: WidgetRegistry;
  private readonly options: DashboardOptions;
  private readonly pagesEl: HTMLElement;
  private readonly pager: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly problems: HTMLElement;
  private inputs: PanelInput[] = [];
  private mounted = new Map<string, Mounted>();
  private themeIssues: Issue[] = [];
  private panelIssues: Issue[] = [];
  private overflowIssues: Issue[] = [];
  private readonly spills = new Map<string, Overflow>();
  private overflowTold = '';
  private measureTimer: ReturnType<typeof setTimeout> | undefined;
  private current = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private rotateS: number;
  /** How many grid rows the canvas has room for. Six, unless the canvas is short. */
  private rows: number = GRID.rows;
  private readonly probe: HTMLElement;
  private readonly resize: ResizeObserver | undefined;

  constructor(root: HTMLElement, options: DashboardOptions = {}) {
    this.root = root;
    this.options = options;
    this.registry = options.registry ?? coreWidgets();
    this.rotateS = Math.min(ROTATE_S.max, Math.max(ROTATE_S.min, options.rotateS ?? ROTATE_S.default));
    root.classList.add('mrs-dash');
    root.classList.toggle('mrs-dev', Boolean(options.dev));
    this.pagesEl = h('div', 'mrs-pages');
    this.pager = h('div', 'mrs-pager');
    this.empty = h('p', 'mrs-empty', options.empty ?? '');
    this.problems = h('ul', 'mrs-issues');
    this.problems.hidden = true;
    // An invisible ruler for the unit, which CSS works out from the canvas and the screen.
    this.probe = h('div', 'mrs-probe');
    root.append(this.pagesEl, this.empty, this.pager, this.problems, this.probe);
    this.setTheme(null);
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => {
        this.measure();
        this.checkSoon();
      });
      this.resize.observe(root);
    }
  }

  /**
   * A canvas too short for six rows of the smallest readable height (the controller
   * with a layer's hero open) gets fewer rows. Panels keep their size; what does not
   * fit goes to the next page.
   */
  private measure(): void {
    const unit = this.probe.getBoundingClientRect().height;
    const height = this.root.clientHeight;
    if (!unit || !height) return;
    const [margin, gap] = [MARGIN_U * unit, GAP_U * unit];
    const rows = Math.max(1, Math.min(GRID.rows, Math.floor((height - 2 * margin + gap) / (MIN_ROW_U * unit + gap))));
    if (rows === this.rows) return;
    this.rows = rows;
    this.root.style.setProperty('--mrs-rows', String(rows));
    this.sync();
  }

  /** Applies a site's theme. Tokens that break a rule are refused and reported. */
  /** What the canvas says while it has no panels; empty says nothing (a layer is open, but has no panels). */
  setEmpty(text: string): void {
    this.empty.textContent = text;
    this.empty.hidden = this.pages.length > 0 || !text;
  }

  setTheme(theme: Record<string, unknown> | null | undefined): void {
    const { variables, issues } = themeVariables(theme);
    for (const [name, value] of Object.entries(variables)) {
      if (LOOK_ATTRIBUTES[name]) this.root.dataset[LOOK_ATTRIBUTES[name]!] = value;
      else this.root.style.setProperty(name, value);
    }
    this.themeIssues = issues;
    this.report();
  }

  /** Replaces the panels on offer. Each is checked once here; a panel that breaks a rule is never mounted. */
  setPanels(inputs: PanelInput[]): void {
    this.panelIssues = [];
    this.inputs = inputs.filter((input) => {
      const issues = validatePanel(input.spec, this.registry, input.key);
      if (input.page !== undefined && !input.spec.at) issues.push({ path: `${input.key}.at`, rule: 'grid', message: 'a panel on a page needs a position' });
      this.panelIssues.push(...issues);
      return issues.length === 0;
    });
    this.sync();
  }

  /** Brings the canvas in step with the state: which panels are up, where they sit, what they show. */
  sync(): void {
    const sources = new Map<string, BindSource>();
    const shown = this.inputs.filter((input) => {
      const source = input.source();
      sources.set(input.key, source);
      return visible(input, source);
    });
    this.pages = pack(
      shown.map((input) => ({
        item: input,
        size: input.spec.size,
        reads: panelReads(input.spec, this.registry.get(input.spec.widget)!),
        priority: input.spec.priority,
        at: input.spec.at,
        page: input.page,
      })),
      this.rows,
    );

    while (this.pagesEl.children.length < this.pages.length) this.pagesEl.append(h('div', 'mrs-page'));
    while (this.pagesEl.children.length > Math.max(1, this.pages.length)) this.pagesEl.lastElementChild!.remove();

    const keep = new Set<string>();
    this.pages.forEach((page, index) => {
      const pageEl = this.pagesEl.children[index] as HTMLElement;
      for (const placed of page.panels) {
        const input = placed.item;
        keep.add(input.key);
        let mounted = this.mounted.get(input.key);
        if (mounted && mounted.input !== input) {
          this.unmount(input.key);
          mounted = undefined;
        }
        mounted ??= this.mount(input);
        if (!mounted) continue;
        if (mounted.el.parentElement !== pageEl) pageEl.append(mounted.el);
        mounted.el.style.gridColumn = `${placed.col} / span ${placed.cols}`;
        mounted.el.style.gridRow = `${placed.row} / span ${placed.rows}`;
        setText(mounted.title, input.spec.title ?? '');
        try {
          mounted.handle.update(resolveProps(mounted.widget, input.spec.props, input.spec.size, sources.get(input.key)!));
        } catch (error) {
          console.error(`[${input.key}] panel failed`, error);
        }
      }
    });
    for (const key of [...this.mounted.keys()]) if (!keep.has(key)) this.unmount(key);

    // Panels that are up but too tall for a cramped canvas (a layer's stage open above it) leave
    // the canvas blank, not saying "turn a layer on" while one is (#357). With no text (a layer
    // is open, #342), there is nothing to say.
    this.empty.hidden = this.pages.length > 0 || shown.length > 0 || !this.empty.textContent;
    this.root.classList.toggle('mrs-no-room', shown.length > 0 && this.pages.length === 0);
    this.turn(Math.min(this.current, Math.max(0, this.pages.length - 1)));
    this.report();
    this.checkSoon();
  }

  /**
   * Measures the panels on show and reports each one whose content spills out of its box (#681).
   * Nothing on a dashboard scrolls, so what spills is lost; it is a fault in the panel, never
   * something to scroll to. Panels on pages out of sight are measured when their page is up.
   */
  checkOverflow(): PanelOverflow[] {
    for (const [key, mounted] of this.mounted) {
      const page = mounted.el.parentElement;
      // Out of sight: what was last measured for it stands until its page is up.
      if (!page || page.hidden) continue;
      try {
        mounted.handle.fit?.();
      } catch (error) {
        console.error(`[${key}] panel failed to fit`, error);
      }
      const spill = panelOverflow(mounted.el);
      mounted.el.classList.toggle('mrs-overflows', Boolean(spill));
      if (spill) this.spills.set(key, spill);
      else this.spills.delete(key);
    }
    for (const key of [...this.spills.keys()]) if (!this.mounted.has(key)) this.spills.delete(key);
    const found = [...this.spills].map(([key, spill]) => ({ key, ...spill }));
    this.overflowIssues = found.map((f) => ({ path: f.key, rule: 'overflow', message: `does not fit its panel: ${f.what} reaches ${f.px}px past the edge` }));
    const told = JSON.stringify(found);
    if (told !== this.overflowTold) {
      this.overflowTold = told;
      this.options.onOverflow?.(found);
    }
    this.report();
    return found;
  }

  private checkSoon(): void {
    if (typeof window === 'undefined') return;
    clearTimeout(this.measureTimer);
    this.measureTimer = setTimeout(() => requestAnimationFrame(() => this.checkOverflow()), MEASURE_MS);
  }

  destroy(): void {
    clearInterval(this.timer);
    clearTimeout(this.measureTimer);
    this.resize?.disconnect();
    for (const key of [...this.mounted.keys()]) this.unmount(key);
    this.root.replaceChildren();
  }

  private mount(input: PanelInput): Mounted | undefined {
    const widget = this.registry.get(input.spec.widget)!;
    const el = h('section', `mrs-panel mrs-size-${input.spec.size}`);
    el.dataset.widget = widget.type;
    el.dataset.panel = input.key;
    const title = h('h2', 'mrs-panel-title');
    const body = h('div', 'mrs-panel-body');
    el.append(title, body);
    try {
      const handle = widget.mount(body, { size: input.spec.size, custom: input.custom, controls: input.controls, layer: input.layer, say: input.say });
      const mounted = { input, widget, el, title, handle };
      this.mounted.set(input.key, mounted);
      return mounted;
    } catch (error) {
      console.error(`[${input.key}] panel failed to mount`, error);
      return undefined;
    }
  }

  private unmount(key: string): void {
    const mounted = this.mounted.get(key);
    if (!mounted) return;
    this.mounted.delete(key);
    try {
      mounted.handle.destroy?.();
      mounted.input.onRemove?.();
    } catch (error) {
      console.error(`[${key}] panel failed to clean up`, error);
    }
    mounted.el.remove();
  }

  /** Shows one page and keeps the others ready. More than one page means the pages take turns. */
  private turn(index: number): void {
    this.current = index;
    const count = this.pages.length;
    [...this.pagesEl.children].forEach((page, i) => ((page as HTMLElement).hidden = i !== index));
    this.pager.hidden = count < 2;
    if (this.pager.children.length !== count) this.pager.replaceChildren(...Array.from({ length: count }, () => h('i', '')));
    [...this.pager.children].forEach((dot, i) => dot.classList.toggle('is-current', i === index));
    this.checkSoon();
    if (count < 2) {
      clearInterval(this.timer);
      this.timer = undefined;
    } else if (!this.timer) {
      this.timer = setInterval(() => this.turn((this.current + 1) % this.pages.length), this.rotateS * 1000);
    }
  }

  private report(): void {
    const issues = [...this.themeIssues, ...this.panelIssues, ...this.overflowIssues];
    const changed = JSON.stringify(issues) !== JSON.stringify(this.issues);
    this.issues = issues;
    if (!changed) return;
    for (const issue of issues) console.warn(`dashboard: ${issue.path} ${issue.message} [${issue.rule}]`);
    this.problems.hidden = !this.options.dev || issues.length === 0;
    const lines = issues.slice(0, 6).map((issue) => h('li', '', `${issue.path} ${issue.message}`));
    if (issues.length > 6) lines.push(h('li', '', `and ${issues.length - 6} more, in the console`));
    this.problems.replaceChildren(...lines);
  }
}

