// Tracers that ride a 2D velocity field, for ribbons and particles on the table.
// Pure and DOM-free so it can be tested; the runtime's flow overlay draws them.
// Positions are in field cells: x across columns, y down rows.

import type { FieldFrame } from './types.ts';

/** A velocity field on a grid, with the cells nothing flows through. */
export class FlowField {
  readonly width: number;
  readonly height: number;
  /** Velocity in field units, towards higher columns and higher rows. */
  readonly u: Float32Array;
  readonly v: Float32Array;
  /** 1 where the cell is an obstacle. */
  readonly blocked: Uint8Array;
  /** Mean velocity over the open cells: the prevailing direction and a typical speed. */
  meanU = 0;
  meanV = 0;
  meanSpeed = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.u = new Float32Array(width * height);
    this.v = new Float32Array(width * height);
    this.blocked = new Uint8Array(width * height);
  }

  /** Builds a field from two component frames. A cell where both are zero is an obstacle. */
  static fromFrames(u: FieldFrame, v: FieldFrame): FlowField {
    if (u.width !== v.width || u.height !== v.height) throw new Error('flow components differ in size');
    const field = new FlowField(u.width, u.height);
    decode(u, field.u);
    decode(v, field.v);
    // Quantised frames cannot hold an exact zero unless their range was chosen for it, so allow half a step.
    const eps = Math.max(u.max - u.min, v.max - v.min) / 1000;
    for (let n = 0; n < field.u.length; n++) field.blocked[n] = Math.abs(field.u[n]!) < eps && Math.abs(field.v[n]!) < eps ? 1 : 0;
    field.measure();
    return field;
  }

  /** Moves this field towards `target`, independent of the display's refresh rate. */
  blendTowards(target: FlowField, dt: number, seconds = 0.25): void {
    const blend = 1 - Math.exp(-dt / seconds);
    const { u, v } = this;
    for (let n = 0; n < u.length; n++) {
      u[n]! += (target.u[n]! - u[n]!) * blend;
      v[n]! += (target.v[n]! - v[n]!) * blend;
    }
    this.blocked.set(target.blocked);
    this.measure();
  }

  measure(): void {
    let su = 0;
    let sv = 0;
    let ss = 0;
    let count = 0;
    for (let n = 0; n < this.u.length; n++) {
      if (this.blocked[n]) continue;
      su += this.u[n]!;
      sv += this.v[n]!;
      ss += Math.hypot(this.u[n]!, this.v[n]!);
      count++;
    }
    const k = count > 0 ? 1 / count : 0;
    this.meanU = su * k;
    this.meanV = sv * k;
    this.meanSpeed = ss * k;
  }

  isBlocked(col: number, row: number): boolean {
    return col < 0 || row < 0 || col >= this.width || row >= this.height || this.blocked[row * this.width + col] === 1;
  }

  /** Velocity at a point, interpolated between cell centres. Zero outside and inside obstacles. */
  sample(x: number, y: number, out: [number, number]): [number, number] {
    const { width, height, u, v, blocked } = this;
    out[0] = 0;
    out[1] = 0;
    if (x < 0 || y < 0 || x >= width || y >= height || blocked[Math.floor(y) * width + Math.floor(x)]) return out;
    const gx = x - 0.5;
    const gy = y - 0.5;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const i = Math.max(0, Math.min(width - 1, ix + dx));
        const j = Math.max(0, Math.min(height - 1, iy + dy));
        const n = j * width + i;
        if (blocked[n]) continue;
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        out[0] += weight * u[n]!;
        out[1] += weight * v[n]!;
      }
    }
    return out;
  }

  /** Whether the straight path between two points touches an obstacle or leaves the field. */
  crossesBlocked(x0: number, y0: number, x1: number, y1: number): boolean {
    let x = Math.floor(x0);
    let y = Math.floor(y0);
    const endX = Math.floor(x1);
    const endY = Math.floor(y1);
    if (this.isBlocked(x, y)) return true;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    const stepX = dx ? Math.abs(1 / dx) : Infinity;
    const stepY = dy ? Math.abs(1 / dy) : Infinity;
    let tx = dx ? (sx > 0 ? x + 1 - x0 : x0 - x) * stepX : Infinity;
    let ty = dy ? (sy > 0 ? y + 1 - y0 : y0 - y) * stepY : Infinity;
    // Walks every cell the segment crosses, including the two beside a corner it passes through.
    for (let guard = 0; (x !== endX || y !== endY) && guard < 4096; guard++) {
      if (Math.abs(tx - ty) < 1e-12) {
        if (this.isBlocked(x + sx, y) || this.isBlocked(x, y + sy)) return true;
        x += sx;
        y += sy;
        tx += stepX;
        ty += stepY;
      } else if (tx < ty) {
        x += sx;
        tx += stepX;
      } else {
        y += sy;
        ty += stepY;
      }
      if (this.isBlocked(x, y)) return true;
    }
    return false;
  }
}

