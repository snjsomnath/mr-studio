import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CYCLE_S, hoursOf, onScale, seasonDate, seasonShown, shrink, summary } from '../src/seasons.ts';

test('every season is put on one scale of hours', () => {
  const winter = hoursOf({ data: new Uint8Array([0, 255, 128]), min: 0, max: 6 });
  assert.deepEqual([...winter].map((h) => Math.round(h * 10) / 10), [0, 6, 3]);
  // On midsummer's 18 h scale, winter's best is a third of the way up.
  assert.deepEqual([...onScale(winter, 18)], [0, 85, 43]);
});

test('the summary gives the average and the share that meets a threshold', () => {
  const hours = new Float32Array([0, 2, 5, 9]);
  assert.deepEqual(summary(hours, 0), { mean: 4, pass: null });
  assert.deepEqual(summary(hours, 5), { mean: 4, pass: 0.5 });
});

test('the seasons take turns unless one is pinned', () => {
  assert.equal(seasonShown('cycle', 0), 0);
  assert.equal(seasonShown('cycle', CYCLE_S + 0.1), 1);
  assert.equal(seasonShown('cycle', 3 * CYCLE_S + 0.1), 0);
  assert.equal(seasonShown('dec', 99), 2);
  assert.equal(seasonDate('2027-08-02', 1), '2027-06-21');
});

test('the small map keeps the grid shape', () => {
  const grid = new Uint8Array(400 * 200).map((_, i) => (i % 400 < 200 ? 0 : 255));
  const small = shrink(grid, 400, 200, 100);
  assert.equal(small.w, 100);
  assert.equal(small.h, 50);
  assert.equal(small.data[10], 0);
  assert.equal(small.data[90], 255);
});

test('a window of the day becomes the kernel window in the site time zone', async () => {
  const { windowParams } = await import('../src/look.ts');
  assert.deepEqual(windowParams({ timezone: 'Europe/Stockholm' }, '2026-06-21', 'evening'), { from: '2026-06-21T15:00:00Z', until: '2026-06-21T19:00:00Z' });
  assert.deepEqual(windowParams({ timezone: 'Europe/Stockholm' }, '2026-06-21', 'day'), { from: null, until: null });
});
