// Custom layers drawn from a recipe (site.md, Custom layers; #38, #95). A recipe's look
// blocks style one dataset each, by geometry: `points`, `lines` or `fill`. Every style
// property is fixed, or driven by a column (L2); colours are palette slots or `#hex` (C8);
// sizes are millimetres on the physical table (E5), so a look reads the same on every
// table. Motion blocks act on a look block: `pulse`, `draw-in`, `flow`, `particles` along
// lines, `attract` (a crowd pulled into points) and `gravity` (people walking to points
// along the street network, #96). Everything is 2D, from straight above (E1): height and
// value become colour, outline, glow or a soft shadow, never extrusion.

import { clamp01, css, ease } from './blocks/scale.ts';
import type { Rgba } from './blocks/scale.ts';
import { drawDots, drawRings } from './blocks/draw.ts';
import { Swarm, aroundRing, particleAlpha, pathHeads, pickWeighted, pullTowards, seeded } from './blocks/motion.ts';
import { StreetNetwork } from './blocks/network.ts';
import { pointAlong } from './blocks/geo.ts';
import type { MeasuredPath } from './blocks/geo.ts';
import type { Area, Path, Shapes, Spot } from './blocks/sources.ts';
import type { View } from './blocks/view.ts';
import type { Point } from './blocks/geo.ts';
import { categorySlots, paletteColour, paletteHex, rampColour } from './palette.ts';
import type { ResolvedPalette } from './palette.ts';
import { TIMELINE_DEFAULTS, arrowMarks, fillArrow, fillIcon, timeReveal, traceShape } from './marks.ts';
import type { Arrows, PointShape, TimeReveal, TimelineProps } from './marks.ts';
import type { CustomLayer, LegendItem, RecipeBlock, SiteInfo } from './types.ts';

// ---- Style values ------------------------------------------------------------

/** A colour: `@slot`, `#rrggbb`, or driven by a column. */
export type Paint = string | PaintBy;
export interface PaintBy {
  by: string;
  /** `category`: one palette colour per value (C5: six shown, the rest grouped). `number`: a ramp. */
  kind: 'category' | 'number';
  /** For categories: the colour of each value, when the author picked one. */
  colors?: Record<string, string>;
  /** For numbers: the ramp's name in the palette. Default `sun`. */
  ramp?: string;
  /** For numbers: a smooth ramp, or classes of equal width, equal count, or natural breaks (Jenks). Default `continuous`. */
  classes?: 'continuous' | 'equal' | 'quantile' | 'natural';
  /** How many classes, 2 to 7. Default 5. */
  count?: number;
}

/** A size in table millimetres: fixed, or spread over a range by a numeric column. */
export type Size = number | { by: string; range: [number, number] };

export type GeometryKind = 'points' | 'lines' | 'fill';

/** The props of each look block, with their defaults. */
export interface PointsProps {
  color: Paint;
  radius_mm: Size;
  opacity: number;
  /** A soft glow around each point, 0 to 1. */
  glow: number;
  /** A white centre (C3: focus). */
  core: boolean;
  stroke: string | null;
  stroke_mm: number;
  /** A column whose value is written beside the point. Use for place names only (S1). */
  label: string | null;
  /** The mark: a circle, square, diamond, triangle, ring, or the pictogram named by `icon`. */
  shape: PointShape;
  icon: string;
}
export interface LinesProps {
  color: Paint;
  width_mm: Size;
  opacity: number;
  glow: number;
  /** A dark casing either side, so a bright line reads over busy ground (C7). */
  casing: boolean;
  dash: 'solid' | 'dashed' | 'dotted';
  dash_mm: number;
  gap_mm: number;
  /** Chevrons showing which way a line goes: at its end, or along it every `arrow_gap_mm`. */
  arrows: Arrows;
  arrow_mm: number;
  arrow_gap_mm: number;
}
export interface FillProps {
  color: Paint;
  opacity: number;
  stroke: string | null;
  stroke_mm: number;
  /** A glow along the outline, 0 to 1. */
  edge_glow: number;
  /** A soft shadow cast to the south-east, in mm: lifts an area off the ground without extrusion (D1). */
  shadow_mm: number;
  /** Diagonal hatching instead of a flat fill. */
  hatch: boolean;
}

export const LOOK_DEFAULTS = {
  points: { color: '@accent', radius_mm: 4, opacity: 1, glow: 0.5, core: true, stroke: null, stroke_mm: 0.6, label: null, shape: 'circle', icon: 'star' } satisfies PointsProps,
  lines: { color: '@accent', width_mm: 2, opacity: 1, glow: 0.3, casing: true, dash: 'solid', dash_mm: 6, gap_mm: 4, arrows: 'none', arrow_mm: 4, arrow_gap_mm: 40 } satisfies LinesProps,
  fill: { color: '@accent', opacity: 0.55, stroke: '@accent', stroke_mm: 0.6, edge_glow: 0, shadow_mm: 0, hatch: false } satisfies FillProps,
};

