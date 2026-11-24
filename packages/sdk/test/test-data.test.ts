import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TEST_DATA, makeTestData, parseCsv, placeData, readShapes, resolvePalette, tableFrame } from '../src/index.ts';
import type { GeoJsonCollection } from '../src/index.ts';

// A rotated table, so "inside" is checked in table metres, not in degrees.
const site = { origin: { lon: 11.97, lat: 57.7 }, extent: { width_m: 1000, height_m: 600, rotation_deg: 20 } };
const frame = tableFrame(site);

for (const def of TEST_DATA) {
  test(`${def.label.toLowerCase()} land inside the table (#308)`, () => {
    const [main] = makeTestData(def.kind, site, 7);
    const shapes = readShapes(JSON.parse(main!.text) as GeoJsonCollection, frame);
    const all = [...shapes.spots.map((s) => [s.point]), ...shapes.paths.map((p) => p.points), ...shapes.areas.flatMap((a) => a.polygons.flat())];
    assert.ok(all.length > 0);
    for (const points of all) for (const p of points) assert.ok(frame.contains(p, 0.01), `${p} is off the table`);
    const kind = def.geometry === 'points' ? shapes.spots : def.geometry === 'lines' ? shapes.paths : shapes.areas;
    assert.equal(kind.length, all.length, 'one geometry only');
  });
}

test('the same seed makes the same data, another seed other data', () => {
  assert.equal(makeTestData('points', site, 3)[0]!.text, makeTestData('points', site, 3)[0]!.text);
  assert.notEqual(makeTestData('points', site, 3)[0]!.text, makeTestData('points', site, 4)[0]!.text);
});

test('points carry a category, a number and a year to style by', () => {
  const rows = JSON.parse(makeTestData('points', site, 1)[0]!.text).features.map((f: { properties: object }) => f.properties);
  assert.equal(rows.length, 60);
  for (const row of rows) {
    assert.equal(typeof row.kind, 'string');
    assert.ok(row.value >= 0 && row.value <= 100);
    assert.ok(row.year >= 1990 && row.year <= 2025);
  }
});

test('places come with activity, flows and links that every place motion reads without a problem', () => {
  const files = makeTestData('places', site, 11);
  assert.deepEqual(files.map((f) => f.suffix), ['', '-activity', '-flows', '-links']);
  const shapes = readShapes(JSON.parse(files[0]!.text) as GeoJsonCollection, frame);
  const table = (suffix: string) => parseCsv(files.find((f) => f.suffix === suffix)!.text);
  const data = placeData(shapes.spots, {}, { activity: table('-activity'), flows: table('-flows'), links: table('-links') }, {}, resolvePalette(undefined), frame);
  assert.deepEqual(data.problems, []);
  assert.equal(data.places.length, 12);
  assert.ok(data.hasActivity);
  assert.ok(data.flows.length >= 10);
  assert.ok(data.links.length >= 12);
  assert.ok(new Set(data.places.map((p) => p.category)).size >= 4);
  // Activity rises and falls over the day.
  const levels = Array.from({ length: 24 }, (_, t) => data.activity(0, t));
  assert.ok(Math.max(...levels) - Math.min(...levels) > 0.3);
});
