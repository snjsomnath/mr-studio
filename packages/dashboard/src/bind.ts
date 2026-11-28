// Turns a panel's props into what a widget draws: bindings are read from the
// layer's state, and live values are held to the same limits as literals. A
// value that is too long is cut, and a list that is too long loses its tail.

import { dataQueryProblems, expression, formatCompact, formatDecimal, formatHour, isDataQuery, isExpressionValue, runDataQuery } from '@mrstudio/sdk';
import type { DataQuery, DataResult, DataRow, PanelSize } from '@mrstudio/sdk';

/** The parts of a panel's spec that decide whether it is empty. */
export interface EmptyCheck {
  props?: Record<string, unknown>;
  size: PanelSize;
  hideWhenEmpty?: boolean;
}

import type { PropSpec, WidgetDefinition } from './registry.ts';
import { PANEL_TONES, TEXT } from './rules.ts';
import { isBinding, listLimit } from './validate.ts';

/** What bindings read from: the state of the panel's layer, and the site. */
export interface BindSource {
  params: Record<string, unknown>;
  shared: Record<string, unknown>;
  site: Record<string, unknown>;
  /**
   * A table dataset's rows, for props that reduce one (#670): undefined while it loads or when
   * there is no such dataset. The host shows the panel again once it has loaded.
   */
  rows?: (data: string) => readonly DataRow[] | undefined;
}

/** Cuts text to a number of characters, with an ellipsis. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function read(source: BindSource, path: string): unknown {
  let value: unknown = source;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

// Results kept per dataset, by the query and the live values it reads, so a panel redrawn many
// times a second reduces its rows again only when something it reads has changed.
const results = new WeakMap<readonly DataRow[], Map<string, DataResult>>();
const queryReads = new Map<string, string[]>();
function query(raw: DataQuery, source: BindSource): DataResult | undefined {
  const rows = source.rows?.(raw.data);
  if (!rows) return undefined;
  const text = JSON.stringify(raw);
  let reads = queryReads.get(text);
  if (!reads) {
    if (queryReads.size > 500) queryReads.clear();
    queryReads.set(text, (reads = dataQueryProblems(raw).reads));
  }
  const key = `${text}|${JSON.stringify(reads.map((path) => read(source, path)))}`;
  let kept = results.get(rows);
  if (!kept) results.set(rows, (kept = new Map()));
  if (!kept.has(key)) {
    if (kept.size > 200) kept.clear();
    kept.set(key, runDataQuery(rows, raw, source));
  }
  return kept.get(key);
}

function resolve(spec: PropSpec, raw: unknown, source: BindSource, limit?: number): unknown {
  // A live value, a value worked out from live values (#669), a dataset reduced (#670), or a literal.
  let value = isBinding(raw) ? read(source, raw.bind) : isExpressionValue(raw) ? expression(raw.expr).evaluate({ vars: source }) : isDataQuery(raw) ? query(raw, source) : raw;
  if (value === undefined || value === null) return undefined;
  // A grouped query read as one value or a series: its first value, or its values in order.
  if (isDataQuery(raw) && Array.isArray(value) && spec.kind !== 'list') value = spec.kind === 'numbers' ? value.map((item) => item.value) : value[0]?.value;
  if (value === undefined || value === null) return undefined;
  switch (spec.kind) {
    case 'text':
      return clip(String(value), spec.max);
    case 'number': {
      // A number a layer published as text ("12.5") still reads as a number (#373).
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
    }
    case 'boolean':
      // A bound yes/no may arrive as text or a number (#373): "true", "false", 1, 0.
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0') return false;
      return undefined;
    case 'value':
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      return clip(String(value), TEXT.value);
    case 'numbers':
      return Array.isArray(value) ? value.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice(-spec.maxLength) : undefined;
    case 'list': {
      if (!Array.isArray(value)) return undefined;
      return value.slice(0, limit ?? spec.max).map((item) => resolveAll(spec.item, item, source));
    }
    default:
      return value;
  }
}

function resolveAll(specs: Record<string, PropSpec>, props: unknown, source: BindSource, limits?: (prop: string, spec: PropSpec) => number | undefined): Record<string, unknown> {
  const record = (typeof props === 'object' && props !== null ? props : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const value = resolve(spec, record[key] ?? spec.default, source, limits?.(key, spec));
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The props a widget draws, for the current state. */
export function resolveProps(widget: WidgetDefinition, props: Record<string, unknown> | undefined, size: PanelSize, source: BindSource): Record<string, any> {
  return resolveAll(widget.props, props, source, (key, spec) => (spec.kind === 'list' ? listLimit(widget, key, spec, size) : undefined));
}

/** The prop a panel is about: its widget's first required prop that can be bound (a stat's value, a list's items). */
export function mainProp(widget: WidgetDefinition): string | undefined {
  const props = Object.entries(widget.props);
  return (props.find(([, spec]) => spec.required && spec.bindable) ?? props.find(([, spec]) => spec.required))?.[0];
}

/**
 * Whether a panel with `hideWhenEmpty` has nothing to show (#752): its main value is missing,
 * empty, zero, or an empty list. Such a panel is left out of the layout, so the canvas never
 * shows an empty card.
 */
export function panelIsEmpty(widget: WidgetDefinition, spec: EmptyCheck, source: BindSource): boolean {
  if (!spec.hideWhenEmpty) return false;
  const key = mainProp(widget);
  if (!key) return false;
  const value = resolveProps(widget, spec.props, spec.size, source)[key];
  return value === undefined || value === null || value === '' || value === 0 || (Array.isArray(value) && value.length === 0);
}

/** The panel's tone now (#672): a theme slot from its `tone`, worked out when it is an expression. */
export function panelTone(spec: { tone?: unknown }, source: BindSource): string | undefined {
  const raw = isExpressionValue(spec.tone) ? expression(spec.tone.expr).evaluate({ vars: source }) : spec.tone;
  return typeof raw === 'string' && (PANEL_TONES as readonly string[]).includes(raw) ? raw : undefined;
}

/** Whether a panel with `showIf` is shown now (#672). One without is always shown. */
export function panelShown(spec: { showIf?: unknown }, source: BindSource): boolean {
  if (!isExpressionValue(spec.showIf)) return true;
  const value = expression(spec.showIf.expr).evaluate({ vars: source });
  return value !== null && value !== undefined && value !== false && value !== 0 && value !== '';
}

export type ValueFormat = 'number' | 'hour' | 'percent';

/**
 * A value as the screen shows it: never more than about six characters, because a
 * number a visitor cannot take in at a glance is not a headline.
 */
export function formatValue(value: unknown, options: { format?: ValueFormat; decimals?: number } = {}): string {
  if (value === undefined || value === null || value === '') return '–';
  if (typeof value === 'string') return clip(value, TEXT.value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
  if (options.format === 'hour') return formatHour(value);
  if (options.format === 'percent') return `${Math.round(value * 100)}%`;
  const magnitude = Math.abs(value);
  if (magnitude >= 10_000) return formatCompact(value);
  const decimals = Math.min(2, Math.max(0, Math.round(options.decimals ?? (Number.isInteger(value) ? 0 : 1))));
  // Decimals give way before the integer part does.
  const fit = magnitude >= 1000 ? 0 : magnitude >= 100 ? Math.min(decimals, 1) : decimals;
  return formatDecimal(value, fit);
}
