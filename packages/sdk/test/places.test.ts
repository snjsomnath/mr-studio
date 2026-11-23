import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PLACE_MOTIONS, PLACE_DATA_HELP, placeData, placeMotion, placeUnit, resolvePalette } from '../src/index.ts';
import type { Pen, Shapes, Spot, View } from '../src/index.ts';

const spots: Spot[] = [
  { id: 1, point: [100, 100], properties: { name: 'Library', weight: 80, kind: 'culture' } },
  { id: 2, point: [400, 150], properties: { name: 'Station', weight: 200, kind: 'transport' } },
  { id: 3, point: [250, 400], properties: { name: 'Market', weight: 40, kind: 'culture' } },
];
const grid = (): Shapes => {
  const paths: Shapes['paths'] = [];
  let id = 0;
  for (let x = 0; x <= 500; x += 100) paths.push({ id: id++, points: [[x, 0], [x, 500]], stations: [0, 500], length: 500, properties: {} });
  for (let y = 0; y <= 500; y += 100) paths.push({ id: id++, points: [[0, y], [500, y]], stations: [0, 500], length: 500, properties: {} });
  return { paths, areas: [], spots: [] };
};
const buildings: Shapes = {
  paths: [],
  spots: [],
  areas: [{ id: 'b', centre: [150, 150], polygons: [[[[140, 140], [160, 140], [160, 160], [140, 160], [140, 140]]]], area: 400, properties: {} } as unknown as Shapes['areas'][number]],
};

test('place data reads weights, activity, flows and links, and reports names it cannot find', () => {
  const data = placeData(
    spots,
    {},
    {
      activity: [
        { place: 'Library', time: 8, activity: 0 },
        { place: 'Library', time: 10, activity: 10 },
        { place: 'Nowhere', time: 9, activity: 3 },
      ],
      flows: [{ from: 'Station', to: 'Library', volume: 400 }, { from: 'Market', to: 'Station', volume: 100 }],
    },
    { streets: grid(), buildings },
    resolvePalette(),
    { width: 500, height: 500 },
    10,
  );
  assert.equal(data.places[1]!.weight, 1);
  assert.equal(data.places[2]!.weight, 0.2);
  assert.ok(data.hasActivity);
  assert.equal(data.activity(0, 0), 0);
  assert.ok(Math.abs(data.activity(0, 5) - 0.5) < 1e-9, 'halfway through the cycle is halfway through the times');
  assert.deepEqual(data.flows.map((f) => f.volume), [1, 0.25]);
  assert.deepEqual(data.links, [{ a: 0, b: 2 }], 'places sharing a category are linked');
  assert.ok(data.problems.some((p) => p.includes('Nowhere')));
  assert.ok(data.streets && data.buildings.length === 1);
});

test('every place motion draws on a pen without throwing, and says what data it needs', () => {
  const pen = new Proxy({}, { get: (_, key) => (key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true }) as unknown as Pen;
  const view: View = { pen, scale: 2, time: 0, detail: 1, toPx: ([x, y]) => [x * 2, y * 2] };
  const palette = resolvePalette();
  const data = placeData(spots, {}, {}, { streets: grid(), buildings, targets: { paths: [], areas: [], spots: [{ id: 't', point: [300, 300], properties: {} }] } }, palette, { width: 500, height: 500 });
  assert.equal(PLACE_MOTIONS.length, 22);
  assert.equal(new Set(PLACE_MOTIONS.map((m) => m.id)).size, 22);
  for (const def of PLACE_MOTIONS) {
    assert.ok(def.data in PLACE_DATA_HELP, `${def.id} names a data setup the ? panel knows`);
    const motion = def.create({ data, props: {}, u: placeUnit(0.5), palette });
    for (let t = 0; t < 3; t += 0.2) motion.draw(view, t, 1);
  }
  assert.equal(placeMotion('pilgrims')?.group, 'Cultural gravity');
  // No streets: the street motions draw nothing rather than fail.
  const bare = placeData(spots, {}, {}, {}, palette, { width: 500, height: 500 });
  for (const def of PLACE_MOTIONS) def.create({ data: bare, props: {}, u: 0.625, palette }).draw(view, 1, 1);
});