function decode(frame: FieldFrame, out: Float32Array): void {
  if (frame.data instanceof Float32Array) {
    out.set(frame.data);
    return;
  }
  const scale = (frame.max - frame.min) / 255;
  for (let n = 0; n < out.length; n++) out[n] = frame.min + frame.data[n]! * scale;
}

/** Points kept per trail. */
const TRAIL_CAPACITY = 64;
/** Seconds between recorded trail points. */
const TRAIL_INTERVAL = 1 / 75;
/** A tracer is replaced after this long, or after standing still this long. */
const MAX_AGE = 30;
const MAX_STALL = 2;

export interface TracerOptions {
  count: number;
  /** Seconds of path kept behind each tracer. */
  trailSeconds: number;
  /** Returns 0..1. Defaults to Math.random. */
  random?: () => number;
  /**
   * Where a replaced tracer comes back: `upwind` on the edges the flow enters through (wind),
   * `anywhere` on any open cell (rain landing on running water). Default `upwind`.
   */
  spawn?: 'upwind' | 'anywhere';
  /** Seconds a tracer may stand still before it is replaced. Default 2. */
  maxStall?: number;
}

/**
 * A fixed set of tracers. Each follows the field with midpoint integration,
 * never passes through an obstacle, and is replaced at the upwind edge when it
 * leaves, stalls or grows old. Trails are ring buffers, so a frame allocates nothing.
 */
export class Tracers {
  readonly count: number;
  trailSeconds: number;
  time = 0;
  /** Current positions. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Trail points, `TRAIL_CAPACITY` per tracer, oldest first from `start`. */
  readonly trailX: Float32Array;
  readonly trailY: Float32Array;
  readonly trailT: Float32Array;
  readonly start: Uint16Array;
  readonly length: Uint16Array;
  /** Seconds since each tracer was placed. */
  readonly age: Float32Array;
  private readonly stalled: Float32Array;
  private readonly active: Uint8Array;
  private readonly random: () => number;
  private readonly anywhere: boolean;
  private readonly maxStall: number;
  private field: FlowField;
  private readonly a: [number, number] = [0, 0];
  private readonly b: [number, number] = [0, 0];

  static readonly capacity = TRAIL_CAPACITY;

  constructor(field: FlowField, options: TracerOptions) {
    this.field = field;
    this.count = options.count;
    this.trailSeconds = options.trailSeconds;
    this.random = options.random ?? Math.random;
    this.anywhere = options.spawn === 'anywhere';
    this.maxStall = options.maxStall ?? MAX_STALL;
    const n = this.count;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.trailX = new Float32Array(n * TRAIL_CAPACITY);
    this.trailY = new Float32Array(n * TRAIL_CAPACITY);
    this.trailT = new Float32Array(n * TRAIL_CAPACITY);
    this.start = new Uint16Array(n);
    this.length = new Uint16Array(n);
    this.age = new Float32Array(n);
    this.stalled = new Float32Array(n);
    this.active = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.spawn(i, true);
  }

