import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ARRIVAL_S, PLACE_MOTIONS, PLACE_DATA_HELP, placeData, placeFit, placeMotion, placeSpacing, placeStepTitles, placeUnit, resolvePalette } from '../src/index.ts';
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

test('a place motion fits the places on the table: closer places, shorter reach, smaller marks (#341)', () => {
  // Seven places on a 1600 x 1000 du district, as in the preview: the fit is about 1.
  const u = placeUnit(1);
  const preview = [[200, 206], [680, 206], [1280, 323], [440, 559], [920, 677], [1400, 677], [800, 441]].map(([x, y], i) => ({ id: i, point: [x! * u, y! * u] as [number, number], properties: {} }));
  const fit = placeFit(placeData(preview, {}, {}, {}, resolvePalette(), { width: 2000, height: 1250 }), u);
  assert.ok(fit.scale > 0.85 && fit.scale < 1.2, `preview fit ${fit.scale}`);
  // The same places five times closer: distances shrink five times, marks by the square root, kept at half or more.
  const close = preview.map((s) => ({ ...s, point: [s.point[0] / 5, s.point[1] / 5] as [number, number] }));
  const near = placeFit(placeData(close, {}, {}, {}, resolvePalette(), { width: 400, height: 250 }), u);
  assert.ok(Math.abs(near.scale / fit.scale - 0.2) < 0.01);
  assert.ok(near.mark >= 0.45 * u && near.mark < fit.mark);
  // The author's Scale multiplies it; one place has nothing to fit to.
  assert.ok(Math.abs(placeFit(placeData(close, {}, {}, {}, resolvePalette(), { width: 400, height: 250 }), u, 2).scale / near.scale - 2) < 1e-9);
  assert.equal(placeFit(placeData(close.slice(0, 1), {}, {}, {}, resolvePalette(), { width: 400, height: 250 }), u).scale, 1);
  assert.ok(Number.isNaN(placeSpacing([[0, 0]])));
});

test('a place motion that steps draws nothing, then the places, then the motion (#341)', () => {
  let drawn = 0;
  const pen = new Proxy({}, { get: (_, key) => (key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : key === 'drawImage' || key === 'arc' ? () => drawn++ : () => {}), set: () => true }) as unknown as Pen;
  const view: View = { pen, scale: 2, time: 0, detail: 1, toPx: ([x, y]) => [x * 2, y * 2] };
  const stage = { revealed: 0, since: 0 };
  const data = placeData(spots, {}, {}, {}, resolvePalette(), { width: 500, height: 500 });
  const motion = placeMotion('ripples')!.create({ data, props: {}, u: placeUnit(1), palette: resolvePalette(), stage: () => stage });
  motion.draw(view, 5, 1);
  assert.equal(drawn, 0, 'nothing before the first Next');
  Object.assign(stage, { revealed: 1, since: 5 });
  motion.draw(view, 5.1, 1);
  const first = drawn;
  assert.ok(first > 0, 'the first place arrives');
  drawn = 0;
  motion.draw(view, 5 + 3 * ARRIVAL_S, 1);
  assert.ok(drawn > first, 'more places later');
  assert.deepEqual(placeStepTitles('pilgrims'), ['The places', 'Pilgrims']);
});
