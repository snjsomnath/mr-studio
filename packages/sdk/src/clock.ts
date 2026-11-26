// A layer's play head (#373): where its time is, kept by the host so every view reads the same.
import type { LayerClock, LayerManifest, RangeControl } from './types.ts';

/** The control a layer's time runs on: its `clock: hour` or `clock: progress` range, if it has one. */
export function clockControl(manifest: LayerManifest | undefined): RangeControl | undefined {
  const time = (manifest?.controls ?? []).find((c) => c.type === 'range' && (c.clock === 'hour' || c.clock === 'progress'));
  return time as RangeControl | undefined;
}

/**
 * Where a play head is at the host's time `now` (milliseconds since 1970), or null without one.
 * Within a control's range, a running clock wraps around for a time of day (a day loops) and stops
 * at the ends for a share of a run (the table starts it again).
 */
export function clockAt(clock: LayerClock | null | undefined, now: number, control?: Pick<RangeControl, 'min' | 'max' | 'clock'>): number | null {
  if (!clock) return null;
  const value = clock.value + (clock.rate * Math.max(0, now - clock.at)) / 1000;
  if (!control || clock.rate === 0 || !(control.max > control.min)) return value;
  if (control.clock !== 'hour') return Math.min(control.max, Math.max(control.min, value));
  const span = control.max - control.min;
  return control.min + ((((value - control.min) % span) + span) % span);
}