  /** Swaps the field the tracers ride. It must have the same size. */
  setField(field: FlowField): void {
    this.field = field;
  }

  /**
   * Advances every tracer by `dt` seconds. `rate` turns field units into cells
   * per second, so it sets how fast the animation plays.
   */
  update(dt: number, rate: number): void {
    this.time += dt;
    const g = this.field;
    const still = g.meanSpeed * rate * dt * 0.05;
    for (let i = 0; i < this.count; i++) {
      if (!this.active[i]) {
        this.spawn(i, true);
        continue;
      }
      const oldX = this.x[i]!;
      const oldY = this.y[i]!;
      if (!this.advect(i, dt, rate) || this.x[i]! < 0 || this.x[i]! >= g.width || this.y[i]! < 0 || this.y[i]! >= g.height) {
        this.spawn(i, false);
        continue;
      }
      this.age[i]! += dt;
      this.stalled[i] = Math.hypot(this.x[i]! - oldX, this.y[i]! - oldY) < still ? this.stalled[i]! + dt : 0;
      if (this.stalled[i]! > this.maxStall || this.age[i]! > MAX_AGE) {
        this.spawn(i, false);
        continue;
      }
      // A curved path can be clear while the straight line drawn between its ends clips a corner.
      if (g.crossesBlocked(oldX, oldY, this.x[i]!, this.y[i]!)) this.length[i] = 0;
      this.record(i);
    }
  }

  private record(i: number): void {
    const base = i * TRAIL_CAPACITY;
    let start = this.start[i]!;
    let length = this.length[i]!;
    // Drop points that have aged out.
    while (length > 0 && this.trailT[base + start]! < this.time - this.trailSeconds) {
      start = (start + 1) % TRAIL_CAPACITY;
      length--;
    }
    const last = base + ((start + length - 1) % TRAIL_CAPACITY);
    if (length === 0 || this.time - this.trailT[last]! >= TRAIL_INTERVAL) {
      if (length === TRAIL_CAPACITY) {
        start = (start + 1) % TRAIL_CAPACITY;
        length--;
      }
      const slot = base + ((start + length) % TRAIL_CAPACITY);
      this.trailX[slot] = this.x[i]!;
      this.trailY[slot] = this.y[i]!;
      this.trailT[slot] = this.time;
      length++;
    }
    this.start[i] = start;
    this.length[i] = length;
  }

  private advect(i: number, dt: number, rate: number): boolean {
    const g = this.field;
    const { a, b } = this;
    let px = this.x[i]!;
    let py = this.y[i]!;
    let remaining = dt;
    while (remaining > 1e-9) {
      g.sample(px, py, a);
      // Sub-steps of at most a third of a cell.
      const h = Math.min(remaining, 1 / 120, 0.35 / Math.max(1e-9, Math.hypot(a[0], a[1]) * rate));
      const mx = px + (a[0] * rate * h) / 2;
      const my = py + (a[1] * rate * h) / 2;
      if (g.crossesBlocked(px, py, mx, my)) return false;
      g.sample(mx, my, b);
      const nx = px + b[0] * rate * h;
      const ny = py + b[1] * rate * h;
      if (g.crossesBlocked(px, py, nx, ny)) return false;
      px = nx;
      py = ny;
      remaining -= h;
    }
    this.x[i] = px;
    this.y[i] = py;
    return true;
  }

