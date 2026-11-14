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
  private readonly age: Float32Array;
  private readonly stalled: Float32Array;
  private readonly active: Uint8Array;
  private readonly random: () => number;
  private field: FlowField;
  private readonly a: [number, number] = [0, 0];
  private readonly b: [number, number] = [0, 0];

  static readonly capacity = TRAIL_CAPACITY;

  constructor(field: FlowField, options: TracerOptions) {
    this.field = field;
    this.count = options.count;
    this.trailSeconds = options.trailSeconds;
    this.random = options.random ?? Math.random;
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
      if (this.stalled[i]! > MAX_STALL || this.age[i]! > MAX_AGE) {
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

  /** Places a tracer: anywhere at the start, afterwards on the edges the flow enters through. */
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
      if (anywhere) {
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
