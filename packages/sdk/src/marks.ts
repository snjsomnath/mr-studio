// Point shapes, pictograms, line arrows and time-driven reveal for custom layers (#95).
// Everything is drawn flat in 2D (the table is top-down only): a shape is an outline in the
// plane, an arrow is a chevron lying along its line, and time shows as things appearing.

import type { Point } from './blocks/geo.ts';
import type { Pen } from './blocks/view.ts';

/** Point marks a look can draw. `icon` draws the pictogram named by the `icon` prop. */
export const POINT_SHAPES = ['circle', 'square', 'diamond', 'triangle', 'ring', 'icon'] as const;
export type PointShape = (typeof POINT_SHAPES)[number];

/**
 * Pictograms, as SVG path data on a 24 by 24 box centred on 12,12. They are bold and simple
 * so they read at 6 to 12 mm on a projected table (E5), and they are filled, not stroked.
 */
export const ICONS: Record<string, { label: string; path: string }> = {
  star: { label: 'Star', path: 'M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.2 5.8 20.9l1.6-7L2 9.2l7.1-.6z' },
  pin: { label: 'Pin', path: 'M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z' },
  flag: { label: 'Flag', path: 'M5 2h2v20H5zM8 3h11l-3 4.5L19 12H8z' },
  tree: { label: 'Tree', path: 'M12 2l7 9h-3l4 6h-7v5h-2v-5H4l4-6H5z' },
  person: { label: 'Person', path: 'M12 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8 9h8l1 7h-2.5l-.5 6h-4l-.5-6H7z' },
  house: { label: 'Building', path: 'M12 2l10 9h-3v11H5V11H2zm-2 12v8h4v-8z' },
  bus: { label: 'Bus', path: 'M5 3h14a2 2 0 0 1 2 2v13h-2v2h-3v-2H8v2H5v-2H3V5a2 2 0 0 1 2-2zm1 3v6h12V6zm1 8.5a1.5 1.5 0 1 0 0 .01zm10 0a1.5 1.5 0 1 0 0 .01z' },
  bolt: { label: 'Energy', path: 'M14 1L4 14h6l-2 9 10-13h-6z' },
  drop: { label: 'Water', path: 'M12 2s7 8 7 13a7 7 0 0 1-14 0c0-5 7-13 7-13z' },
  heart: { label: 'Heart', path: 'M12 21s-9-5.6-9-12a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.4-9 12-9 12z' },
  plus: { label: 'Plus', path: 'M9 2h6v7h7v6h-7v7H9v-7H2V9h7z' },
  sun: { label: 'Sun', path: 'M12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12zM11 0h2v4h-2zm0 20h2v4h-2zM0 11h4v2H0zm20 0h4v2h-4zM3.5 2.1l2.8 2.8-1.4 1.4-2.8-2.8zm15.6 15.6l2.8 2.8-1.4 1.4-2.8-2.8zM2.1 20.5l2.8-2.8 1.4 1.4-2.8 2.8zM17.7 4.9l2.8-2.8 1.4 1.4-2.8 2.8z' },
};
export const ICON_NAMES = Object.keys(ICONS);

const icons = new Map<string, Path2D | null>();
function iconPath(name: string): Path2D | null {
  if (!icons.has(name)) {
    const icon = ICONS[name];
    icons.set(name, icon && typeof Path2D !== 'undefined' ? new Path2D(icon.path) : null);
  }
  return icons.get(name)!;
}

/**
 * Traces a point mark of radius `r` at x, y (in pixels) as the current path, ready to fill.
 * Returns false for an icon, which draws itself through `fillIcon`.
 */
export function traceShape(pen: Pen, shape: PointShape, x: number, y: number, r: number): boolean {
  pen.beginPath();
  switch (shape) {
    case 'square': {
      const s = r * 0.89; // the same area as the circle
      pen.rect(x - s, y - s, 2 * s, 2 * s);
      return true;
    }
    case 'diamond': {
      const s = r * 1.25;
      pen.moveTo(x, y - s);
      pen.lineTo(x + s, y);
      pen.lineTo(x, y + s);
      pen.lineTo(x - s, y);
      pen.closePath();
      return true;
    }
    case 'triangle': {
      const s = r * 1.35;
      pen.moveTo(x, y - s);
      pen.lineTo(x + s * 0.866, y + s * 0.5);
      pen.lineTo(x - s * 0.866, y + s * 0.5);
      pen.closePath();
      return true;
    }
    case 'icon':
      return false;
    default:
      pen.arc(x, y, r, 0, Math.PI * 2);
      return true;
  }
}

/** Fills a pictogram of radius `r` at x, y. Unknown names draw a circle. */
export function fillIcon(pen: Pen, name: string, x: number, y: number, r: number): void {
  const path = iconPath(name);
  if (!path) {
    pen.beginPath();
    pen.arc(x, y, r, 0, Math.PI * 2);
    pen.fill();
    return;
  }
  const k = (r * 2) / 22;
  const placed = new Path2D();
  placed.addPath(path, { a: k, b: 0, c: 0, d: k, e: x - 12 * k, f: y - 12 * k });
  pen.fill(placed, 'evenodd');
}

/** Where arrows go on a line. */
export const ARROWS = ['none', 'end', 'along'] as const;
export type Arrows = (typeof ARROWS)[number];

/**
 * Arrow positions on a polyline in its own units: the end only, or every `gap` along it,
 * each with the direction it points. A short line still gets one arrow at its middle.
 */