  /** Places a tracer: anywhere at the start, afterwards on the edges the flow enters through (or anywhere, if so configured). */
  private spawn(i: number, anywhere: boolean): void {
    const g = this.field;
    const r = this.random;
    this.length[i] = 0;
    this.age[i] = 0;
    this.stalled[i] = 0;
    this.active[i] = 0;
    const norm = Math.hypot(g.meanU, g.meanV);
    const wx = norm > 0 ? g.meanU / norm : 1;
    const wy = norm > 0 ? g.meanV / norm : 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      let x: number;
      let y: number;
      if (anywhere || this.anywhere) {
        x = r() * g.width;
        y = r() * g.height;
      } else if (r() * (Math.abs(wx) * g.height + Math.abs(wy) * g.width) < Math.abs(wx) * g.height) {
        x = wx >= 0 ? 0.05 : g.width - 0.05;
        y = r() * g.height;
      } else {
        x = r() * g.width;
        y = wy >= 0 ? 0.05 : g.height - 0.05;
      }
      if (!g.isBlocked(Math.floor(x), Math.floor(y))) {
        this.x[i] = x;
        this.y[i] = y;
        this.active[i] = 1;
        return;
      }
    }
  }
}

// ---- Streamlines ------------------------------------------------------------
// Ported from the Chalmers demo's ribbons (interactive_map animations/cfd-visuals.js).
// Instead of trails behind moving dots, each ribbon is a whole streamline traced
// both ways from a fixed anchor. It is retraced a few times a second and every
// drawn point eases towards its new place, matched by its station along the line,
// so ribbons morph as the field settles instead of breaking and respawning.

/** A point of a drawn streamline. Positions are in field cells. */
export interface StreamPoint {
  x: number;
  y: number;
  /** Seconds the flow takes to get here from the anchor (negative upstream), at the current rate. */
  travel: number;
  /** Signed step count from the anchor; it pairs points between retraces. */
  station: number;
  alpha: number;
  /** 0 at the line's ends rising to 1 ten points in, so ends fade instead of stopping. */
  endFade: number;
  targetX: number;
  targetY: number;
  targetTravel: number;
  targetAlpha: number;
}

export interface Streamline {
  id: number;
  points: StreamPoint[];
}

/** Step along a streamline, in cells. */
const STREAM_STEP = 0.5;
/** Seconds between retraces, and the easing time of the drawn points. */
const RETRACE = 0.2;
const STREAM_EASE = 0.18;
/** Speeds below this (field units) end a line: still air has no direction worth drawing. */
const STILL = 0.08;

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/** Anchors on a jittered grid over the open cells, about `count` of them. */
export function streamAnchors(field: FlowField, count: number): { x: number; y: number; id: number }[] {
  const { width, height } = field;
  const columns = Math.max(1, Math.round(Math.sqrt((count * width) / height)));
  const rows = Math.max(1, Math.floor(count / columns));
  const out: { x: number; y: number; id: number }[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const id = y * columns + x;
      const px = ((x + 0.5) * width) / columns;
      // The golden angle staggers rows so anchors never line up into visible columns.
      const py = ((y + 0.5 + 0.22 * Math.sin(id * 2.39996)) * height) / rows;
      if (py > 0.01 && py < height - 0.01 && !field.isBlocked(Math.floor(px), Math.floor(py))) out.push({ x: px, y: py, id });
    }
  }
  return out;
}

/** Whether a drawn piece between two points stays inside the field and off the buildings. */
export function clearSegment(field: FlowField, ax: number, ay: number, bx: number, by: number): boolean {
  const { width, height, blocked } = field;
  const inside = (x: number, y: number) => x >= 0.01 && x < width - 0.01 && y >= 0.01 && y < height - 0.01;
  if (!inside(ax, ay) || !inside(bx, by)) return false;
  const x0 = Math.floor(ax);
  const y0 = Math.floor(ay);
  const x1 = Math.floor(bx);
  const y1 = Math.floor(by);
  // Most pieces span one or two cells: an empty 2x2 box proves them clear without walking the grid.
  if (Math.abs(x0 - x1) <= 1 && Math.abs(y0 - y1) <= 1) {
    if (!blocked[y0 * width + x0] && !blocked[y0 * width + x1] && !blocked[y1 * width + x0] && !blocked[y1 * width + x1]) return true;
  }
  return !field.crossesBlocked(ax, ay, bx, by);
}

