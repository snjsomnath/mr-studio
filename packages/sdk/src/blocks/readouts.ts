// Readouts: what a layer publishes for the TV. These are plain JSON models, with no
// DOM, in the shapes the dashboard widgets bind to (`stat`, `bars`, `timeline`,
// `trend`). A layer builds them from its data and hands them to `ctx.publish`.
// Colours are theme slots 1..6, never hex, so a dashboard stays in one palette.

import type { Clock } from './series.ts';

export interface FormatOptions {
  /** Significant digits kept for small numbers. Default 3. */
  digits?: number;
  /** Scale 1 200 000 to "1.2 M". Default true. */
  compact?: boolean;
}

/** A number as short text for a tile: "1.29 k", "247", "0.04". Never longer than 8 characters. */
export function formatNumber(value: number, options: FormatOptions = {}): string {
  if (!Number.isFinite(value)) return '—';
  const digits = options.digits ?? 3;
  const abs = Math.abs(value);
  const steps: [number, string][] = [[1e9, ' G'], [1e6, ' M'], [1e3, ' k']];
  if (options.compact !== false) {
    for (const [size, suffix] of steps) {
      if (abs >= size) return `${trim((value / size).toPrecision(digits))}${suffix}`;
    }
  }
  if (abs >= 100 || Number.isInteger(value)) return String(Math.round(value));
  return trim(value.toPrecision(Math.min(digits, abs < 1 ? 2 : digits)));
}

function trim(text: string): string {
  return text.includes('.') && !text.includes('e') ? text.replace(/\.?0+$/, '') : String(Number(text));
}

/** One number with a unit and a caption. `delta` is the change the tile may show as an arrow. */
export interface Stat {
  value: string;
  unit: string;
  caption: string;
  delta?: number;
}

export function stat(value: number | string, unit: string, caption: string, options: FormatOptions & { delta?: number } = {}): Stat {
  const out: Stat = {
    value: (typeof value === 'number' ? formatNumber(value, options) : value).slice(0, 8),
    unit: unit.slice(0, 6),
    caption: caption.slice(0, 40),
  };
  if (options.delta !== undefined) out.delta = options.delta;
  return out;
}

export interface Bar {
  label: string;
  value: number;
  /** Theme colour slot, 1..6. */
  slot: number;
}

/** Up to six bars, e.g. where this hour's energy came from. Slots default to the order given. */
export function bars(items: { label: string; value: number; slot?: number }[]): { items: Bar[] } {
  return {
    items: items.slice(0, 6).map((item, i) => ({ label: item.label.slice(0, 20), value: item.value, slot: item.slot ?? (i % 6) + 1 })),
  };
}

/** Each item's share of the total, 0..1, for a stacked bar. */
export function shares(values: readonly number[]): number[] {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  return values.map((v) => (total > 0 ? Math.max(0, v) / total : 0));
}

/** The play head on a span of hours, with the daylight part marked. All in hours. */
export interface Timeline {
  now: number;
  start: number;
  end: number;
  dayFrom: number;
  dayTo: number;
}

export function timeline(clock: Pick<Clock, 'position' | 'span'>, options: { hoursPerStep?: number; startHour?: number; dayFrom?: number; dayTo?: number } = {}): Timeline {
  const perStep = options.hoursPerStep ?? 1;
  const start = options.startHour ?? 0;
  return {
    now: Math.round((start + clock.position * perStep) * 100) / 100,
    start,
    end: start + clock.span * perStep,
    dayFrom: options.dayFrom ?? 6,
    dayTo: options.dayTo ?? 20,
  };
}

/** Up to three series over the span with the play head as 0..1. Long series are thinned to 96 points. */
export function trend(series: { label: string; values: readonly number[]; slot?: number }[], progress: number): { series: { label: string; values: number[]; slot: number }[]; now: number } {
  return {
    series: series.slice(0, 3).map((s, i) => ({ label: s.label.slice(0, 20), values: thin(s.values, 96), slot: s.slot ?? (i % 6) + 1 })),
    now: Math.min(1, Math.max(0, progress)),
  };
}

function thin(values: readonly number[], max: number): number[] {
  if (values.length <= max) return [...values];
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const from = Math.floor((i * values.length) / max);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / max));
    let sum = 0;
    for (let k = from; k < to; k++) sum += values[k]!;
    out.push(sum / (to - from));
  }
  return out;
}
