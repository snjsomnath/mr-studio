// Scales turn a data value into something to draw: a 0..1 intensity, a colour, a width.
// A scale is a plain function, so blocks take them as style options and legends are
// built from the same definition that colours the table.

import type { Colormap } from '../colormap.ts';

/** Red, green, blue 0..255 and alpha 0..1. */
export type Rgba = readonly [r: number, g: number, b: number, a: number];

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb()/rgba()`. Unknown input is mid grey. */
export function colour(input: string | Rgba): Rgba {
  if (typeof input !== 'string') return input;
  const hex = input.trim().match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (hex && (hex.length === 3 || hex.length === 4)) {
    const v = [...hex].map((c) => parseInt(c + c, 16));
    return [v[0]!, v[1]!, v[2]!, v[3] === undefined ? 1 : v[3] / 255];
  }
  if (hex && (hex.length === 6 || hex.length === 8)) {
    const v = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return [v[0]!, v[1]!, v[2]!, hex.length === 8 ? v[3]! / 255 : 1];
  }
  const parts = input.match(/rgba?\(([^)]+)\)/i)?.[1]?.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts && parts.length >= 3) return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  return [128, 128, 128, 1];
}

/** A CSS colour, optionally with its alpha multiplied. */
export function css(c: Rgba, alpha = 1): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.round(Math.min(1, Math.max(0, c[3] * alpha)) * 1000) / 1000})`;
}

export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const f = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Smooth start and stop, for reveals and fades. */
export function ease(t: number): number {
  const f = clamp01(t);
  return f * f * (3 - 2 * f);
}

/** The smallest and largest finite value. */
export function extent(values: Iterable<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : [0, 0];
}

export interface LevelOptions {
  /** Data values that map to 0 and 1. */
  domain: readonly [number, number];
  /** `sqrt` and `log` keep small values visible beside one very large one. */
  curve?: 'linear' | 'sqrt' | 'log';
  /**
   * The level a present-but-tiny value still gets, 0..1. A member of a community that
   * draws almost nothing must still read as a member on a projection table.
   */
  floor?: number;
}

/** A data value to a 0..1 level. */
export function levelScale(options: LevelOptions): (value: number) => number {
  const [lo, hi] = options.domain;
  const floor = options.floor ?? 0;
  const curve = options.curve ?? 'linear';
  return (value) => {
    if (!Number.isFinite(value) || hi <= lo) return floor;
    let t = clamp01((value - lo) / (hi - lo));
    if (curve === 'sqrt') t = Math.sqrt(t);
    else if (curve === 'log') t = Math.log1p(t * 99) / Math.log(100);
    return floor + (1 - floor) * t;
  };
}

/** A 0..1 level to a colour along a colormap. */
export function rampScale(colormap: Colormap): (level: number) => Rgba {
  const stops = colormap.stops;
  return (level) => {
    const t = clamp01(level);
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
    const a = stops[k]!;
    const b = stops[Math.min(k + 1, stops.length - 1)]!;
    const span = b[0] - a[0];
    return mix([a[1], a[2], a[3], a[4] / 255], [b[1], b[2], b[3], b[4] / 255], span > 0 ? (t - a[0]) / span : 0);
  };
}

/** Two colours as a ramp, e.g. an unlit building to its full demand colour. */
export function twoColourScale(from: string | Rgba, to: string | Rgba): (level: number) => Rgba {
  const a = colour(from);
  const b = colour(to);
  return (level) => mix(a, b, level);
}

/**
 * Stepped classes: `bins` are the lower edges, in rising order, and each has a colour.
 * A value below the first edge takes the first colour.
 */
export function binScale(bins: readonly number[], colours: readonly (string | Rgba)[]): (value: number) => Rgba {
  const parsed = colours.map(colour);
  return (value) => {
    let k = 0;
    while (k < bins.length - 1 && value >= bins[k + 1]!) k++;
    return parsed[Math.min(k, parsed.length - 1)] ?? [128, 128, 128, 1];
  };
}

/** Named classes, e.g. an energy class or a kind of place, with a colour for anything unlisted. */
export function categoryScale(colours: Record<string, string | Rgba>, fallback: string | Rgba = '#6b7280'): (key: unknown) => Rgba {
  const parsed = new Map(Object.entries(colours).map(([key, value]) => [key, colour(value)]));
  const other = colour(fallback);
  return (key) => parsed.get(String(key)) ?? other;
}

// ---- Legends --------------------------------------------------------------

export interface LegendEntry {
  label: string;
  colour: string;
}

/** Legend rows for stepped classes: "0–5 min", "5–10 min", "30+ min". */
export function binLegend(bins: readonly number[], colours: readonly (string | Rgba)[], unit = ''): LegendEntry[] {
  const suffix = unit ? ` ${unit}` : '';
  return bins.map((low, i) => ({
    label: i === bins.length - 1 ? `${low}+${suffix}` : `${low}–${bins[i + 1]}${suffix}`,
    colour: css(colour(colours[Math.min(i, colours.length - 1)] ?? '#808080')),
  }));
}

/** Legend rows for named classes, in the order given. */
export function categoryLegend(colours: Record<string, string | Rgba>, labels: Record<string, string> = {}): LegendEntry[] {
  return Object.entries(colours).map(([key, value]) => ({ label: labels[key] ?? key, colour: css(colour(value)) }));
}
