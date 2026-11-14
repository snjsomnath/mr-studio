import assert from 'node:assert/strict';
import { test } from 'node:test';

import { arrivals, positionAt, prepareCells, prepareTrips, stepAt } from '../src/trips.ts';

// Tests use plain metres as coordinates.
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);

const raw = {
  format: 1,
  groups: [{ id: 'tram', label: 'Tram', color: '#00ffff' }],
  destination: { label: 'Square', coordinates: [300, 0] },
  trips: [
    {
      group: 'tram',
      legs: [
        // Listed out of order on purpose.
        { start: 200, duration: 50, coordinates: [[100, 0], [300, 0]] },
        { start: 10, duration: 100, coordinates: [[0, 0], [0, 60], [100, 60], [100, 0]] },
      ],
    },
    { group: 'walk', legs: [{ start: 0, duration: 300, coordinates: [[0, 0], [300, 0]] }] },
    { group: 'walk', legs: [{ start: 0, duration: 0, coordinates: [[0, 0], [1, 1]] }, { start: 0, duration: 5, coordinates: [[0, 0]] }] },
  ],
};

test('a trips dataset is checked and prepared', () => {
  const trips = prepareTrips(raw, distance);
  assert.equal(trips.duration, 300);
  assert.deepEqual(trips.groups.map((g) => g.id), ['tram', 'walk']);
  assert.equal(trips.groups[0]!.color, '#00ffff');
  assert.match(trips.groups[1]!.color, /^#/);
  assert.equal(trips.trips.length, 2, 'a trip with no usable leg is dropped');
  assert.deepEqual(trips.trips[0]!.legs.map((l) => l.start), [10, 200]);
  assert.deepEqual(trips.trips[0]!.legs[0]!.stations, [0, 60 / 220, 160 / 220, 1]);
  assert.deepEqual(trips.destination, { label: 'Square', coordinates: [300, 0] });
  assert.throws(() => prepareTrips({}, distance));
  assert.equal(prepareTrips({ trips: [], duration: 60 }, distance).duration, 60);
});

test('a traveller is at home, moving, waiting, then arrived', () => {
  const trip = prepareTrips(raw, distance).trips[0]!;
  assert.deepEqual(positionAt(trip, 0), { point: [0, 0], state: 'home' });
  // Halfway through the first leg by time is halfway by distance: 110 m of 220.
  assert.deepEqual(positionAt(trip, 60), { point: [50, 60], state: 'moving' });
  assert.deepEqual(positionAt(trip, 150), { point: [100, 0], state: 'waiting' });
  assert.deepEqual(positionAt(trip, 225), { point: [200, 0], state: 'moving' });
  assert.deepEqual(positionAt(trip, 250), { point: [300, 0], state: 'arrived' });
});

test('arrivals are counted per group', () => {
  const trips = prepareTrips(raw, distance);
  assert.deepEqual(arrivals(trips, 249), [0, 0]);
  assert.deepEqual(arrivals(trips, 250), [1, 0]);
  assert.deepEqual(arrivals(trips, 300), [1, 1]);
});

test('a cells dataset is checked and its range found', () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  const cells = prepareCells({
    metadata: { unit: 'min', steps: ['07:00', '08:00'] },
    features: [
      { properties: { values: [2, 6] }, geometry: { type: 'Polygon', coordinates: [square] } },
      { properties: { values: [null, 'x'] }, geometry: { type: 'MultiPolygon', coordinates: [[square], [square]] } },
      { properties: { value: 4 }, geometry: { type: 'Point', coordinates: [0, 0] } },
    ],
  });
  assert.equal(cells.cells.length, 3);
  assert.deepEqual(cells.steps, ['07:00', '08:00']);
  assert.deepEqual([cells.min, cells.max], [2, 6]);
  assert.deepEqual(cells.cells[1]!.values, [null, null]);
  const single = prepareCells({ metadata: { min: 0, max: 10 }, features: [{ properties: { value: 4 }, geometry: { type: 'Polygon', coordinates: [square] } }] });
  assert.deepEqual([single.steps, single.min, single.max, single.cells[0]!.values], [[''], 0, 10, [4]]);
  assert.throws(() => prepareCells(null));
});

test('steps share the time evenly', () => {
  assert.deepEqual([0, 0.24, 0.25, 0.5, 0.99, 1].map((f) => stepAt(f, 4)), [0, 0, 1, 2, 3, 3]);
  assert.equal(stepAt(0.7, 1), 0);
});
