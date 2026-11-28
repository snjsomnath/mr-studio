import { hearsSound } from '@mrstudio/sdk';
import type { LayerState } from '@mrstudio/sdk';

import type { Store } from './store.ts';

/**
 * Interface sounds on the table's speakers (#703): a soft tap when a layer comes on from the
 * controller, which helps across a room with a 46" TV, and a short chime when the table opens
 * for presenting. They are made here, not loaded. Only the table page plays them, never the
 * editor, and only while the controller's sound switch is on. `display.sounds` in site.json is
 * their volume, 0 for none.
 */

/** The volume when the table does not say: quiet, under the layers' own sounds. */
export const DEFAULT_VOLUME = 0.35;

/** After an opening or a reset, layers coming back on are not taps of a visitor. */
const QUIET_AFTER_OPENING_MS = 2500;

export function uiVolume(display: { sounds?: number } | null | undefined): number {
  const v = display?.sounds;
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
}

/** Whether a change of a layer's state is one a visitor made by pressing its button. */
export function isPress(state: LayerState, previous: LayerState | undefined): boolean {
  return state.active && previous !== undefined && !previous.active && !state.parent;
}

let context: AudioContext | null = null;
function audio(): AudioContext | null {
  if (context) return context;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  return context;
}

/** One soft note: a sine that starts at `from` Hz and glides to `to`, with a quick fall. */
function note(ctx: AudioContext, at: number, from: number, to: number, length: number, volume: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

export function playTap(volume: number): void {
  const ctx = audio();
  if (!ctx || volume <= 0) return;
  void ctx.resume().catch(() => {});
  note(ctx, ctx.currentTime, 880, 620, 0.09, 0.25 * volume);
}

export function playChime(volume: number): void {
  const ctx = audio();
  if (!ctx || volume <= 0) return;
  void ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  // A rising fifth, then the octave: short and warm.
  note(ctx, now, 523.25, 523.25, 0.5, 0.18 * volume);
  note(ctx, now + 0.12, 783.99, 783.99, 0.55, 0.16 * volume);
  note(ctx, now + 0.24, 1046.5, 1046.5, 0.8, 0.12 * volume);
}

/** Plays the table's interface sounds from now on. `opened` is called when the table plays its opening. */
export function tableSounds(store: Store): { opened(): void } {
  let quietUntil = performance.now() + QUIET_AFTER_OPENING_MS;
  const volume = () => (hearsSound() ? uiVolume(store.state.site.display as { sounds?: number } | null) : 0);
  store.onLayer((_id, state, previous) => {
    if (performance.now() < quietUntil || !isPress(state, previous)) return;
    playTap(volume());
  });
  return {
    opened() {
      quietUntil = performance.now() + QUIET_AFTER_OPENING_MS;
      playChime(volume());
    },
  };
}
