/**
 * The frame budget meter (#262): how fast this window draws, the worst frame of the last
 * 10 s, and what each layer's own code costs per frame (its frame callbacks and handlers, as
 * the layer manager runs them). The map library's drawing is not per layer, so it shows in
 * the frame time but in no layer's cost.
 */

/** How far back the worst frame is looked for. */
const WINDOW_MS = 10_000;
/** How quickly the averages follow: about the last 30 frames. */
const SMOOTH = 1 / 30;

interface LayerCost {
  /** Milliseconds per frame, averaged. */
  ms: number;
  /** The most it took in one frame within the window, and when. */
  worst: number;
  worstAt: number;
  /** What it took in the frame being drawn now. */
  now: number;
}

export interface FrameReport {
  fps: number;
  /** The longest frame within the last 10 s, in ms. */
  worst_ms: number;
  /** JS heap in use, in MB, where the browser says (Chromium and Edge). */
  heap_mb?: number;
  /** The layers by cost per frame, costliest first. */
  layers: { id: string; ms: number; worst_ms: number }[];
}

export class FrameMeter {
  private layers = new Map<string, LayerCost>();
  private interval = 1000 / 60;
  private frames: { at: number; ms: number }[] = [];
  private last = 0;
  private running = false;

  /** Starts counting frames. Safe to call more than once. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = (now: number) => {
      this.tick(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** One frame was drawn at `now`. Exposed for tests. */
  tick(now: number): void {
    if (this.last > 0) {
      const ms = now - this.last;
      // A hidden window stops drawing; that pause is not a slow frame.
      if (document.visibilityState === 'visible' && ms < 60_000) {
        this.interval += (ms - this.interval) * SMOOTH;
        this.frames.push({ at: now, ms });
      }
    }
    this.last = now;
    while (this.frames.length > 0 && now - this.frames[0]!.at > WINDOW_MS) this.frames.shift();
    for (const cost of this.layers.values()) {
      cost.ms += (cost.now - cost.ms) * SMOOTH;
      if (cost.now >= cost.worst || now - cost.worstAt > WINDOW_MS) {
        cost.worst = cost.now;
        cost.worstAt = now;
      }
      cost.now = 0;
    }
  }

  /** Runs `work` for layer `id` and adds the time it took to this frame's cost of the layer. */
  time<T>(id: string, work: () => T): T {
    const start = performance.now();
    try {
      return work();
    } finally {
      this.add(id, performance.now() - start);
    }
  }

  /** Adds `ms` to this frame's cost of layer `id`. */
  add(id: string, ms: number): void {
    let cost = this.layers.get(id);
    if (!cost) this.layers.set(id, (cost = { ms: 0, worst: 0, worstAt: 0, now: 0 }));
    cost.now += ms;
  }

  /** Forgets a layer that stopped. */
  drop(id: string): void {
    this.layers.delete(id);
  }

  report(): FrameReport {
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    const layers = [...this.layers.entries()]
      .map(([id, c]) => ({ id, ms: round(c.ms), worst_ms: round(c.worst) }))
      .sort((a, b) => b.ms - a.ms);
    return {
      fps: round(1000 / Math.max(1, this.interval)),
      worst_ms: round(this.frames.reduce((most, f) => Math.max(most, f.ms), 0)),
      heap_mb: memory ? Math.round(memory.usedJSHeapSize / 1e6) : undefined,
      layers,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** This window's meter. */
export const meter = new FrameMeter();

/** The frame rate a table should keep. */
export const TARGET_FPS = 60;

/** Below this share of the target, a table is called slow. */
export const SLOW_SHARE = 0.9;
