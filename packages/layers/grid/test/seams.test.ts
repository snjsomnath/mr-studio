import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seams } from '../src/seams.ts';

test('the Chalmers table is 5 × 3 tiles of 20 cm', () => {
  const site = { extent: { width_m: 1250, height_m: 750, rotation_deg: -92.555 }, table: { width_cm: 100, height_cm: 60, tile_cm: 20 } };
  const { xs, ys } = seams(site, 0);
  assert.deepEqual(xs, [0, 250, 500, 750, 1000, 1250]);
  assert.deepEqual(ys, [0, 250, 500, 750]);
});

test('a table that is not whole tiles ends with a part tile; a size of its own wins', () => {
  const site = { extent: { width_m: 500, height_m: 300, rotation_deg: 0 }, table: { width_cm: 50, height_cm: 30, tile_cm: 20 } };
  assert.deepEqual(seams(site, 0).xs, [0, 200, 400, 500]);
  assert.deepEqual(seams(site, 25).xs, [0, 250, 500]);
});
