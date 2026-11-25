// Turns a panel's props into what a widget draws: bindings are read from the
// layer's state, and live values are held to the same limits as literals. A
// value that is too long is cut, and a list that is too long loses its tail.

import { formatCompact, formatDecimal, formatHour } from '@mrstudio/sdk';
import type { PanelSize } from '@mrstudio/sdk';

import type { PropSpec, WidgetDefinition } from './registry.ts';
import { TEXT } from './rules.ts';
import { isBinding, listLimit } from './validate.ts';

/** What bindings read from: the state of the panel's layer, and the site. */
export interface BindSource {
  params: Record<string, unknown>;
  shared: Record<string, unknown>;
  site: Record<string, unknown>;
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

function resolve(spec: PropSpec, raw: unknown, source: BindSource, limit?: number): unknown {
  const value = isBinding(raw) ? read(source, raw.bind) : raw;
  if (value === undefined || value === null) return undefined;
  switch (spec.kind) {
    case 'text':
      return clip(String(value), spec.max);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