/**
 * Traces a streamline from `seed` with midpoint steps of `STREAM_STEP` cells,
 * downstream for `sign` 1 and upstream for -1. `rate` turns field units into
 * cells per second; it sets each point's travel time.
 */
export function traceStreamline(field: FlowField, seed: { x: number; y: number }, sign: 1 | -1, rate: number): { x: number; y: number; travel: number; station: number }[] {
  const points = [{ x: seed.x, y: seed.y, travel: 0, station: 0 }];
  const limit = Math.min(600, Math.ceil((Math.max(field.width, field.height) / STREAM_STEP) * 0.6));
  const a: [number, number] = [0, 0];
  const m: [number, number] = [0, 0];
  for (let i = 0; i < limit; i++) {
    const p = points[points.length - 1]!;
    field.sample(p.x, p.y, a);
    const speed = Math.hypot(a[0], a[1]);
    if (speed < STILL) break;
    const mx = p.x + (sign * STREAM_STEP * 0.5 * a[0]) / speed;
    const my = p.y + (sign * STREAM_STEP * 0.5 * a[1]) / speed;
    if (!clearSegment(field, p.x, p.y, mx, my)) break;
    field.sample(mx, my, m);
    const mid = Math.hypot(m[0], m[1]);
    if (mid < STILL) break;
    const bx = p.x + (sign * STREAM_STEP * m[0]) / mid;
    const by = p.y + (sign * STREAM_STEP * m[1]) / mid;
    if (!clearSegment(field, p.x, p.y, bx, by)) break;
    // Ends a closed loop without cutting genuine reverse flow short.
    if (i > 20 && Math.hypot(bx - seed.x, by - seed.y) < STREAM_STEP) break;
    points.push({ x: bx, y: by, travel: p.travel + (sign * STREAM_STEP) / (mid * Math.max(1e-9, rate)), station: sign * (i + 1) });
  }
  return points;
}

/** Steady streamlines that morph as the field changes. See the section comment above. */
export class Streamlines {
  /** Seeds of the lines. Placed again at every retrace, since obstacles show only once the wind blows. */
  anchors: { x: number; y: number; id: number }[] = [];
  lines: Streamline[] = [];
  readonly count: number;
  private field: FlowField;
  private sinceTrace = Infinity;

  constructor(field: FlowField, count: number) {
    this.field = field;
    this.count = count;
  }

  setField(field: FlowField): void {
    this.field = field;
  }

  /** Retraces when due, then eases every drawn point by `dt` seconds. */
  update(dt: number, rate: number): void {
    this.sinceTrace += dt;
    if (this.sinceTrace >= RETRACE - 1e-9) {
      this.sinceTrace = 0;
      this.anchors = streamAnchors(this.field, this.count);
      this.accept(
        this.anchors.map((seed) => ({
          id: seed.id,
          points: traceStreamline(this.field, seed, -1, rate).reverse().slice(0, -1).concat(traceStreamline(this.field, seed, 1, rate)),
        })),
      );
    }
    const blend = 1 - Math.exp(-dt / STREAM_EASE);
    for (const line of this.lines) {
      for (const p of line.points) {
        p.x += (p.targetX - p.x) * blend;
        p.y += (p.targetY - p.y) * blend;
        p.travel += (p.targetTravel - p.travel) * blend;
        p.alpha += (p.targetAlpha - p.alpha) * blend;
      }
    }
  }