/** Motion blocks of this slice, by the geometry they act on. */
export interface PulseProps {
  /** Seconds for a ring to travel out (M4: 1.5 to 2.5). */
  period_s: number;
  /** How far the rings travel, in table mm. */
  size_mm: number;
  rings: number;
  /** Rings go out (+1, giving) or in (-1, gathering). */
  direction: 1 | -1;
}
export interface DrawInProps {
  /** Seconds to draw every line in (M4: 0.6 to 1.2 for a reveal; longer reads as a story). */
  duration_s: number;
  /** Lines start one after another instead of together. */
  stagger: boolean;
}
export interface FlowProps {
  /** Table millimetres per second the dashes travel. */
  speed_mm: number;
}
/** Lights travelling along every line, as a pure function of time. */
export interface ParticlesProps {
  /** Lights on each line at once. */
  per_line: number;
  speed_mm: number;
  size_mm: number;
}
/** A crowd of free particles drawn in to each point from around it: attention, pull (M8: free particles are for abstract forces). */
export interface AttractProps {
  /** Particles in flight at once. */
  count: number;
  speed_mm: number;
  /** How far out they start, in table mm. */
  reach_mm: number;
  /** A numeric column that makes some points pull harder, or null for all alike. */
  weight: string | null;
  size_mm: number;
}
/** People walking to each point along the street network (#96, M8: motion follows the place). */
export interface GravityProps {
  /** The site dataset whose lines are the streets. */
  network: string;
  count: number;
  speed_mm: number;
  weight: string | null;
  size_mm: number;
  /** A short fading trail behind each walker. */
  trail: boolean;
}
export const MOTION_DEFAULTS = {
  pulse: { period_s: 2, size_mm: 14, rings: 2, direction: 1 } satisfies PulseProps,
  'draw-in': { duration_s: 1.2, stagger: true } satisfies DrawInProps,
  flow: { speed_mm: 12 } satisfies FlowProps,
  particles: { per_line: 2, speed_mm: 20, size_mm: 2.5 } satisfies ParticlesProps,
  attract: { count: 300, speed_mm: 12, reach_mm: 60, weight: null, size_mm: 1.5 } satisfies AttractProps,
  gravity: { network: 'roads', count: 240, speed_mm: 10, weight: null, size_mm: 2, trail: true } satisfies GravityProps,
<<<<<<< HEAD
  timeline: TIMELINE_DEFAULTS,
};
/** Which motions fit which look (L1: verbs fit the form). */
export const MOTIONS_FOR: Record<GeometryKind, (keyof typeof MOTION_DEFAULTS)[]> = {
  points: ['pulse', 'attract', 'gravity', 'timeline'],
  lines: ['draw-in', 'flow', 'particles', 'timeline'],
  fill: ['pulse', 'timeline'],
=======
};
/** Which motions fit which look (L1: verbs fit the form). */
export const MOTIONS_FOR: Record<GeometryKind, (keyof typeof MOTION_DEFAULTS)[]> = {
  points: ['pulse', 'attract', 'gravity'],
  lines: ['draw-in', 'flow', 'particles'],
  fill: ['pulse'],
>>>>>>> origin/main
};

/** The look a geometry gets by default (D2: a single file can be a layer). */
export function lookFor(shapes: Shapes): GeometryKind {
  const counts: [GeometryKind, number][] = [
    ['fill', shapes.areas.length],
    ['lines', shapes.paths.length],
    ['points', shapes.spots.length],
  ];
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

// ---- Scales --------------------------------------------------------------------

type Props = Record<string, any>;

/** The numeric values of a column, skipping blanks. */
export function columnNumbers(rows: readonly Props[], column: string): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const value = row?.[column];
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** The distinct values of a column, most common first. */
export function columnCategories(rows: readonly Props[], column: string): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row?.[column];
    if (value === undefined || value === null || value === '') continue;
    counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

/** Which columns of a dataset are numbers and which are categories, for the "based on" pickers. */
export function profileColumns(rows: readonly Props[]): { name: string; kind: 'number' | 'category'; distinct: number }[] {
  const names = new Set<string>();
  for (const row of rows.slice(0, 500)) for (const key of Object.keys(row ?? {})) names.add(key);
  const out: { name: string; kind: 'number' | 'category'; distinct: number }[] = [];
  for (const name of names) {
    const filled = rows.filter((r) => r?.[name] !== undefined && r?.[name] !== null && r?.[name] !== '').length;
    if (filled === 0) continue;
    const numbers = columnNumbers(rows, name).length;
    const distinct = columnCategories(rows, name).length;
    if (typeof rows.find((r) => r?.[name] !== undefined)?.[name] === 'object') continue;
    out.push({ name, kind: numbers === filled && distinct > 2 ? 'number' : 'category', distinct });
  }
  return out;
}

/** Class breaks for numbers: the upper bound of each class but the last. */
export function classBreaks(values: readonly number[], classes: 'equal' | 'quantile' | 'natural', count: number): number[] {
  const n = Math.max(2, Math.min(7, Math.round(count)));
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  if (classes === 'natural') return naturalBreaks(sorted, n);
  const lo = sorted[0]!;
  const hi = sorted[sorted.length - 1]!;
  const breaks: number[] = [];
  for (let i = 1; i < n; i++) {
    if (classes === 'equal') breaks.push(lo + ((hi - lo) * i) / n);
    else breaks.push(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * i) / n))]!);
  }
  return breaks;
}

/** Values at most this many go into natural breaks; more are sampled evenly, so it stays fast. */
const NATURAL_SAMPLE = 1000;

/**
 * Natural breaks (Fisher-Jenks): the class boundaries that keep each class as tight as it can
 * be, so gaps in the data become edges between colours. `sorted` is ascending. Returns
 * `n - 1` breaks, each the lowest value of the class above it.
 */
