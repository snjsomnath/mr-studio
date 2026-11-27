import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SiteInfo, TwinMesh } from '@mrstudio/sdk';

import { footprintCorners, proposeLandmarks, tileCrossings } from '../src/model/landmarks.ts';
import type { Footprint } from '../src/model/sun-shadows.ts';

// A 200 x 200 m table. The twin's roofs are raster steps: each building's roof vertices sit a
// little inside and off its real corners, as the height raster draws them.
const site = { grid: { rotation_deg: 0 }, extent: { width_m: 200, height_m: 200 } } as unknown as SiteInfo;

function twin(): TwinMesh {
  const positions: number[] = [];
  const kinds: number[] = [];
  const buildings: number[] = [];
  const vertex = (x: number, y: number, z: number, kind: number, building: number) => {
    positions.push(x, y, z);
    kinds.push(kind);
    buildings.push(building);
  };
  for (const [x, y] of [[-100, -100], [100, -100], [100, 100], [-100, 100]] as const) vertex(x, y, 0, 0, 0);
  // Building 1, 20 m: stair-stepped roof cells.
  for (const [x, y] of [[-58, 41], [-41, 42], [-43, 58], [-21, 22], [-22, 39]] as const) vertex(x, y, 20, 1, 1);
  // Building 2, 10 m.
  for (const [x, y] of [[31, -59], [58, -61], [59, -31], [29, -32]] as const) vertex(x, y, 10, 1, 2);
  // Building 3 hangs off the table's edge.
  for (const [x, y] of [[90, 80], [104, 95]] as const) vertex(x, y, 30, 1, 3);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    kinds: new Uint8Array(kinds),
    buildings: new Uint32Array(buildings),
    indices: new Uint32Array(0),
    minZ: 0,
    maxZ: 30,
  } as unknown as TwinMesh;
}

// An L: five outward corners and one notch at (-40, 40). Drawn counter-clockwise, closed, with a
// stray point half way along one wall.
const lShape: Footprint = {
  number: 1,
  rings: [[[-60, 20], [-20, 20], [-20, 40], [-40, 40], [-40, 60], [-60, 60], [-60, 40], [-60, 20]]],
};
// Clockwise, to check either winding works.
const block: Footprint = { number: 2, rings: [[[30, -30], [60, -30], [60, -60], [30, -60], [30, -30]]] };
const offTable: Footprint = { number: 3, rings: [[[90, 80], [110, 80], [110, 100], [90, 100]]] };

test('footprint corners are the outward corners, at the roof height, on the table (#595)', () => {
  const mesh = twin();
  const roofs = new Map<number, number[]>([
    [1, [4, 5, 6, 7, 8]],
    [2, [9, 10, 11, 12]],
    [3, [13, 14]],
  ]);
  const corners = footprintCorners(mesh, site, [lShape, block, offTable], roofs, 0);
  const of = (b: number) => corners.filter((c) => c.building === b).map((c) => c.point.map((n) => Math.round(n)).join(','));
  assert.deepEqual(of(1).sort(), ['-20,20,20', '-20,40,20', '-40,60,20', '-60,20,20', '-60,60,20']);
  assert.ok(!of(1).includes('-40,40,20'), 'the notch is no corner to aim at');
  assert.equal(of(2).length, 4);
  assert.ok(of(2).every((p) => p.endsWith(',10')));
  assert.equal(of(3).length, 0, 'a building off the table is left out');
  const topRight = corners.find((c) => c.building === 2 && c.point[0] === 60 && c.point[1] === -30)!;
  assert.match(topRight.label, /^The top right corner of the roof of the building 10 m tall/);
});

test('with footprints the proposed roof corners are real footprint corners, without them raster steps', () => {
  const mesh = twin();
  const real = new Set(
    [lShape, block].flatMap((f) => f.rings[0]!.map(([x, y]) => `${x},${y}`)),
  );
  const withFootprints = proposeLandmarks(mesh, site, 6, [lShape, block, offTable]);
  assert.equal(withFootprints.length, 10);
  const roofs = withFootprints.slice(4);
  assert.ok(roofs.every((l) => real.has(`${l.point[0]},${l.point[1]}`)), 'every roof corner is a corner of a footprint');
  assert.ok(roofs.some((l) => l.building === 1) && roofs.some((l) => l.building === 2), 'both buildings are used');

  const without = proposeLandmarks(mesh, site, 6, null).slice(4);
  assert.ok(without.some((l) => !real.has(`${l.point[0]},${l.point[1]}`)), 'the old way picks raster steps');
});

test('a table of 20 cm tiles offers the crossings of its seams, not those under buildings (#651)', () => {
  const mesh = twin();
  const tiled = { ...site, table: { width_cm: 100, height_cm: 100, tile_cm: 20 } } as unknown as SiteInfo;
  const roofs = new Map<number, number[]>([
    [1, [4, 5, 6, 7, 8]],
    [2, [9, 10, 11, 12]],
    [3, [13, 14]],
  ]);
  const crossings = tileCrossings(mesh, tiled, [0, 1, 2, 3], roofs);
  const at = crossings.map((c) => `${Math.round(c.point[0])},${Math.round(c.point[1])}`);
  // 4 x 4 seams cross inside the table; two of the crossings are under a roof.
  assert.equal(crossings.length, 14);
  for (const hidden of ['-20,20', '60,-60']) assert.ok(!at.includes(hidden), `${hidden} is under a building`);
  assert.ok(at.includes('-60,-60') && at.includes('60,60'));
  assert.match(crossings[0]!.label, /^Where the tiles meet, 1 tile from the left and 4 from the top/);
  assert.equal(crossings[0]!.point[2], 0);

  // A table not made of whole tiles has none, and nor does one with no tile size.
  assert.equal(tileCrossings(mesh, { ...tiled, table: { width_cm: 110, height_cm: 100, tile_cm: 20 } } as unknown as SiteInfo, [0, 1, 2, 3], roofs).length, 0);
  assert.equal(tileCrossings(mesh, site, [0, 1, 2, 3], roofs).length, 0);

  // A footprint hides the crossings it covers, even where the twin has no roof vertex near.
  const square: Footprint = { number: 9, rings: [[[10, -30], [30, -30], [30, -10], [10, -10]]] };
  const withSquare = tileCrossings(mesh, tiled, [0, 1, 2, 3], roofs, [square]).map((c) => `${Math.round(c.point[0])},${Math.round(c.point[1])}`);
  assert.equal(withSquare.length, 13);
  assert.ok(!withSquare.includes('20,-20'));

  // Proposed after the base and roof corners, spread out.
  const proposed = proposeLandmarks(mesh, tiled, 6, [lShape, block, offTable], 4);
  assert.equal(proposed.length, 14);
  assert.ok(proposed.slice(10).every((l) => l.label.startsWith('Where the tiles meet')));
});
