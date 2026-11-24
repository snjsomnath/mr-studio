import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stepTransition, transitionGain } from '../src/transition.ts';

test('a step takes its own transition, else the sequence’s, else a 0.7 s fade', () => {
  const steps = { transition: 'dip' as const, transition_s: 2, sequence: [{ layer: 'a' }, { layer: 'b', transition: 'cut' as const }, { layer: 'c', transition_s: 30 }] };
  assert.deepEqual(stepTransition(steps, 0), { kind: 'dip', seconds: 2 });
  assert.deepEqual(stepTransition(steps, 1), { kind: 'cut', seconds: 0 });
  assert.deepEqual(stepTransition(steps, 2), { kind: 'dip', seconds: 10 });
  assert.deepEqual(stepTransition(undefined, 0), { kind: 'fade', seconds: 0.7 });
  assert.deepEqual(stepTransition({ transition_s: 0 }, 0), { kind: 'cut', seconds: 0 });
});

test('a fade crosses over, a dip goes through the empty map', () => {
  assert.equal(transitionGain('fade', 'in', 0), 0);
  assert.equal(transitionGain('fade', 'in', 1), 1);
  assert.equal(transitionGain('fade', 'in', 0.5) + transitionGain('fade', 'out', 0.5), 1);
  assert.equal(transitionGain('dip', 'out', 0.5), 0);
  assert.equal(transitionGain('dip', 'in', 0.5), 0);
  assert.equal(transitionGain('dip', 'in', 1), 1);
  assert.equal(transitionGain('cut', 'out', 0), 0);
});
