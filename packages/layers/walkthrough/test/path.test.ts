import assert from 'node:assert/strict';
import { test } from 'node:test';

import { headingAt, makeWalk, pathDataset, videoDataset, videoTime, walkAt, walkOf } from '../src/path.ts';

test('a line without times is walked at an even pace over the video', () => {
  const walk = makeWalk([[0, 0], [30, 0], [30, 10]], null, 40);
  assert.equal(walk.timed, false);
  assert.deepEqual(walk.times, [0, 30, 40]);
  assert.deepEqual(walkAt(walk, 15).at, [15, 0]);
  assert.deepEqual(walkAt(walk, 35).at, [30, 5]);
  assert.equal(walkAt(walk, 35).along, 35);
  assert.deepEqual(walkAt(walk, 99).at, [30, 10]);
  assert.ok(Math.abs(headingAt(walk, 10)!) < 1e-9, 'walks east');
});

test('a line with times keeps the walker where the filmmaker was', () => {
  const geojson = { type: 'Feature', properties: { times: [0, 2, 10] }, geometry: { type: 'LineString', coordinates: [[11, 57], [11.001, 57], [11.002, 57]] } };
  const found = walkOf(geojson);
  assert.deepEqual(found.times, [0, 2, 10]);
  const walk = makeWalk([[0, 0], [10, 0], [20, 0]], found.times, 99);
  assert.deepEqual(walkAt(walk, 1).at, [5, 0]);
  assert.deepEqual(walkAt(walk, 6).at, [15, 0]);
});

test('points with times are walked in time order, from the first', () => {
  const at = (t: unknown, x: number) => ({ type: 'Feature', properties: { time: t }, geometry: { type: 'Point', coordinates: [x, 57] } });
  const found = walkOf({ type: 'FeatureCollection', features: [at('2026-05-01T10:00:05Z', 2), at('2026-05-01T10:00:00Z', 1)] });
  assert.deepEqual(found.lonLat, [[1, 57], [2, 57]]);
  assert.deepEqual(found.times, [0, 5]);
  // Points without times are walked in file order.
  const plain = walkOf({ type: 'FeatureCollection', features: [at(null, 4), at(null, 5)] });
  assert.equal(plain.times, null);
  assert.deepEqual(plain.lonLat, [[4, 57], [5, 57]]);
});

test('the shared clock moves on while playing and loops at the end', () => {
  assert.equal(videoTime({ playing: false, at: 12, since: 0 }, 99_000, 60, true), 12);
  assert.equal(videoTime({ playing: true, at: 12, since: 1000 }, 4000, 60, true), 15);
  assert.equal(videoTime({ playing: true, at: 58, since: 0 }, 5000, 60, true), 3);
  assert.equal(videoTime({ playing: true, at: 58, since: 0 }, 5000, 60, false), 60);
});

test('the video and the walk are found by themselves', () => {
  const site = { data: { buildings: 'data/buildings.geojson', 'vr-movement': 'data/vr-movement.geojson', walk_film: 'data/walk_film.mp4' } };
  assert.equal(videoDataset(site, ''), 'walk_film');
  assert.equal(pathDataset(site, ''), 'vr-movement');
  assert.equal(pathDataset(site, 'buildings'), 'buildings');
  assert.equal(videoDataset({ data: {} }, ''), null);
});
