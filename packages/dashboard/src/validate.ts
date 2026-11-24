// Checks panels and pages against the rules. Pure functions with no DOM, so the
// same checks run in tests, on the TV before a panel is shown, and in an editor
// before a drop is accepted.

import type { Binding, PanelSpec } from '@mrstudio/sdk';

import type { PropSpec, WidgetDefinition, WidgetRegistry } from './registry.ts';
import { DATA_SLOTS, GRID, PANEL_SIZES, RIBBON, SCREEN, SIZES, TEXT } from './rules.ts';

export interface Issue {
  /** Where: `panels.time.props.caption`. */
  path: string;
  /** Which rule: `size`, `budget`, `text`, `schema`, `binding`, `grid`, `screen`. */
  rule: 'size' | 'budget' | 'text' | 'schema' | 'binding' | 'grid' | 'screen';
  message: string;
}

const BIND_PATH = /^(params|shared|site)\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

export function isBinding(value: unknown): value is Binding {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Binding).bind === 'string';
}

/** The most items a list prop may hold for a panel of this size. */
export function listLimit(widget: WidgetDefinition, prop: string, spec: Extract<PropSpec, { kind: 'list' }>, size: PanelSpec['size']): number {
  return Math.min(spec.max, widget.listMax?.(prop, size) ?? spec.max);
}

function checkProp(path: string, spec: PropSpec, value: unknown, limit: number | undefined, issues: Issue[]): void {
  const fail = (rule: Issue['rule'], message: string) => issues.push({ path, rule, message });
  if (isBinding(value)) {
    if (!spec.bindable) fail('binding', 'cannot be bound to a live value');
    else if (!BIND_PATH.test(value.bind)) fail('binding', `'${value.bind}' is not params.<id>, shared.<key> or site.<field>`);
    return;
  }
  switch (spec.kind) {
    case 'text':
      if (typeof value !== 'string') fail('schema', 'must be text');
      else if ([...value].length > spec.max) fail('text', `is ${[...value].length} characters, the limit is ${spec.max}`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('schema', 'must be a number');
      else if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) fail('schema', `must be between ${spec.min ?? '-∞'} and ${spec.max ?? '∞'}`);
      break;
    case 'value':
      if (typeof value === 'string') {
        if ([...value].length > TEXT.value) fail('text', `is ${[...value].length} characters, the limit is ${TEXT.value}`);
      } else if (typeof value !== 'number' || !Number.isFinite(value)) fail('schema', 'must be a number or short text');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('schema', 'must be true or false');
      break;
    case 'enum':
      if (!spec.options.includes(value as string)) fail('schema', `must be one of ${spec.options.join(', ')}`);
      break;
    case 'colormap':
      if (typeof value !== 'string' && !Array.isArray((value as { stops?: unknown } | null)?.stops)) fail('schema', 'must be the name of a colour ramp, or a ramp with stops');
      break;
    case 'slot':
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > DATA_SLOTS) fail('schema', `must be a data colour slot, 1 to ${DATA_SLOTS}`);
      break;
    case 'numbers':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'number' || !Number.isFinite(v))) fail('schema', 'must be a list of numbers');
      else if (value.length > spec.maxLength) fail('budget', `has ${value.length} points, the limit is ${spec.maxLength}`);
      break;
    case 'list': {
      if (!Array.isArray(value)) {
        fail('schema', 'must be a list');
        break;
      }
      const max = limit ?? spec.max;
      if (value.length > max) fail('budget', `has ${value.length} items, a panel of this size shows at most ${max}`);
      value.forEach((item, index) => checkProps(`${path}.${index}`, spec.item, item, issues));
      break;
    }
  }
}

function checkProps(path: string, specs: Record<string, PropSpec>, props: unknown, issues: Issue[], limits?: (prop: string) => number | undefined): void {
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    issues.push({ path, rule: 'schema', message: 'must be an object' });
    return;
  }
  const record = props as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!specs[key]) issues.push({ path: `${path}.${key}`, rule: 'schema', message: `is not a prop of this widget (it has ${Object.keys(specs).join(', ')})` });
  }
  for (const [key, spec] of Object.entries(specs)) {
    const value = record[key];
    if (value === undefined) {
      if (spec.required) issues.push({ path: `${path}.${key}`, rule: 'schema', message: 'is required' });
      continue;
    }
    checkProp(`${path}.${key}`, spec, value, limits?.(key), issues);
  }
}

