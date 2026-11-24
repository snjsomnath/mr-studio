import type { Steps } from './types.ts';

/** How a sequence goes from one step to the next (#43). */
export type StepTransitionKind = 'cut' | 'fade' | 'dip';

/** The transition a sequence uses when nothing says otherwise: the Chalmers demo's cross-fade. */
export const DEFAULT_TRANSITION: { kind: StepTransitionKind; seconds: number } = { kind: 'fade', seconds: 0.7 };
/** The longest a transition may take. */
export const MAX_TRANSITION_S = 10;

/** The transition into step `index` of a sequence: the step's own, else the sequence's, else the default. */
export function stepTransition(steps: Steps | undefined, index: number | undefined): { kind: StepTransitionKind; seconds: number } {
  const step = index === undefined ? undefined : steps?.sequence?.[index];
  const kind = step?.transition ?? steps?.transition ?? DEFAULT_TRANSITION.kind;
  const raw = step?.transition_s ?? steps?.transition_s ?? DEFAULT_TRANSITION.seconds;
  const seconds = kind === 'cut' ? 0 : Math.min(MAX_TRANSITION_S, Math.max(0, Number.isFinite(raw) ? raw : DEFAULT_TRANSITION.seconds));
  return { kind: seconds === 0 ? 'cut' : kind, seconds };
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * How strongly a layer shows `t` (0 to 1) of the way through a transition: the step coming
 * in rises from 0 to 1, the one going falls from 1 to 0. A fade does both at once; a dip lets
 * the old step go first, to the empty map, and brings the new one in after it.
 */
export function transitionGain(kind: StepTransitionKind, role: 'in' | 'out', t: number): number {
  if (kind === 'cut') return role === 'in' ? 1 : 0;
  if (kind === 'dip') return role === 'in' ? smooth(t * 2 - 1) : 1 - smooth(t * 2);
  return role === 'in' ? smooth(t) : 1 - smooth(t);
}