  private accept(traced: { id: number; points: { x: number; y: number; travel: number; station: number }[] }[]): void {
    const previous = new Map(this.lines.map((line) => [line.id, line]));
    this.lines = traced.map((line) => {
      const old = previous.get(line.id);
      const byStation = new Map(old?.points.map((p) => [p.station, p]) ?? []);
      const points: StreamPoint[] = line.points.map((t) => {
        const point = byStation.get(t.station);
        byStation.delete(t.station);
        if (point) {
          point.targetX = t.x;
          point.targetY = t.y;
          point.targetTravel = t.travel;
          point.targetAlpha = 1;
          return point;
        }
        return { x: t.x, y: t.y, travel: t.travel, station: t.station, alpha: old ? 0 : 1, endFade: 0, targetX: t.x, targetY: t.y, targetTravel: t.travel, targetAlpha: 1 };
      });
      // A line that got shorter fades its old end out instead of dropping it.
      for (const point of byStation.values()) {
        if (point.alpha > 0.005) {
          point.targetAlpha = 0;
          points.push(point);
        }
      }
      points.sort((a, b) => a.station - b.station);
      for (let i = 0; i < points.length; i++) points[i]!.endFade = smooth(Math.min(i, points.length - i) / 10);
      return { id: line.id, points };
    });
  }
}

/** A soft bump, 1 at 0 and 0 beyond ±1: the shape of the light travelling along a ribbon. */
export function bell(t: number): number {
  return Math.abs(t) >= 1 ? 0 : (1 - t * t) ** 2;
}

/** How lit a ribbon is at a point `travel` seconds along it, at animation time `time`. */
export function ribbonLight(travel: number, time: number, id: number): number {
  const t = travel - time + id * 0.618 + 0.3;
  const phase = t - Math.floor(t / 1.7) * 1.7 - 0.3;
  return bell(phase / 0.3);
}

export { smooth as smoothstep01 };

// ---- Facade glow ------------------------------------------------------------
// Ported from the Chalmers demo's FacadeGlow (interactive_map animations/cfd-visuals.js).
// Building faces light up where the wind blows straight at them. It is a
// qualitative exposure proxy (the square of the wind blowing into the face),
// not surface pressure.

/** A short piece of a building's outline, in field cells, with its outward normal. */
export interface FacadeEdge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number;
  ny: number;
}

/**
 * Cuts building outlines (polygons of rings, outer ring first, in field cells,
 * rows down) into pieces of at most `piece` cells with outward normals. Pieces
 * whose middle lies outside the field are dropped.
 */
export function facadeEdges(polygons: [number, number][][][], width: number, height: number, piece = 1.5): FacadeEdge[] {
  const edges: FacadeEdge[] = [];
  for (const polygon of polygons) {
    polygon.forEach((ring, ringIndex) => {
      const n = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.length - 1 : ring.length;
      if (n < 3) return;
      let area = 0;
      for (let i = 0; i < n; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % n]!;
        area += a[0] * b[1] - b[0] * a[1];
      }
      if (Math.abs(area) < 1e-8) return;
      // Holes wind the other way round, so their outside is the courtyard.
      const orientation = Math.sign(area) * (ringIndex === 0 ? 1 : -1);
      for (let i = 0; i < n; i++) {
        const [ax, ay] = ring[i]!;
        const [bx, by] = ring[(i + 1) % n]!;
        const dx = bx - ax;
        const dy = by - ay;
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) continue;
        const count = Math.ceil(length / piece);
        const nx = (orientation * dy) / length;
        const ny = (-orientation * dx) / length;
        for (let j = 0; j < count; j++) {
          const t0 = j / count;
          const t1 = (j + 1) / count;
          const mx = ax + dx * ((t0 + t1) / 2);
          const my = ay + dy * ((t0 + t1) / 2);
          if (mx < 0 || my < 0 || mx > width || my > height) continue;
          edges.push({ ax: ax + dx * t0, ay: ay + dy * t0, bx: ax + dx * t1, by: ay + dy * t1, nx, ny });
        }
      }
    });
  }
  return edges;
}

/** Seconds for the glow to build towards its target, and to fall back. */
const GLOW_RISE = 1.5;
const GLOW_FALL = 0.3;