/**
 * What a panel costs. A bound list counts as full, because the rules have to hold
 * for whatever data arrives.
 */
export function panelReads(spec: PanelSpec, widget: WidgetDefinition): number {
  const props: Record<string, unknown> = { ...spec.props };
  for (const [key, prop] of Object.entries(widget.props)) {
    if (prop.kind === 'list' && isBinding(props[key])) props[key] = new Array(listLimit(widget, key, prop, spec.size)).fill({});
  }
  return widget.reads(props, spec.size);
}

/** Checks one panel on its own: the widget, its size, its props and its budget. */
export function validatePanel(spec: PanelSpec, registry: WidgetRegistry, path = `panels.${spec?.id ?? '?'}`): Issue[] {
  const issues: Issue[] = [];
  if (typeof spec !== 'object' || spec === null) return [{ path, rule: 'schema', message: 'must be an object' }];
  if (typeof spec.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(spec.id)) issues.push({ path: `${path}.id`, rule: 'schema', message: 'must be lower-case letters, digits and dashes' });
  const widget = registry.get(spec.widget);
  if (!widget) {
    issues.push({ path: `${path}.widget`, rule: 'schema', message: `'${spec.widget}' is not a registered widget` });
    return issues;
  }
  if (!PANEL_SIZES.includes(spec.size)) {
    issues.push({ path: `${path}.size`, rule: 'size', message: `'${spec.size}' is not a panel size (${PANEL_SIZES.join(', ')})` });
    return issues;
  }
  if (!widget.sizes.includes(spec.size)) issues.push({ path: `${path}.size`, rule: 'size', message: `${widget.name} does not come in ${spec.size} (it comes in ${widget.sizes.join(', ')})` });

  if (typeof spec.title !== 'string' || spec.title.trim() === '') issues.push({ path: `${path}.title`, rule: 'text', message: 'every panel needs a title' });
  else if ([...spec.title].length > TEXT.title) issues.push({ path: `${path}.title`, rule: 'text', message: `is ${[...spec.title].length} characters, the limit is ${TEXT.title}` });

  for (const key of Object.keys(spec)) {
    if (!['id', 'widget', 'size', 'title', 'props', 'visibleWhen', 'priority', 'at', 'layer', 'ribbon'].includes(key)) issues.push({ path: `${path}.${key}`, rule: 'schema', message: 'is not a panel field' });
  }
  const before = issues.length;
  checkProps(`${path}.props`, widget.props, spec.props ?? {}, issues, (prop) => {
    const p = widget.props[prop];
    return p?.kind === 'list' ? listLimit(widget, prop, p, spec.size) : undefined;
  });
  // The budget is only meaningful once the props are well-formed.
  if (issues.length === before) {
    const reads = panelReads(spec, widget);
    const budget = SIZES[spec.size].reads;
    if (reads > budget) issues.push({ path, rule: 'budget', message: `asks for ${reads} reads, a ${spec.size} panel holds ${budget}. Remove something or use a larger size` });
  }
  return issues;
}

/** Checks the panels a layer contributes. Layers never choose positions; the layout does. */
export function validateLayerPanels(panels: PanelSpec[], registry: WidgetRegistry): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const spec of panels) {
    const path = `panels.${spec?.id ?? '?'}`;
    issues.push(...validatePanel(spec, registry, path));
    if (seen.has(spec.id)) issues.push({ path: `${path}.id`, rule: 'schema', message: 'is used twice' });
    seen.add(spec.id);
    if (spec.at) issues.push({ path: `${path}.at`, rule: 'grid', message: 'a layer cannot place its panels; only a site page can' });
    if (spec.layer) issues.push({ path: `${path}.layer`, rule: 'schema', message: 'a layer\'s panels always read the layer itself' });
  }
  issues.push(...validateRibbon(panels.filter((spec) => spec?.ribbon), registry));
  return issues;
}