export function arrowMarks(points: readonly Point[], where: Arrows, gap: number): { at: Point; angle: number }[] {
  if (where === 'none' || points.length < 2) return [];
  const stations = [0];
  for (let i = 1; i < points.length; i++) stations.push(stations[i - 1]! + Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]));
  const length = stations[stations.length - 1]!;
  if (length <= 0) return [];
  const at = (d: number) => {
    let i = 1;
    while (i < points.length - 1 && stations[i]! < d) i++;
    const a = points[i - 1]!;
    const b = points[i]!;
    const span = stations[i]! - stations[i - 1]!;
    const t = span > 0 ? Math.min(1, Math.max(0, (d - stations[i - 1]!) / span)) : 0;
    return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as Point, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  };
  if (where === 'end') return [at(length)];
  const step = Math.max(gap, length * 0.02);
  if (length < step) return [at(length / 2)];
  const out = [];
  // Centred, so a line's arrows do not bunch at one end.
  const count = Math.floor(length / step);
  const start = (length - (count - 1) * step) / 2;
  for (let k = 0; k < count; k++) out.push(at(start + k * step));
  return out;
}

/** Draws a filled chevron of size `s` pixels at x, y pointing along `angle` (in screen space). */
export function fillArrow(pen: Pen, x: number, y: number, angle: number, s: number): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners: [number, number][] = [[0.6, 0], [-0.5, -0.6], [-0.2, 0], [-0.5, 0.6]];
  pen.beginPath();
  corners.forEach(([u, v], i) => {
    const px = x + s * (u * cos - v * sin);
    const py = y + s * (u * sin + v * cos);
    if (i === 0) pen.moveTo(px, py);
    else pen.lineTo(px, py);
  });
  pen.closePath();
  pen.fill();
}

// ---- Time --------------------------------------------------------------------------

/** Plays a layer through time: features appear as a sweep passes the value in their time column. */
export interface TimelineProps {
  /** The column holding each feature's time: a year, a number, or a date. */
  column: string | null;
  /** Seconds the sweep takes from the earliest time to the latest (M4: a story, not a blink). */
  duration_s: number;
  /** Seconds it holds at the end before starting again. */
  hold_s: number;
  /** Features stay once they appear, or fade out after a while (a moving window). */
  keep: boolean;
  /** For a moving window, how long a feature stays, as a share of the whole span. */
  window: number;
}
export const TIMELINE_DEFAULTS: TimelineProps = { column: null, duration_s: 12, hold_s: 3, keep: true, window: 0.15 };

/** A time value from a cell: a number as it is, a date string as milliseconds, or NaN. */
export function timeValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return NaN;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : NaN;
}

/**
 * Columns that read as times, for the builder's picker: dates, or whole numbers that look like
 * years (1000 to 2200). Columns named like a time (year, date, built, opened…) come first.
 */
export function timeColumns(rows: readonly Record<string, unknown>[]): string[] {
  const sample = rows.slice(0, 200);
  const keys = new Set<string>();
  for (const row of sample) for (const k of Object.keys(row ?? {})) keys.add(k);
  const named = /year|date|time|built|open|start|end|when|day|month|år|datum/i;
  const found = [...keys].filter((k) => {
    let seen = 0;
    for (const row of sample) {
      const v = row?.[k];
      if (v === null || v === undefined || v === '') continue;
      const asNumber = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      const ok = Number.isFinite(asNumber) ? Number.isInteger(asNumber) && asNumber >= 1000 && asNumber <= 2200 : Number.isFinite(timeValue(v));
      if (!ok) return false;
      seen++;
    }
    return seen > 1;
  });
  return found.sort((a, b) => Number(!named.test(a)) - Number(!named.test(b)));
}

export interface TimeReveal {
  /** How visible a feature is now, 0 to 1, and how freshly it appeared (1 just now, 0 long ago). */
  at(props: Record<string, unknown> | undefined, time: number): { alpha: number; fresh: number };
  /** Where the sweep is, as a share of the span. */
  share(time: number): number;
}

/** Prepares a timeline over the features' rows. Features with no time are always shown. */
export function timeReveal(rows: readonly (Record<string, unknown> | undefined)[], props: Partial<TimelineProps>): TimeReveal | null {
  const o = { ...TIMELINE_DEFAULTS, ...props };
  if (!o.column) return null;
  const column = o.column;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const t = timeValue(row?.[column]);
    if (Number.isFinite(t)) [min, max] = [Math.min(min, t), Math.max(max, t)];
  }
  if (!Number.isFinite(min)) return null;
  const span = max - min || 1;
  const duration = Math.max(1, o.duration_s);
  const cycle = duration + Math.max(0, o.hold_s);
  const share = (time: number) => Math.min(1, (((time % cycle) + cycle) % cycle) / duration);
  const window = Math.max(0.01, o.window);
  return {
    share,
    at(row, time) {
      const t = timeValue(row?.[column]);
      if (!Number.isFinite(t)) return { alpha: 1, fresh: 0 };
      const since = share(time) - (t - min) / span;
      if (since < 0) return { alpha: 0, fresh: 0 };
      const fresh = Math.max(0, 1 - since / 0.06);
      // A short fade in, so features arrive rather than blink (M5).
      const appear = Math.min(1, since / 0.015);
      if (o.keep) return { alpha: appear, fresh };
      const fade = since > window ? Math.max(0, 1 - (since - window) / (window * 0.5)) : 1;
      return { alpha: appear * fade, fresh };
    },
  };
}