/** How brightly each facade piece glows, from the wind just outside it. */
export class FacadeGlow {
  readonly edges: FacadeEdge[];
  /** Displayed glow of each edge, 0..1. */
  readonly intensity: Float32Array;
  /** Per edge, the probe stencils: [count, cell, weight, cell, weight, ...] per probe, one after another. */
  private probes: Float64Array[] = [];
  private blockedCount = -1;
  private field: FlowField;

  constructor(field: FlowField, edges: FacadeEdge[]) {
    this.field = field;
    this.edges = edges;
    this.intensity = new Float32Array(edges.length);
    this.place();
  }

  /** Swaps the field. Probes are placed again when its obstacles changed. */
  setField(field: FlowField): void {
    this.field = field;
    this.place();
  }

  /**
   * Places probes in the open air just outside each edge, out to about 2% of the
   * table's longer side, stopping at the next building. Only edges with a building
   * right behind them get probes. Obstacles show only once the wind blows, so this
   * runs again whenever the obstacle mask changes.
   */
  place(): void {
    const g = this.field;
    let count = 0;
    for (let n = 0; n < g.blocked.length; n++) count += g.blocked[n]!;
    if (count === this.blockedCount && this.probes.length === this.edges.length) return;
    this.blockedCount = count;
    const solid = (x: number, y: number) => g.isBlocked(Math.floor(x), Math.floor(y)) && x >= 0 && y >= 0 && x < g.width && y < g.height;
    const reach = Math.max(1.5, 0.0167 * Math.max(g.width, g.height));
    this.probes = this.edges.map((edge) => {
      const x = (edge.ax + edge.bx) / 2;
      const y = (edge.ay + edge.by) / 2;
      const data: number[] = [];
      if (![0.25, 0.75, 1.25].some((d) => solid(x - edge.nx * d, y - edge.ny * d))) return new Float64Array(0);
      let fluid = false;
      let lastX = 0;
      let lastY = 0;
      for (let d = 0.5; d <= Math.max(1.5, reach * 1.5); d += 0.5) {
        const px = x + edge.nx * d;
        const py = y + edge.ny * d;
        if (px < 0 || py < 0 || px >= g.width || py >= g.height) break;
        if (solid(px, py)) {
          if (fluid || d >= 1) break;
          continue;
        }
        // Never sample through another building across a narrow gap.
        if (fluid && g.crossesBlocked(lastX, lastY, px, py)) break;
        const gx = px - 0.5;
        const gy = py - 0.5;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fx = gx - ix;
        const fy = gy - iy;
        const stencil: number[] = [];
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            const n = Math.max(0, Math.min(g.height - 1, iy + dy)) * g.width + Math.max(0, Math.min(g.width - 1, ix + dx));
            if (!g.blocked[n]) stencil.push(n, (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy));
          }
        }
        data.push(stencil.length / 2, ...stencil);
        fluid = true;
        lastX = px;
        lastY = py;
      }
      return Float64Array.from(data);
    });
  }

  /** Moves each edge's glow towards the wind now blowing into it. Field units are m/s. */
  update(dt: number): void {
    const { u, v } = this.field;
    const rise = 1 - Math.exp(-dt / GLOW_RISE);
    const fall = 1 - Math.exp(-dt / GLOW_FALL);
    for (let e = 0; e < this.edges.length; e++) {
      const edge = this.edges[e]!;
      const s = this.probes[e]!;
      let incoming = 0;
      for (let i = 0; i < s.length; ) {
        const end = i + 1 + 2 * s[i]!;
        i++;
        let pu = 0;
        let pv = 0;
        for (; i < end; i += 2) {
          pu += s[i + 1]! * u[s[i]!]!;
          pv += s[i + 1]! * v[s[i]!]!;
        }
        incoming = Math.max(incoming, -(pu * edge.nx + pv * edge.ny));
      }
      const target = 1 - Math.exp(-(incoming * incoming) / 9);
      const current = this.intensity[e]!;
      this.intensity[e] = current + (target - current) * (target > current ? rise : fall);
    }
  }
}
