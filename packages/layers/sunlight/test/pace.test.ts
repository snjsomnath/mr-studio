import assert from 'node:assert/strict';
import { test } from 'node:test';

import { playPace, sharpSoften } from '../src/pace.ts';

test('the day plays at full speed with the sun well up or well down, and lingers at the horizon', () => {
  assert.equal(playPace(40), 1);
  assert.equal(playPace(-20), 1);
  assert.equal(playPace(0), 0.35);
  assert.ok(playPace(5) < playPace(10) && playPace(10) < 1);
  // No jump as the sun crosses the horizon.
  assert.ok(Math.abs(playPace(0.01) - playPace(-0.01)) < 0.01);
});

test('shadows soften as the sun gets low, within a limit', () => {
  assert.ok(sharpSoften(60) < 1.5);
  assert.ok(sharpSoften(5) > sharpSoften(20));
  assert.equal(sharpSoften(0.5), 5);
});