export function naturalBreaks(sorted: readonly number[], n: number): number[] {
  let data = sorted;
  if (data.length > NATURAL_SAMPLE) {
    const step = (data.length - 1) / (NATURAL_SAMPLE - 1);
    data = Array.from({ length: NATURAL_SAMPLE }, (_, i) => sorted[Math.round(i * step)]!);
  }
  const m = data.length;
  const k = Math.min(n, new Set(data).size);
  if (k < 2) return [];
  // Prefix sums give any run's squared deviation in constant time.
  const sum = new Float64Array(m + 1);
  const sq = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    sum[i + 1] = sum[i]! + data[i]!;
    sq[i + 1] = sq[i]! + data[i]! * data[i]!;
  }
  const cost = (from: number, to: number) => {
    // Values from..to-1.
    const count = to - from;
    const s = sum[to]! - sum[from]!;
    return sq[to]! - sq[from]! - (s * s) / count;
  };
  // best[c][i]: least cost of the first i values in c classes; start[c][i]: where the last class begins.
  let best = new Float64Array(m + 1).fill(Infinity);
  for (let i = 1; i <= m; i++) best[i] = cost(0, i);
  const starts: Int32Array[] = [];
  for (let c = 2; c <= k; c++) {
    const next = new Float64Array(m + 1).fill(Infinity);
    const start = new Int32Array(m + 1);
    for (let i = c; i <= m; i++) {
      for (let j = c - 1; j < i; j++) {
        const total = best[j]! + cost(j, i);
        if (total < next[i]!) {
          next[i] = total;
          start[i] = j;
        }
      }
    }
    starts.push(start);
    best = next;
  }
  const breaks: number[] = [];
  let end = m;
  for (let c = k; c >= 2; c--) {
    const j = starts[c - 2]![end]!;
    breaks.unshift(data[j]!);
    end = j;
  }
  return breaks;
}

const MAX_CATEGORIES = 6;
const OTHERS = 'Others';

/** A paint turned into a colour for each shape's properties, with the legend rows that explain it. */
export interface PaintScale {
  colour(properties: Props): Rgba;
  legend: { label: string; color: string }[];
}

export function paintScale(paint: Paint | undefined, rows: readonly Props[], palette: ResolvedPalette): PaintScale {
  if (paint === undefined || typeof paint === 'string') {
    const fixed = paletteColour(paint, palette, 'accent');
    return { colour: () => fixed, legend: [] };
  }
  if (paint.kind === 'category') {
    const values = columnCategories(rows, paint.by);
    const shown = values.length > MAX_CATEGORIES + 1 ? values.slice(0, MAX_CATEGORIES) : values;
    const slots = categorySlots(palette);
    const map = new Map<string, Rgba>();
    shown.forEach((value, i) => map.set(value, paletteColour(paint.colors?.[value] ?? slots[i % slots.length], palette)));
    const others = paletteColour(paint.colors?.[OTHERS] ?? '@neutral', palette);
    const legend = shown.map((value) => ({ label: value, color: paletteHex(paint.colors?.[value] ?? slots[shown.indexOf(value) % slots.length], palette) }));
    if (shown.length < values.length) legend.push({ label: OTHERS, color: paletteHex(paint.colors?.[OTHERS] ?? '@neutral', palette) });
    return { colour: (p) => map.get(String(p?.[paint.by])) ?? others, legend };
  }
  const ramp = palette.ramps[paint.ramp ?? 'sun'] ?? palette.ramps.sun!;
  const values = columnNumbers(rows, paint.by);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const missing = paletteColour('@neutral', palette);
  const number = (p: Props) => {
    const v = p?.[paint.by];
    const n = typeof v === 'number' ? v : Number(v);
    return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
  };
  const format = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en') : String(Math.round(n * 10) / 10));
  const classes = paint.classes ?? 'continuous';
  if (classes === 'continuous') {
    const steps = [0, 0.5, 1];
    return {
      colour: (p) => {
        const n = number(p);
        return n === null ? missing : rampColour(ramp, hi > lo ? (n - lo) / (hi - lo) : 1);
      },
      legend: steps.map((t) => ({ label: format(lo + (hi - lo) * t), color: hexOf(rampColour(ramp, t)) })),
    };
  }
  const breaks = classBreaks(values, classes, paint.count ?? 5);
  const count = breaks.length + 1;
  const colours = Array.from({ length: count }, (_, i) => rampColour(ramp, count === 1 ? 1 : i / (count - 1)));
  const bounds = [lo, ...breaks, hi];
  return {
    colour: (p) => {
      const n = number(p);
      if (n === null) return missing;
      let i = 0;
      while (i < breaks.length && n > breaks[i]!) i++;
      return colours[i]!;
    },
    // A class of one value (natural breaks can isolate an outlier) is labelled by that value alone.
    legend: colours.map((c, i) => ({ label: format(bounds[i]!) === format(bounds[i + 1]!) ? format(bounds[i]!) : `${format(bounds[i]!)} – ${format(bounds[i + 1]!)}`, color: hexOf(c) })),
  };
}

