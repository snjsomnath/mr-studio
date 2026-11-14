// Staging: the order in which a layer lets things appear. Old layers each had their
// own counters for "reveal the places one by one, wait, then start the flow". A
// Sequence is that as data: named stages that either run for a time or wait for
// someone to press next.

import { clamp01 } from './scale.ts';

export interface Stage {
  id: string;
  /** How long the stage runs before the next starts by itself. Without it the stage waits for `advance()`. */
  seconds?: number;
}

export class Sequence {
  readonly stages: readonly Stage[];
  index = 0;
  /** Seconds spent in the current stage. */
  elapsed = 0;

  constructor(stages: readonly Stage[]) {
    if (stages.length === 0) throw new Error('a sequence needs at least one stage');
    this.stages = stages;
  }

  get stage(): Stage {
    return this.stages[this.index]!;
  }

  /** True while the current stage waits for `advance()`. */
  get waiting(): boolean {
    return this.stage.seconds === undefined;
  }

  /** 0..1 through the current stage. A waiting stage is complete as soon as it is entered. */
  get progress(): number {
    const seconds = this.stage.seconds;
    return seconds === undefined ? 1 : seconds <= 0 ? 1 : clamp01(this.elapsed / seconds);
  }

  /**
   * How far a named stage has come: 0 before it, its progress during it, 1 after.
   * Style values read this, so a reveal needs no special cases:
   * `reveal: sequence.level('draw-lines')`.
   */
  level(id: string): number {
    const at = this.stages.findIndex((stage) => stage.id === id);
    if (at < 0 || this.index < at) return 0;
    return this.index > at ? 1 : this.progress;
  }

  /** Whether a named stage has started. */
  reached(id: string): boolean {
    const at = this.stages.findIndex((stage) => stage.id === id);
    return at >= 0 && this.index >= at;
  }

  /** Advances time. Returns true when the stage changed. */
  tick(dt: number): boolean {
    this.elapsed += dt;
    let changed = false;
    while (this.stage.seconds !== undefined && this.elapsed >= this.stage.seconds && this.index < this.stages.length - 1) {
      this.elapsed -= this.stage.seconds;
      this.index++;
      changed = true;
    }
    return changed;
  }

  /** "Next": leaves a waiting stage. A timed stage is not interrupted. Returns true when it moved. */
  advance(): boolean {
    if (!this.waiting || this.index >= this.stages.length - 1) return false;
    this.index++;
    this.elapsed = 0;
    return true;
  }

  /** Jumps to a stage by id, for presets and story steps. */
  goTo(id: string): boolean {
    const at = this.stages.findIndex((stage) => stage.id === id);
    if (at < 0) return false;
    this.index = at;
    this.elapsed = 0;
    return true;
  }

  reset(): void {
    this.index = 0;
    this.elapsed = 0;
  }
}

/**
 * Spreads one 0..1 progress over `count` items so they appear one after another.
 * `overlap` (0..1) lets the next item start before the previous has finished.
 */
export function stagger(progress: number, index: number, count: number, overlap = 0): number {
  if (count <= 1) return clamp01(progress);
  const each = 1 / (count - (count - 1) * overlap);
  const start = index * each * (1 - overlap);
  return clamp01((progress - start) / each);
}

/** How many of `count` items a 0..1 progress has revealed. */
export function revealedCount(progress: number, count: number): number {
  return Math.min(count, Math.floor(clamp01(progress) * count + 1e-9));
}
