import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boundFilters,
  boundOverrides,
  filterShapes,
  classBreaks,
  compileLook,
  drawnShare,
  lookFor,
  metresPerTableMm,
  motionFor,
  paintScale,
  paletteColour,
  profileColumns,
  projectionWarning,
  resolvePalette,
  sizeScale,
} from '../src/index.ts';
import type { Pen, Shapes, View } from '../src/index.ts';

test('a palette resolves slots over its set, and ignores what is not a slot or a colour', () => {
  const palette = resolvePalette({ set: 'ember', slots: { accent: '#112233', nonsense: '#ffffff', warm: 'orange' } });
  assert.equal(palette.set.id, 'ember');
  assert.equal(palette.slots.accent, '#112233');
  assert.equal(palette.slots.warm, '#ffb347');
  assert.equal(resolvePalette(null).set.id, 'night');
  assert.deepEqual(paletteColour('@accent', palette), [0x11, 0x22, 0x33, 1]);
  assert.deepEqual(paletteColour('#ff0000', palette), [255, 0, 0, 1]);
});

test('the picker warns about colours too dark to project', () => {
  assert.match(projectionWarning('#101418')!, /Too dark/);
  assert.match(projectionWarning('#5a6170')!, /Dim/);
  assert.equal(projectionWarning('#fbbf24'), null);
});

test('categories take palette slots, with more than six grouped as others (C5)', () => {
  const palette = resolvePalette();
  const rows = ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((kind) => ({ kind }));
  const scale = paintScale({ by: 'kind', kind: 'category' }, rows, palette);
  assert.equal(scale.legend.length, 7);
  assert.equal(scale.legend.at(-1)!.label, 'Others');
  assert.equal(scale.legend[0]!.label, 'a');
  assert.deepEqual(scale.colour({ kind: 'h' }), scale.colour({ kind: 'g' }));
  assert.notDeepEqual(scale.colour({ kind: 'a' }), scale.colour({ kind: 'b' }));
});

test('numbers colour by a ramp, smooth or in classes, and the legend says the ranges', () => {
  const palette = resolvePalette();
  const rows = [0, 10, 20, 30, 40, 100].map((v) => ({ v }));
  assert.deepEqual(classBreaks([0, 10, 20, 30, 40, 100], 'equal', 4), [25, 50, 75]);
  assert.deepEqual(classBreaks([0, 10, 20, 30, 40, 100], 'quantile', 3), [20, 40]);
  const classed = paintScale({ by: 'v', kind: 'number', classes: 'quantile', count: 3 }, rows, palette);
  assert.equal(classed.legend.length, 3);
  assert.match(classed.legend[0]!.label, /^0 – 20$/);
  const smooth = paintScale({ by: 'v', kind: 'number' }, rows, palette);
  const low = smooth.colour({ v: 0 });
  const high = smooth.colour({ v: 100 });
  // C2: lightness carries value, so the top of the ramp is brighter.
  assert.ok(high[0] + high[1] + high[2] > low[0] + low[1] + low[2]);
  assert.deepEqual(smooth.colour({ v: null }), paletteColour('@neutral', palette));
});

test('sizes are table millimetres, fixed or spread by a column', () => {
  assert.equal(metresPerTableMm({ extent: { width_m: 1000, height_m: 600, rotation_deg: 0 }, table: { width_cm: 200, height_cm: 120 } }), 0.5);
  const size = sizeScale({ by: 'n', range: [2, 10] }, [{ n: 0 }, { n: 100 }], 4);
  assert.equal(size({ n: 0 }), 2);
  assert.equal(size({ n: 100 }), 10);
  assert.equal(sizeScale(undefined, [], 4)({}), 4);
});

test('the columns of a dataset are told apart as numbers and categories', () => {
  const profile = profileColumns([{ name: 'A', kind: 'park', n: 1 }, { name: 'B', kind: 'park', n: 5 }, { name: 'C', kind: 'square', n: 9 }]);
  assert.deepEqual(profile.map((c) => [c.name, c.kind]), [['name', 'category'], ['kind', 'category'], ['n', 'number']]);
});