/** Checks a layer's ribbon panels (#78): small sizes only, and few enough to read in passing. */
export function validateRibbon(panels: PanelSpec[], registry: WidgetRegistry): Issue[] {
  const issues: Issue[] = [];
  let reads = 0;
  for (const spec of panels) {
    const widget = registry.get(spec.widget);
    if (widget) reads += panelReads(spec, widget);
    if (spec.ribbon !== undefined && typeof spec.ribbon !== 'boolean') issues.push({ path: `panels.${spec.id}.ribbon`, rule: 'schema', message: 'must be true or false' });
    if (!RIBBON.sizes.includes(spec.size)) issues.push({ path: `panels.${spec.id}.size`, rule: 'size', message: `a ribbon panel is ${RIBBON.sizes.join(', ')}, never ${spec.size}` });
  }
  if (panels.length > RIBBON.panels) issues.push({ path: 'panels', rule: 'budget', message: `a ribbon holds ${RIBBON.panels} panels, this layer has ${panels.length}` });
  if (reads > RIBBON.reads) issues.push({ path: 'panels', rule: 'budget', message: `the ribbon panels ask for ${reads} reads, a ribbon holds ${RIBBON.reads}` });
  return issues;
}

/** Checks a hand-made page: every panel placed, inside the grid, not overlapping, within the screen's budget. */
export function validatePage(page: { id: string; panels: PanelSpec[] }, registry: WidgetRegistry): Issue[] {
  const root = `pages.${page.id}`;
  const issues: Issue[] = [];
  const taken = new Map<string, string>();
  const seen = new Set<string>();
  let reads = 0;
  for (const spec of page.panels ?? []) {
    const path = `${root}.${spec?.id ?? '?'}`;
    const own = validatePanel(spec, registry, path);
    issues.push(...own);
    if (seen.has(spec.id)) issues.push({ path: `${path}.id`, rule: 'schema', message: 'is used twice' });
    seen.add(spec.id);
    const size = SIZES[spec.size];
    const widget = registry.get(spec.widget);
    if (!size || !widget) continue;
    if (!own.some((issue) => issue.rule === 'schema')) reads += panelReads(spec, widget);
    const at = spec.at;
    if (!at || !Number.isInteger(at.col) || !Number.isInteger(at.row)) {
      issues.push({ path: `${path}.at`, rule: 'grid', message: 'a panel on a page needs a position: { "col": 1-12, "row": 1-6 }' });
      continue;
    }
    if (at.col < 1 || at.row < 1 || at.col + size.cols - 1 > GRID.columns || at.row + size.rows - 1 > GRID.rows) {
      issues.push({ path: `${path}.at`, rule: 'grid', message: `a ${spec.size} panel (${size.cols} by ${size.rows}) does not fit the ${GRID.columns} by ${GRID.rows} grid there` });
      continue;
    }
    for (let row = at.row; row < at.row + size.rows; row++) {
      for (let col = at.col; col < at.col + size.cols; col++) {
        const cell = `${col},${row}`;
        const other = taken.get(cell);
        if (other && other !== spec.id) {
          issues.push({ path: `${path}.at`, rule: 'grid', message: `overlaps '${other}'` });
          row = Infinity;
          break;
        }
        taken.set(cell, spec.id);
      }
    }
  }
  if ((page.panels ?? []).length > SCREEN.panels) issues.push({ path: root, rule: 'screen', message: `has ${page.panels.length} panels, one screen holds ${SCREEN.panels}` });
  if (reads > SCREEN.reads) issues.push({ path: root, rule: 'screen', message: `asks for ${reads} reads, one screen holds ${SCREEN.reads}. Move panels to another page` });
  return issues;
}

/**
 * Control panels (#354) that name a control or action their layer doesn't have. `ids` are the
 * layer's control ids and named action ids. The panel still draws, saying what it names.
 */
export function controlProblems(panels: readonly PanelSpec[], ids: readonly string[]): string[] {
  return panels
    .filter((p) => p.widget === 'control' && typeof p.props?.control === 'string' && !ids.includes(p.props.control as string))
    .map((p) => `panel '${p.id}' names control '${p.props!.control}', which the layer does not have`);
}
