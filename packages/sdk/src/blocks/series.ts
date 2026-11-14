// Time series and the clock that plays them. A series is an array with one value per
// step (an hour, a quarter, a departure). A position is a decimal step, so 13.5 on an
// hourly series is half past one.

/** The value of a series at a decimal position. */
export function sampleSeries(values: readonly number[], position: number, options: { interpolate?: boolean; wrap?: boolean } = {}): number {
  const n = values.length;
  if (n === 0) return 0;
  let p = position;
  if (options.wrap) p = ((p % n) + n) % n;
  else p = Math.min(n - 1, Math.max(0, p));
  const i = Math.floor(p);
  if (options.interpolate === false) return values[i] ?? 0;
  const next = options.wrap ? (i + 1) % n : Math.min(n - 1, i + 1);
  const t = p - i;
  return (values[i] ?? 0) * (1 - t) + (values[next] ?? 0) * t;
}

/** The largest absolute value, the usual "against its own busiest hour" reference. */
export function seriesPeak(values: readonly number[]): number {
  let peak = 0;
  for (const v of values) if (Math.abs(v) > peak) peak = Math.abs(v);
  return peak;
}

/** The largest peak over many series: the shared ceiling a whole layer is shaded against. */
export function sharedPeak(series: Iterable<readonly number[] | undefined>): number {
  let peak = 0;
  for (const values of series) if (values) peak = Math.max(peak, seriesPeak(values));
  return peak;
}

/** Element-wise sum of several series. */
export function sumSeries(series: readonly (readonly number[])[]): number[] {
  const n = series.reduce((max, s) => Math.max(max, s.length), 0);
  const out = new Array<number>(n).fill(0);
  for (const s of series) for (let i = 0; i < s.length; i++) out[i]! += s[i]!;
  return out;
}

/** Running total, e.g. energy stored from a charge/discharge series. */
export function cumulative(values: readonly number[], start = 0): number[] {
  let total = start;
  return values.map((v) => (total += v));
}

export interface ClockOptions {
  /** Number of steps in the span, e.g. 24 for a day of hours. */
  span: number;
  /** Steps per second of wall clock while playing. */
  rate?: number;
  loop?: boolean;
  position?: number;
  playing?: boolean;
}

/**
 * The play head of a time series: play, pause, scrub, loop. A layer ticks it from
 * `ctx.onFrame`, or seeks it from a `range` control, and reads `position` or `step`.
 * It holds no timers, so it is deterministic and a paused table costs nothing.
 */
export class Clock {
  span: number;
  rate: number;
  loop: boolean;
  position: number;
  playing: boolean;

  constructor(options: ClockOptions) {
    this.span = Math.max(1, options.span);
    this.rate = options.rate ?? 1;
    this.loop = options.loop ?? true;
    this.position = options.position ?? 0;
    this.playing = options.playing ?? false;
  }

  /** The whole step the play head is in. */
  get step(): number {
    return Math.min(this.span - 1, Math.floor(this.position));
  }

  /** Position as a share of the span, 0..1. */
  get progress(): number {
    return this.position / this.span;
  }

  /** Advances by `dt` seconds. Returns true when the whole step changed. */
  tick(dt: number): boolean {
    if (!this.playing) return false;
    const before = this.step;
    let next = this.position + dt * this.rate;
    if (next >= this.span) {
      if (this.loop) next %= this.span;
      else {
        next = this.span - 1e-9;
        this.playing = false;
      }
    }
    this.position = next;
    return this.step !== before;
  }

  /** Moves the play head. Returns true when the whole step changed. */
  seek(position: number): boolean {
    const before = this.step;
    this.position = Math.min(this.span - 1e-9, Math.max(0, position));
    return this.step !== before;
  }
}