test('a file gets the look of its main geometry (D2)', () => {
  const area = { id: 1, polygons: [], centre: [0, 0] as [number, number], properties: {} };
  assert.equal(lookFor({ areas: [area, area], paths: [], spots: [] }), 'fill');
  assert.equal(lookFor({ areas: [], paths: [], spots: [{ id: 1, point: [0, 0], properties: {} }] }), 'points');
});

test('draw-in reveals lines one after another and ends fully drawn', () => {
  const drawIn = { duration_s: 2, stagger: true };
  assert.equal(drawnShare(0, 3, 0, drawIn), 0);
  assert.equal(drawnShare(2, 3, 0.5, drawIn), 0);
  assert.equal(drawnShare(2, 3, 2, drawIn), 1);
  assert.equal(drawnShare(0, 3, 0, null), 1);
});

test('controls bind to block props, and motion blocks find their look', () => {
  const recipe = {
    controls: [{ id: 'w', type: 'range' as const, label: 'Width', min: 1, max: 8, step: 1, default: 2, bind: 'look.lines.width_mm' }],
    motion: [{ id: 'm', block: 'flow', on: 'lines', props: { speed_mm: 5 } }],
  };
  assert.deepEqual(boundOverrides(recipe, { w: 6 }).look, { lines: { width_mm: 6 } });
  assert.deepEqual(motionFor(recipe, 'lines'), { flow: { speed_mm: 5 } });
  assert.deepEqual(motionFor(recipe, 'other'), {});
});

test('every look draws on a pen without throwing, and gives its legend', () => {
  const calls: string[] = [];
  const pen = new Proxy({}, {
    get: (_, key) => (key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => calls.push(String(key))),
    set: () => true,
  }) as unknown as Pen;
  const view: View = { pen, scale: 2, time: 0.5, detail: 1, toPx: ([x, y]) => [x * 2, y * 2] };
  const shapes: Shapes = {
    spots: [{ id: 1, point: [1, 1], properties: { kind: 'a', name: 'Plaza' } }],
    paths: [{ id: 2, points: [[0, 0], [10, 0]], stations: [0, 10], length: 10, properties: {} }],
    areas: [{ id: 3, polygons: [[[[0, 0], [5, 0], [5, 5], [0, 0]]]], centre: [2, 2], properties: { v: 3 } }],
  };
  const palette = resolvePalette();
  for (const [block, props] of [
    ['points', { color: { by: 'kind', kind: 'category' }, label: 'name' }],
    ['lines', { dash: 'dashed' }],
    ['fill', { color: { by: 'v', kind: 'number' }, shadow_mm: 2, hatch: true, edge_glow: 0.5 }],
  ] as const) {
    const look = compileLook({ id: block, block, props }, shapes, palette, 0.5, { pulse: {}, drawIn: {}, flow: {} });
    look!.draw(view, 0.5, 1);
    if (block !== 'lines') assert.ok(look!.legend.length > 0, `${block} has a legend`);
  }
  assert.ok(calls.includes('stroke') && calls.includes('fill') && calls.includes('fillText'));
  assert.equal(compileLook({ id: 'x', block: 'unknown' }, shapes, palette, 1), null);
});

test('the street network joins lines that meet and routes along them, not across', async () => {
  const { StreetNetwork } = await import('../src/index.ts');
  // An L of streets: along the top, then down the right. The straight line from start to end crosses the block.
  const network = new StreetNetwork([
    [[0, 0], [50, 0], [100, 0]],
    [[100.5, 0.4], [100, 50], [100, 100]],
    [[300, 300], [310, 300]],
  ]);
  assert.equal(network.size, 7, 'the corner snaps into one node');
  const route = network.route([0, 0], [100, 100])!;
  assert.ok(route, 'a route exists');
  assert.ok(Math.abs(route.length - 200) < 1, `it walks the streets, ${route.length} m`);
  assert.equal(network.route([0, 0], [305, 300]), null, 'no route to streets that do not join');
  const tree = network.treeTo([310, 300]);
  assert.equal(network.follow(tree, network.nearest([0, 0])), null, 'unconnected streets have no route');
  assert.deepEqual(network.reachable(tree).length, 1);
});

