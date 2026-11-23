import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyseSound, compassBearing, crownRadius, easeVolume, follow, insideBuilding, isovist, outsideBuildings, soundscapeMix, synthBed, viewMoved, viewScene } from '../src/index.ts';
import type { ViewBuilding } from '../src/index.ts';

const square = (x: number, y: number, s: number, type = 'Bostad'): ViewBuilding => ({
  rings: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]],
  type,
});

test('an empty scene sees open sky all round', () => {
  const view = isovist(viewScene([], []), [0, 0], { fov_deg: 360, radius_m: 100 });
  assert.equal(view.stats.rays, 180);
  assert.equal(view.stats.open, 180);
  assert.equal(view.stats.gvf, 0);
  assert.equal(view.polygon.length, 181);
  for (const [x, y] of view.polygon) assert.ok(Math.abs(Math.hypot(x, y) - 100) < 1e-6);
});

test('a building ahead stops the rays that hit it, and is counted by type', () => {
  const scene = viewScene([square(50, -10, 20, 'Verksamhet')], []);
  const view = isovist(scene, [0, 0], { heading: 0, fov_deg: 120, radius_m: 200 });
  const ahead = view.rays.find((r) => Math.abs(r.angle) < 1e-9)!;
  assert.equal(ahead.hit, 'building');
  assert.ok(Math.abs(ahead.dist - 50) < 1e-6);
  assert.deepEqual(view.seenBuildings, [0]);
  assert.ok(view.stats.byType.Verksamhet! > 0);
  assert.equal(view.stats.byType.Verksamhet, view.stats.buildings);
  // A cone starts and ends at the viewer.
  assert.deepEqual(view.polygon[0], [0, 0]);
  assert.deepEqual(view.polygon.at(-1), [0, 0]);
});

test('looking away from a building does not see it', () => {
  const scene = viewScene([square(50, -10, 20)], []);
  const view = isovist(scene, [0, 0], { heading: Math.PI, fov_deg: 120 });
  assert.equal(view.stats.buildings, 0);
});

test('trees block the view and make it green, unless they are left out', () => {
  const scene = viewScene([], [{ x: 30, y: 0, r: 10 }]);
  const green = isovist(scene, [0, 0], { heading: 0, fov_deg: 60 });
  assert.ok(green.stats.gvf > 0.3, `gvf ${green.stats.gvf}`);
  assert.deepEqual(green.seenTrees, [0]);
  const bare = isovist(scene, [0, 0], { heading: 0, fov_deg: 60, trees: false });
  assert.equal(bare.stats.gvf, 0);
});

test('standing under a crown is all leaves', () => {
  const view = isovist(viewScene([], [{ x: 0, y: 0, r: 6 }]), [1, 1], { fov_deg: 360 });
  assert.equal(view.stats.gvf, 1);
});

test('a viewer placed inside a building steps outside it', () => {
  const scene = viewScene([square(0, 0, 20)], []);
  assert.ok(insideBuilding(scene, [10, 10]));
  const out = outsideBuildings(scene, [10, 10]);
  assert.ok(!insideBuilding(scene, out));
  assert.deepEqual(outsideBuildings(scene, [30, 30]), [30, 30]);
});

test('crowns follow the demo: a given radius, else from the height', () => {
  assert.equal(crownRadius({ crown_radius: 4 }), 4);
  assert.equal(crownRadius({ height: 10 }), 5);
  assert.equal(crownRadius({}, 3.5), 3.5);
});

test('the viewer follows the cursor only once it is far away', () => {
  assert.deepEqual(follow([0, 0], [30, 0], 1 / 60), [0, 0]);
  const moved = follow([0, 0], [100, 0], 1 / 60);
  assert.ok(Math.abs(moved[0] - 15) < 1e-9);
});

test('compass bearings follow the table rotation', () => {
  assert.equal(Math.round(compassBearing(-Math.PI / 2, 0)), 0); // up the table is north
  assert.equal(Math.round(compassBearing(0, 0)), 90); // right is east
  assert.equal(Math.round(compassBearing(-Math.PI / 2, 90)), 90); // turned a quarter, up is east
});

test('a view is sent on after 3 m or 15 degrees', () => {
  const last = { point: [0, 0] as const, bearing: 350 };
  assert.ok(!viewMoved(last, [1, 1], 355));
  assert.ok(viewMoved(last, [3, 0], 350));
  assert.ok(viewMoved(last, [0, 0], 6));
});

test('the soundscape mix follows the green view, with floors', () => {
  assert.deepEqual(soundscapeMix(0), { nature: 0, city: 0.5 });
  assert.deepEqual(soundscapeMix(1), { nature: 0.5, city: 0 });
  const half = soundscapeMix(0.5);
  assert.equal(half.nature, 0.25);
  assert.equal(half.city, 0.25);
  // With the demo's 0.5 ceiling its floors never bite; with a lower ceiling they do.
  assert.equal(soundscapeMix(0.2, 0.1).nature, 0.05);
  assert.equal(soundscapeMix(0.8, 0.1).city, 0.05);
  // Easing closes a tenth of the gap per 60th of a second.
  assert.ok(Math.abs(easeVolume(0, 1, 1 / 60) - 0.1) < 1e-9);
});

test('the built-in beds are bright birdsong and low traffic', () => {
  const rate = 16000;
  const nature = analyseSound(synthBed('nature', rate, 6), rate);
  const city = analyseSound(synthBed('city', rate, 6), rate);
  const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(mean(nature.brightness) > mean(city.brightness) * 2, `${mean(nature.brightness)} vs ${mean(city.brightness)}`);
  for (const bed of [synthBed('nature', 8000, 2), synthBed('city', 8000, 2)]) {
    assert.ok(bed.every((v) => Math.abs(v) <= 0.9 + 1e-6));
  }
});