function hexOf(c: Rgba): string {
  return `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** A size scale over the rows, in table mm. */
export function sizeScale(size: Size | undefined, rows: readonly Props[], fallback: number): (properties: Props) => number {
  if (size === undefined || typeof size === 'number') {
    const fixed = typeof size === 'number' && Number.isFinite(size) ? size : fallback;
    return () => fixed;
  }
  const values = columnNumbers(rows, size.by);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const [a, b] = size.range;
  return (p) => {
    const n = Number(p?.[size.by]);
    if (!Number.isFinite(n)) return a;
    // Area, not radius, grows with the value, so big values do not swamp the table.
    const t = hi > lo ? Math.sqrt(clamp01((n - lo) / (hi - lo))) : 1;
    return a + (b - a) * t;
  };
}

// ---- Table millimetres ------------------------------------------------------------

/**
 * Metres on the ground per millimetre on the physical table. Sizes in a recipe are table
 * millimetres (E5: a line 2 mm, a point 4 mm), so they look the same on a 1 m and a 3 m table.
 */
export function metresPerTableMm(site: Pick<SiteInfo, 'extent' | 'table'>): number {
  const widthCm = site.table?.width_cm && site.table.width_cm > 0 ? site.table.width_cm : 100;
  return site.extent.width_m / (widthCm * 10);
}

// ---- Drawing --------------------------------------------------------------------------

/** One look block made ready to draw: its scales computed over its data and the palette. */
export interface CompiledLook {
  id: string;
  kind: GeometryKind;
  /** Draws the block. `time` is seconds since the layer came on; `alpha` is the layer's fade. */
  draw(view: View, time: number, alpha: number): void;
  legend: LegendItem[];
}

export interface LookMotion {
  pulse?: Partial<PulseProps>;
  drawIn?: Partial<DrawInProps>;
  flow?: Partial<FlowProps>;
  particles?: Partial<ParticlesProps>;
  attract?: Partial<AttractProps>;
  /** `streets` is the network dataset in table metres, loaded by whoever draws the recipe. */
  gravity?: Partial<GravityProps> & { streets?: Shapes };
<<<<<<< HEAD
  timeline?: Partial<TimelineProps>;
=======
>>>>>>> origin/main
}

function trace(view: View, points: readonly Point[], close: boolean): void {
  for (let i = 0; i < points.length; i++) {
    const [x, y] = view.toPx(points[i]!);
    if (i === 0) view.pen.moveTo(x, y);
    else view.pen.lineTo(x, y);
  }
  if (close) view.pen.closePath();
}

/** Props of a look block over its defaults, with control overrides (`look.<id>.<prop>`) applied. */
export function lookProps<K extends GeometryKind>(kind: K, block: RecipeBlock, overrides: Record<string, unknown> = {}): (typeof LOOK_DEFAULTS)[K] {
  return { ...LOOK_DEFAULTS[kind], ...(block.props ?? {}), ...overrides } as (typeof LOOK_DEFAULTS)[K];
}

/**
 * Prepares one look block to draw. `shapes` is its dataset in table metres; `mm` is metres per
 * table millimetre (`metresPerTableMm`).
 */
export function compileLook(block: RecipeBlock, shapes: Shapes, palette: ResolvedPalette, mm: number, motion: LookMotion = {}, overrides: Record<string, unknown> = {}): CompiledLook | null {
  const kind = block.block as GeometryKind;
  if (kind !== 'points' && kind !== 'lines' && kind !== 'fill') return null;
  const px = (view: View, millimetres: number) => millimetres * mm * view.scale;
  if (kind === 'points') {
    const props = lookProps('points', block, overrides);
    const rows = shapes.spots.map((s) => s.properties);
    const paint = paintScale(props.color, rows, palette);
    const radius = sizeScale(props.radius_mm, rows, 4);
    const stroke = props.stroke ? paletteColour(props.stroke, palette) : null;
    const pulse = motion.pulse ? { ...MOTION_DEFAULTS.pulse, ...motion.pulse } : null;
    const attract = motion.attract ? attractCrowd(shapes.spots, paint, { ...MOTION_DEFAULTS.attract, ...motion.attract }, mm) : null;
    const walkers = motion.gravity ? streetCrowd(shapes.spots, paint, { ...MOTION_DEFAULTS.gravity, ...motion.gravity }, motion.gravity.streets, mm) : null;
<<<<<<< HEAD
    const reveal = motion.timeline ? timeReveal(rows, motion.timeline) : null;
=======
>>>>>>> origin/main
    return {
      id: block.id,
      kind,
      legend: legendRows(block, paint, 'point', palette, props.color),
      draw(view, time, alpha) {
        // Crowds go under the points they are drawn to.
        attract?.draw(view, time, alpha);
        walkers?.draw(view, time, alpha);
<<<<<<< HEAD
        drawPoints(view, shapes.spots, { paint, radius, props, stroke, pulse, px: (m) => px(view, m), time, alpha, timeline: reveal });
=======
        drawPoints(view, shapes.spots, { paint, radius, props, stroke, pulse, px: (m) => px(view, m), time, alpha });
>>>>>>> origin/main
      },
    };
  }
  if (kind === 'lines') {
    const props = lookProps('lines', block, overrides);
    const rows = shapes.paths.map((p) => p.properties);
    const paint = paintScale(props.color, rows, palette);
    const width = sizeScale(props.width_mm, rows, 2);
    const drawIn = motion.drawIn ? { ...MOTION_DEFAULTS['draw-in'], ...motion.drawIn } : null;
    const flow = motion.flow ? { ...MOTION_DEFAULTS.flow, ...motion.flow } : null;
    const particles = motion.particles ? { ...MOTION_DEFAULTS.particles, ...motion.particles } : null;
<<<<<<< HEAD
    const reveal = motion.timeline ? timeReveal(rows, motion.timeline) : null;
=======
>>>>>>> origin/main
    return {
      id: block.id,
      kind,
      legend: legendRows(block, paint, 'line', palette, props.color),
      draw(view, time, alpha) {
<<<<<<< HEAD
        drawLines(view, shapes.paths, { paint, width, props, drawIn, flow, px: (m) => px(view, m), time, alpha, timeline: reveal });
=======
        drawLines(view, shapes.paths, { paint, width, props, drawIn, flow, px: (m) => px(view, m), time, alpha });
>>>>>>> origin/main
        if (particles) {
          const heads = pathHeads(shapes.paths, time, { speed: Math.max(0.1, particles.speed_mm * mm), count: Math.max(1, Math.round(particles.per_line)) });
          drawDots(view, heads.map((h) => ({ point: h.point, colour: paint.colour(shapes.paths[h.path]!.properties), alpha: h.alpha * alpha, size: Math.max(1, px(view, particles.size_mm)) / view.detail })));
        }
      },
    };
  }
  const props = lookProps('fill', block, overrides);
  const rows = shapes.areas.map((a) => a.properties);
  const paint = paintScale(props.color, rows, palette);
  const stroke = props.stroke ? paletteColour(props.stroke, palette) : null;
  const pulse = motion.pulse ? { ...MOTION_DEFAULTS.pulse, ...motion.pulse } : null;
  const reveal = motion.timeline ? timeReveal(rows, motion.timeline) : null;
  return {
    id: block.id,
    kind,
    legend: legendRows(block, paint, 'fill', palette, props.color),
    draw(view, time, alpha) {
      drawFills(view, shapes.areas, { paint, props, stroke, pulse, px: (m) => px(view, m), time, alpha, timeline: reveal });
    },
  };
}

function legendRows(block: RecipeBlock, paint: PaintScale, shape: 'point' | 'line' | 'fill', palette: ResolvedPalette, fixed: Paint): LegendItem[] {
  if (paint.legend.length === 0) {
    const label = typeof block.props?.legend === 'string' && block.props.legend ? block.props.legend : null;
    return label ? [{ id: block.id, label, color: paletteHex(typeof fixed === 'string' ? fixed : undefined, palette), shape }] : [];
  }
  return paint.legend.map((row, i) => ({ id: `${block.id}-${i}`, label: row.label, color: row.color, shape }));
}

interface PointsDraw {
  paint: PaintScale;
  radius: (p: Props) => number;
  props: PointsProps;
  stroke: Rgba | null;
  pulse: PulseProps | null;
  px: (mm: number) => number;
  time: number;
  alpha: number;
  timeline: TimeReveal | null;
}

function drawPoints(view: View, spots: readonly Spot[], o: PointsDraw): void {
  const pen = view.pen;
  const base = o.alpha * clamp01(o.props.opacity);
  const shape = o.props.shape ?? 'circle';
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i]!;
    const seen = o.timeline ? o.timeline.at(spot.properties, o.time) : null;
    if (seen && seen.alpha <= 0) continue;
    const alpha = base * (seen ? seen.alpha : 1);
    const colour = o.paint.colour(spot.properties);
    const r = Math.max(0.5, o.px(o.radius(spot.properties)));
    const [x, y] = view.toPx(spot.point);
    if (seen && seen.fresh > 0) {
      // Just arrived: one ring opens out and fades (C3: the new thing is the brightest for a moment).
      pen.strokeStyle = css(colour, alpha * seen.fresh);
      pen.lineWidth = Math.max(1, r * 0.3);
      pen.beginPath();
      pen.arc(x, y, r * (1 + 3 * (1 - seen.fresh)), 0, Math.PI * 2);
      pen.stroke();
    }
    if (o.pulse) {
      // Neighbours do not pulse together (M2: one calm motion, not a strobe).
      drawRings({ ...view, time: o.time }, spot.point, {
        colour,
        radius_m: (o.px(o.pulse.size_mm) + r) / view.scale,
        direction: o.pulse.direction,
        count: Math.max(1, Math.round(o.pulse.rings)),
        period: Math.max(0.6, o.pulse.period_s),
        level: alpha * 0.9,
        width: Math.max(1, r * 0.25) / view.detail,
      }, (i * 0.618) % 1);
    }
    if (o.props.glow > 0) {
      const g = r * (1.5 + 3 * o.props.glow);
      const gradient = pen.createRadialGradient(x, y, r * 0.5, x, y, g);
      gradient.addColorStop(0, css(colour, alpha * 0.55 * o.props.glow + 0.1 * alpha));
      gradient.addColorStop(1, css(colour, 0));
      pen.fillStyle = gradient;
      pen.beginPath();
      pen.arc(x, y, g, 0, Math.PI * 2);
      pen.fill();
    }
    pen.fillStyle = css(colour, alpha);
    if (shape === 'icon') {
      // A pictogram sits on a dark disc so it reads over any ground (C7).
      pen.fillStyle = css([11, 14, 20, 0.8], alpha);
      pen.beginPath();
      pen.arc(x, y, r * 1.25, 0, Math.PI * 2);
      pen.fill();
      if (o.stroke && o.props.stroke_mm > 0) {
        pen.strokeStyle = css(o.stroke, alpha);
        pen.lineWidth = Math.max(0.5, o.px(o.props.stroke_mm));
        pen.stroke();
      }
      pen.fillStyle = css(colour, alpha);
      fillIcon(pen, o.props.icon, x, y, r * 0.95);
    } else if (shape === 'ring') {
      pen.strokeStyle = css(colour, alpha);
      pen.lineWidth = Math.max(1, r * 0.35);
      pen.beginPath();
      pen.arc(x, y, r * 0.85, 0, Math.PI * 2);
      pen.stroke();
    } else {
      traceShape(pen, shape, x, y, r);
      pen.fill();
      if (o.stroke && o.props.stroke_mm > 0) {
        pen.strokeStyle = css(o.stroke, alpha);
        pen.lineWidth = Math.max(0.5, o.px(o.props.stroke_mm));
        pen.stroke();
      }
    }
    if (o.props.core && shape !== 'icon' && shape !== 'ring') {
      pen.fillStyle = css([255, 255, 255, 0.92], alpha);
      pen.beginPath();
      pen.arc(x, y, r * 0.4, 0, Math.PI * 2);
      pen.fill();
    }
    const label = o.props.label ? spot.properties?.[o.props.label] : null;
    if (label !== null && label !== undefined && label !== '') {
      pen.save();
      pen.font = `600 ${Math.max(9, o.px(5))}px system-ui, sans-serif`;
      pen.textAlign = 'center';
      pen.textBaseline = 'bottom';
      pen.shadowColor = 'rgba(0,0,0,0.8)';
      pen.shadowBlur = 6 * view.detail;
      pen.fillStyle = css([248, 250, 252, 1], alpha);
      pen.fillText(String(label).slice(0, 28), x, y - r - o.px(2));
      pen.restore();
    }
  }
}

interface LinesDraw {
  paint: PaintScale;
  width: (p: Props) => number;
  props: LinesProps;
  drawIn: DrawInProps | null;
  flow: FlowProps | null;
  px: (mm: number) => number;
  time: number;
  alpha: number;
  timeline: TimeReveal | null;
}

/** The share of each line drawn so far, for a draw-in reveal. */
export function drawnShare(index: number, count: number, time: number, drawIn: DrawInProps | null): number {
  if (!drawIn) return 1;
  const duration = Math.max(0.1, drawIn.duration_s);
  if (!drawIn.stagger || count <= 1) return ease(time / duration);
  // Each line takes 40% of the time; their starts spread over the rest.
  const each = duration * 0.4;
  const start = ((duration - each) * index) / Math.max(1, count - 1);
  return ease((time - start) / each);
}

function partial(view: View, path: Path, share: number): void {
  if (share >= 1) return trace(view, path.points, false);
  const limit = path.length * share;
  for (let i = 0; i < path.points.length; i++) {
    if (path.stations[i]! <= limit) {
      const [x, y] = view.toPx(path.points[i]!);
      if (i === 0) view.pen.moveTo(x, y);
      else view.pen.lineTo(x, y);
    } else {
      const a = path.points[i - 1]!;
      const b = path.points[i]!;
      const span = path.stations[i]! - path.stations[i - 1]!;
      const t = span > 0 ? (limit - path.stations[i - 1]!) / span : 0;
      const [x, y] = view.toPx([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      view.pen.lineTo(x, y);
      return;
    }
  }
}

function drawLines(view: View, paths: readonly Path[], o: LinesDraw): void {
  const pen = view.pen;
  const base = o.alpha * clamp01(o.props.opacity);
  const seen = paths.map((path) => (o.timeline ? o.timeline.at(path.properties, o.time) : { alpha: 1, fresh: 0 }));
  pen.lineCap = o.props.dash === 'dotted' ? 'round' : 'round';
  pen.lineJoin = 'round';
  const dash = o.props.dash === 'solid' ? null : o.props.dash === 'dotted' ? [0.01, Math.max(1, o.px(o.props.gap_mm))] : [Math.max(1, o.px(o.props.dash_mm)), Math.max(1, o.px(o.props.gap_mm))];
  // Flowing dashes: dashes of their own on a plain line, unless the line is dashed already.
  const flowDash = o.flow ? dash ?? [Math.max(1, o.px(4)), Math.max(1, o.px(6))] : null;
  const offset = o.flow ? -o.px(o.flow.speed_mm) * o.time : 0;
  // Three passes so every casing sits under every line, and every glow under every core.
  const passes: ('casing' | 'glow' | 'line')[] = [];
  if (o.props.casing) passes.push('casing');
  if (o.props.glow > 0) passes.push('glow');
  passes.push('line');
  for (const pass of passes) {
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]!;
      if (path.points.length < 2) continue;
      const share = drawnShare(i, paths.length, o.time, o.drawIn);
      if (share <= 0 || seen[i]!.alpha <= 0) continue;
      const alpha = base * seen[i]!.alpha;
      const colour = o.paint.colour(path.properties);
      const width = Math.max(0.75, o.px(o.width(path.properties)));
      pen.beginPath();
      partial(view, path, share);
      if (pass === 'casing') {
        pen.setLineDash([]);
        pen.strokeStyle = css([11, 14, 20, 0.85], alpha);
        pen.lineWidth = width + 2 * Math.max(1, o.px(1.5));
      } else if (pass === 'glow') {
        pen.setLineDash([]);
        pen.strokeStyle = css(colour, alpha * 0.22 * o.props.glow + 0.04);
        pen.lineWidth = width * (2 + 4 * o.props.glow);
      } else {
        const lineDash = flowDash && o.flow ? flowDash : dash;
        pen.setLineDash(lineDash ?? []);
        pen.lineDashOffset = lineDash ? offset : 0;
        pen.strokeStyle = css(colour, alpha);
        pen.lineWidth = width;
        // A flowing line keeps a faint full trace under its moving dashes.
        if (o.flow && !dash) {
          pen.save();
          pen.setLineDash([]);
          pen.strokeStyle = css(colour, alpha * 0.3);
          pen.stroke();
          pen.restore();
        }
      }
      pen.stroke();
      // The tip of a line still drawing in is the brightest thing for that moment (C3).
      if (pass === 'line' && share < 1 && o.drawIn) {
        const tip = pointAt(path, share);
        const [x, y] = view.toPx(tip);
        pen.setLineDash([]);
        pen.fillStyle = css([255, 255, 255, 0.95], alpha);
        pen.beginPath();
        pen.arc(x, y, width * 0.9, 0, Math.PI * 2);
        pen.fill();
      }
    }
  }
  pen.setLineDash([]);
  pen.lineDashOffset = 0;
  const arrows = o.props.arrows ?? 'none';
  if (arrows !== 'none') {
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]!;
      if (path.points.length < 2 || seen[i]!.alpha <= 0) continue;
      const share = drawnShare(i, paths.length, o.time, o.drawIn);
      if (share < 1) continue;
      const colour = o.paint.colour(path.properties);
      const width = Math.max(0.75, o.px(o.width(path.properties)));
      const size = Math.max(width * 2, o.px(o.props.arrow_mm));
      // Positions in screen pixels, so the chevrons point the way the line runs on the table.
      const marks = arrowMarks(path.points.map((p) => view.toPx(p)), arrows, Math.max(size * 3, o.px(o.props.arrow_gap_mm)));
      const alpha = base * seen[i]!.alpha;
      for (const mark of marks) {
        pen.fillStyle = css([11, 14, 20, 0.85], alpha);
        fillArrow(pen, mark.at[0], mark.at[1], mark.angle, size * 1.35);
        pen.fillStyle = css(colour, alpha);
        fillArrow(pen, mark.at[0], mark.at[1], mark.angle, size);
      }
    }
  }
}

function pointAt(path: Path, share: number): Point {
  const limit = path.length * share;
  for (let i = 1; i < path.points.length; i++) {
    if (path.stations[i]! >= limit) {
      const a = path.points[i - 1]!;
      const b = path.points[i]!;
      const span = path.stations[i]! - path.stations[i - 1]!;
      const t = span > 0 ? (limit - path.stations[i - 1]!) / span : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return path.points[path.points.length - 1]!;
}

interface FillsDraw {
  paint: PaintScale;
  props: FillProps;
  stroke: Rgba | null;
  pulse: PulseProps | null;
  px: (mm: number) => number;
  time: number;
  alpha: number;
  timeline: TimeReveal | null;
}

function drawFills(view: View, areas: readonly Area[], o: FillsDraw): void {
  const pen = view.pen;
  const seen = areas.map((area) => (o.timeline ? o.timeline.at(area.properties, o.time) : { alpha: 1, fresh: 0 }));
  let alpha = o.alpha;
  const outline = (area: Area) => {
    pen.beginPath();
    for (const polygon of area.polygons) for (const ring of polygon) trace(view, ring, true);
  };
  // Shadows first, so no area's shadow falls on its neighbour's fill.
  if (o.props.shadow_mm > 0) {
    const d = o.px(o.props.shadow_mm);
    pen.save();
    pen.shadowColor = css([0, 0, 0, 0.85], alpha);
    pen.shadowBlur = d * 1.6;
    pen.shadowOffsetX = d * 0.7;
    pen.shadowOffsetY = d * 0.7;
    for (let i = 0; i < areas.length; i++) {
      if (seen[i]!.alpha <= 0) continue;
      pen.fillStyle = css([0, 0, 0, 0.6], o.alpha * seen[i]!.alpha);
      outline(areas[i]!);
      pen.fill('evenodd');
    }
    pen.restore();
  }
  for (let i = 0; i < areas.length; i++) {
    const area = areas[i]!;
    if (seen[i]!.alpha <= 0) continue;
    alpha = o.alpha * seen[i]!.alpha;
    const colour = o.paint.colour(area.properties);
    outline(area);
    if (o.props.hatch) {
      pen.save();
      pen.clip('evenodd');
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const polygon of area.polygons) for (const p of polygon[0] ?? []) {
        const [x, y] = view.toPx(p);
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      const gap = Math.max(3, o.px(2.5));
      pen.strokeStyle = css(colour, alpha * clamp01(o.props.opacity + 0.3));
      pen.lineWidth = Math.max(1, o.px(0.5));
      pen.beginPath();
      for (let k = minX - (maxY - minY); k < maxX; k += gap) {
        pen.moveTo(k, maxY);
        pen.lineTo(k + (maxY - minY), minY);
      }
      pen.stroke();
      pen.restore();
      outline(area);
    } else if (o.props.opacity > 0) {
      pen.fillStyle = css(colour, alpha * clamp01(o.props.opacity));
      pen.fill('evenodd');
    }
    const edge = o.stroke ?? colour;
    if (o.props.edge_glow > 0) {
      pen.save();
      pen.shadowColor = css(edge, alpha);
      pen.shadowBlur = o.px(2 + 6 * o.props.edge_glow);
      pen.strokeStyle = css(edge, alpha * 0.8);
      pen.lineWidth = Math.max(1, o.px(Math.max(0.6, o.props.stroke_mm)));
      pen.stroke();
      pen.restore();
    }
    if (o.stroke && o.props.stroke_mm > 0) {
      pen.strokeStyle = css(o.stroke, alpha);
      pen.lineWidth = Math.max(0.5, o.px(o.props.stroke_mm));
      pen.stroke();
    }
    if (o.pulse) {
      // An outline that swells out and fades, one area after another (M4, M5: slow, never a blink).
      const period = Math.max(0.6, o.pulse.period_s);
      const t = (((o.time / period + (i * 0.618) % 1) % 1) + 1) % 1;
      const phase = o.pulse.direction > 0 ? t : 1 - t;
      pen.save();
      pen.strokeStyle = css(edge, alpha * (1 - phase) * 0.9);
      pen.lineWidth = Math.max(1, o.px(0.6 + o.pulse.size_mm * 0.35 * phase));
      pen.shadowColor = css(edge, alpha * (1 - phase));
      pen.shadowBlur = o.px(o.pulse.size_mm * 0.5 * phase);
      pen.stroke();
      pen.restore();
    }
  }
}

// ---- Crowds ----------------------------------------------------------------------------

interface Crowd {
  draw(view: View, time: number, alpha: number): void;
}

/** Each point's pull, from a numeric column or alike. */
function weights(spots: readonly Spot[], column: string | null): { spot: Spot; weight: number; index: number }[] {
  return spots.map((spot, index) => {
    const value = column ? Number(spot.properties?.[column]) : 1;
    return { spot, index, weight: Number.isFinite(value) && value > 0 ? value : column ? 0.1 : 1 };
  });
}

/** A step from the time each frame passes in, so stateful crowds need no clock of their own. */
function stepper(): (time: number) => number {
  let last: number | null = null;
  return (time) => {
    const dt = last === null ? 0 : Math.min(0.1, Math.max(0, time - last));
    last = time;
    return dt;
  };
}

/** Free particles that appear around each point and are pulled into it, weighted by a column. */
function attractCrowd(spots: readonly Spot[], paint: PaintScale, o: AttractProps, mm: number): Crowd | null {
  const places = weights(spots, o.weight);
  if (places.length === 0) return null;
  const reach = Math.max(1, o.reach_mm * mm);
  const speed = Math.max(0.1, o.speed_mm * mm);
  const random = seeded(7);
  const swarm = new Swarm({
    max: Math.max(1, Math.round(o.count)),
    spawnRate: Math.max(1, o.count / 3),
    random,
    spawn: (r) => {
      const place = pickWeighted(places, r)!;
      const [x, y] = aroundRing(place.spot.point, reach, r, 0.35);
      return { x, y, lifetime: (reach / speed) * 3, tag: place };
    },
    steer: pullTowards((p) => (p.tag as { spot: Spot }).spot.point, { speed, radius_m: reach * 0.5, wander: 0.5, arrive_m: Math.max(0.5, reach * 0.06) }),
  });
  const step = stepper();
  return {
    draw(view, time, alpha) {
      swarm.step(step(time));
      drawDots(
        view,
        swarm.particles.map((p) => ({ point: [p.x, p.y] as Point, colour: paint.colour((p.tag as { spot: Spot }).spot.properties), alpha: particleAlpha(p) * alpha * 0.85, size: Math.max(0.8, o.size_mm * mm * view.scale) / view.detail })),
        { core: false },
      );
    },
  };
}

interface Walker {
  route: MeasuredPath;
  travelled: number;
  speed: number;
  place: Spot;
}

/**
 * People walking to each point along the street network: each walker starts at a random
 * street corner and follows the shortest route to a point picked by weight (Cultural
 * Gravity, kept on the streets). Without streets it draws nothing.
 */
function streetCrowd(spots: readonly Spot[], paint: PaintScale, o: GravityProps, streets: Shapes | undefined, mm: number): Crowd | null {
  if (!streets || streets.paths.length === 0 || spots.length === 0) return null;
  const network = new StreetNetwork(streets.paths.map((p) => p.points), Math.max(0.5, 0.6 * mm));
  const places = weights(spots, o.weight)
    .map((place) => {
      const tree = network.treeTo(place.spot.point);
      return { ...place, tree, starts: network.reachable(tree) };
    })
    .filter((place) => place.starts.length > 0);
  if (places.length === 0) return null;
  const random = seeded(11);
  const speed = Math.max(0.1, o.speed_mm * mm);
  const walkers: Walker[] = [];
  const max = Math.max(1, Math.round(o.count));
  const spawn = (spread: boolean) => {
    const place = pickWeighted(places, random)!;
    const start = place.starts[Math.floor(random() * place.starts.length)]!;
    const route = network.follow(place.tree, start, place.spot.point);
    if (!route || route.length <= 0) return;
    // A crowd already under way when the layer opens, rather than everyone setting off at once.
    walkers.push({ route, travelled: spread ? random() * route.length * 0.9 : 0, speed: speed * (0.75 + random() * 0.5), place: place.spot });
  };
  for (let i = 0; i < max; i++) spawn(true);
  const step = stepper();
  const gap = 2.2 * mm;
  return {
    draw(view, time, alpha) {
      const dt = step(time);
      let kept = 0;
      for (const walker of walkers) {
        walker.travelled += walker.speed * dt;
        if (walker.travelled < walker.route.length) walkers[kept++] = walker;
      }
      walkers.length = kept;
      while (walkers.length < max) spawn(false);
      const size = Math.max(0.8, o.size_mm * mm * view.scale) / view.detail;
      const dots: { point: Point; colour: Rgba; alpha: number; size: number }[] = [];
      for (const walker of walkers) {
        const colour = paint.colour(walker.place.properties);
        const share = walker.travelled / walker.route.length;
        // Fade in as they leave, out as they arrive.
        const fade = Math.min(1, walker.travelled / (gap * 4)) * Math.min(1, (walker.route.length - walker.travelled) / (gap * 2));
        dots.push({ point: pointAlong(walker.route, share).point, colour, alpha: alpha * fade, size });
        if (o.trail) {
          for (let k = 1; k <= 3; k++) {
            const back = walker.travelled - k * gap;
            if (back <= 0) break;
            dots.push({ point: pointAlong(walker.route, back / walker.route.length).point, colour, alpha: alpha * fade * (0.45 - k * 0.12), size: size * (1 - k * 0.18) });
          }
        }
      }
      drawDots(view, dots);
    },
  };
}

// ---- Whole recipes ---------------------------------------------------------------------

/** The motion blocks acting on a look block, as compileLook takes them. */
export function motionFor(recipe: Pick<CustomLayer, 'motion'>, look: string, overrides: Record<string, Record<string, unknown>> = {}): LookMotion {
  const motion: LookMotion = {};
  for (const block of recipe.motion ?? []) {
    if (block.on !== look) continue;
    const props = { ...(block.props ?? {}), ...(overrides[block.id] ?? {}) };
    if (block.block === 'pulse') motion.pulse = props as Partial<PulseProps>;
    if (block.block === 'draw-in') motion.drawIn = props as Partial<DrawInProps>;
    if (block.block === 'flow') motion.flow = props as Partial<FlowProps>;
    if (block.block === 'particles') motion.particles = props as Partial<ParticlesProps>;
    if (block.block === 'attract') motion.attract = props as Partial<AttractProps>;
    if (block.block === 'gravity') motion.gravity = props as Partial<GravityProps>;
<<<<<<< HEAD
    if (block.block === 'timeline') motion.timeline = props as Partial<TimelineProps>;
=======
>>>>>>> origin/main
  }
  return motion;
}

/**
 * Control values as overrides of block props: a control whose `bind` is
 * `look.<block>.<prop>` or `motion.<block>.<prop>` sets that prop.
 */
export function boundOverrides(recipe: Pick<CustomLayer, 'controls'>, params: Record<string, unknown>): { look: Record<string, Record<string, unknown>>; motion: Record<string, Record<string, unknown>> } {
  const out = { look: {} as Record<string, Record<string, unknown>>, motion: {} as Record<string, Record<string, unknown>> };
  for (const control of recipe.controls ?? []) {
    const [stage, block, prop] = (control.bind ?? '').split('.');
    if ((stage !== 'look' && stage !== 'motion') || !block || !prop || !(control.id in params)) continue;
    (out[stage][block] ??= {})[prop] = params[control.id];
  }
  return out;
}

/** The legend a recipe's looks give, for the controller (S2: every colour on the table has its swatch). */
export function recipeLegend(looks: readonly CompiledLook[]): LegendItem[] {
  return looks.flatMap((look) => look.legend);
}
