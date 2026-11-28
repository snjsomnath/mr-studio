import assert from 'node:assert/strict';
import { test } from 'node:test';

import { darkness, hasShape, planOpening, progress, PHASES } from '../src/opening.ts';

const line = (x: number) => ({ type: 'LineString', coordinates: [[x, 0], [x + 0.001, 0]] });

test('streets nearer the middle trace in first, and the far ones end the phase (#697)', () => {
  const plan = planOpening([0, 0], { streets: [line(0.01), line(0)], buildings: [], trees: [] });
  assert.deepEqual(plan.streets.map((s) => s.at), [1, 0]);
  assert.equal(progress(0, PHASES.streets, 0), 0);
  assert.equal(progress(PHASES.streets[1], PHASES.streets, 1), 1, 'the farthest street is drawn by the end of its phase');
  assert.ok(progress(0.1, PHASES.streets, 0) > progress(0.1, PHASES.streets, 1));
});

test('the dark holds until the lift and is gone at the end; a table with no streets or buildings fades', () => {
  assert.equal(darkness(0.5), 1);
  assert.equal(darkness(1), 0);
  assert.equal(hasShape(planOpening([0, 0], { streets: [], buildings: [], trees: [{ type: 'Point', coordinates: [0, 0] }] })), false);
});
