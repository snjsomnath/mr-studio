import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nearest, ordered, step, tracks } from '../src/spots.ts';
import type { Spot } from '../src/spots.ts';

const spot = (id: string, walker: string, at: number, x = 0): Spot => ({
  id,
  kind: 'photo',
  at,
  lon: x,
  lat: 0,
  placed: 'gps',
  file: `${id}.jpg`,
  mime: 'image/jpeg',
  bytes: 1,
  walker: { id: walker, name: walker },
});

test('spots group by walker, in time order', () => {
  const spots = [spot('c', 'bo', 30), spot('a', 'ada', 10), spot('b', 'bo', 5), spot('d', 'ada', 20)];
  const t = tracks(spots);
  assert.deepEqual(
    t.map((w) => w.walker.id),
    ['bo', 'ada'],
  );
  assert.deepEqual(
    t[0]!.spots.map((s) => s.id),
    ['b', 'c'],
  );
  assert.ok(t[0]!.colour && t[1]!.colour && t[0]!.colour !== t[1]!.colour);
  assert.deepEqual(
    ordered(spots).map((s) => s.id),
    ['b', 'c', 'a', 'd'],
  );
});

test('previous and next wrap round', () => {
  const spots = [spot('a', 'ada', 1), spot('b', 'ada', 2)];
  assert.equal(step(spots, 'b', 1)!.id, 'a');
  assert.equal(step(spots, 'a', -1)!.id, 'b');
  assert.equal(step(spots, '', 1)!.id, 'a');
  assert.equal(step([], '', 1), null);
});

test('a tap picks the nearest spot within reach', () => {
  const spots = [spot('a', 'ada', 1, 0), spot('b', 'ada', 2, 10)];
  const xy = (s: Spot) => [s.lon, s.lat] as const;
  assert.equal(nearest(spots, [8, 0], 5, xy)!.id, 'b');
  assert.equal(nearest(spots, [50, 0], 5, xy), null);
});