test('crowds draw for points with streets, and particles for lines', () => {
  const pen = new Proxy({}, { get: (_, key) => (key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true }) as unknown as Pen;
  const view: View = { pen, scale: 2, time: 0, detail: 1, toPx: ([x, y]) => [x * 2, y * 2] };
  const streets: Shapes = { spots: [], areas: [], paths: [{ id: 1, points: [[0, 0], [100, 0]], stations: [0, 100], length: 100, properties: {} }] };
  const shapes: Shapes = { areas: [], paths: streets.paths, spots: [{ id: 1, point: [100, 0], properties: { visitors: 5 } }] };
  const palette = resolvePalette();
  const points = compileLook({ id: 'p', block: 'points' }, shapes, palette, 0.5, { attract: { count: 20 }, gravity: { count: 10, weight: 'visitors', streets } })!;
  for (let t = 0; t < 2; t += 0.1) points.draw(view, t, 1);
  const lines = compileLook({ id: 'l', block: 'lines' }, shapes, palette, 0.5, { particles: { per_line: 3 } })!;
  lines.draw(view, 1, 1);
  assert.deepEqual(motionFor({ motion: [{ id: 'g', block: 'gravity', on: 'p', props: { network: 'roads' } }] }, 'p'), { gravity: { network: 'roads' } });
});

test('core layers read the table palette cheaply and see it change', async () => {
  const { tablePalette } = await import('../src/index.ts');
  const site: { palette?: { set?: string; slots?: Record<string, string> } } = {};
  const first = tablePalette(site);
  assert.equal(tablePalette(site), first, 'the same palette object while nothing changed');
  site.palette = { set: 'ember' };
  const ember = tablePalette(site);
  assert.notEqual(ember, first);
  assert.equal(ember.set.id, 'ember');
  site.palette = { set: 'ember', slots: { green: '#00ff88' } };
  assert.equal(tablePalette(site).slots.green, '#00ff88');
});

test('natural breaks put the class edges in the gaps of the data', async () => {
  const { classBreaks, naturalBreaks } = await import('../src/index.ts');
  assert.deepEqual(classBreaks([31, 1, 12, 2, 10, 3, 30, 11], 'natural', 3), [10, 30]);
  assert.deepEqual(naturalBreaks([5, 5, 5], 3), [], 'one value cannot be split');
  assert.deepEqual(naturalBreaks([1, 1, 9, 9], 4), [9], 'no more classes than distinct values');
  // Large inputs are sampled, and still find the gap.
  const many = [...Array.from({ length: 3000 }, (_, i) => i % 50), ...Array.from({ length: 3000 }, (_, i) => 1000 + (i % 50))].sort((a, b) => a - b);
  const [edge] = naturalBreaks(many, 2);
  assert.ok(edge! >= 1000 && edge! <= 1001, `edge at ${edge}`);
});

test('show only (#38): controls bound to filter.<look>.<column> keep the features that pass', () => {
  const recipe = {
    controls: [
      { id: 'only', type: 'select', label: 'Show', options: [{ value: '', label: 'All' }, { value: 'park', label: 'park' }], default: '', bind: 'filter.zones.use' },
      { id: 'least', type: 'range', label: 'At least', min: 0, max: 100, default: 0, bind: 'filter.zones.pop' },
    ],
  } as unknown as Parameters<typeof boundFilters>[0];
  assert.deepEqual(boundFilters(recipe, {}), {});
  assert.deepEqual(boundFilters(recipe, { only: 'park', least: 20 }), { zones: [{ column: 'use', is: 'park' }, { column: 'pop', atLeast: 20 }] });
  const area = (use: string, pop: number) => ({ id: use + pop, polygons: [], centre: [0, 0] as [number, number], properties: { use, pop } });
  const shapes = { areas: [area('park', 10), area('park', 50), area('home', 80)], paths: [], spots: [] };
  assert.equal(filterShapes(shapes, undefined), shapes);
  assert.deepEqual(filterShapes(shapes, boundFilters(recipe, { only: 'park', least: 20 }).zones).areas.map((a) => a.id), ['park50']);
});
