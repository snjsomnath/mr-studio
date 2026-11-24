import assert from 'node:assert/strict';
import { test } from 'node:test';

import { colormaps } from '../src/colormap.ts';
import {
  CUE_SECONDS,
  Agent,
  Clock,
  Dwell,
  Lens,
  PerPointer,
  Probe,
  Sequence,
  Swarm,
  arc,
  aroundRing,
  bars,
  binLegend,
  binScale,
  categoryScale,
  centroid,
  clusterPoints,
  colour,
  columns,
  contours,
  css,
  cumulative,
  drawAreas,
  drawCue,
  drawLens,
  drawPaths,
  drawRings,
  drawSpots,
  fieldGradient,
  foldKey,
  formatNumber,
  fromToolInput,
  geojsonSource,
  gravity,
  gravityField,
  heatField,
  hitTest,
  offTable,
  joinRows,
  keepOnTable,
  levelScale,
  liveSource,
  measurePath,
  nodeBalance,
  nodePulse,
  parseCsv,
  pathHeads,
  pickWeighted,
  pointAlong,
  pointInPolygon,
  pointerRouter,
  pullTowards,
  rampScale,
  readShapes,
  revealedCount,
  sampleField,
  sampleSeries,
  seeded,
  sharedPeak,
  shares,
  stagger,
  stat,
  tableFrame,
  tableView,
  timeline,
  trend,
  zoomedView,
} from '../src/blocks/index.ts';
import type { Fetcher, GeoJsonCollection, Pen, PointerSample } from '../src/blocks/index.ts';

const site = {
  origin: { lon: 11.9778, lat: 57.6884 },
  extent: { width_m: 1000, height_m: 600, rotation_deg: 0 },
  grid: { width: 500, height: 300, cell_m: 2, rotation_deg: 0 },
};
const frame = tableFrame(site);
const near = (a: number, b: number, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`);

/** A pen that records what was drawn. */
function recorder() {
  const calls: { op: string; args: unknown[]; fillStyle: unknown; strokeStyle: unknown; lineWidth: number }[] = [];
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1 };
  const pen = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return (...args: unknown[]) => {
        calls.push({ op: key, args, fillStyle: target.fillStyle, strokeStyle: target.strokeStyle, lineWidth: target.lineWidth as number });
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as Pen;
  return { pen, calls, ops: (op: string) => calls.filter((c) => c.op === op) };
}

// ---- Geometry ---------------------------------------------------------------

test('the table frame matches the engine grid, with and without rotation', () => {
  // The origin is the centre of the table.
  assert.deepEqual(frame.toTable([11.9778, 57.6884]), [500, 300]);
  // North is up: a point 100 m north is 100 m nearer the top edge.
  const north = frame.toLonLat([500, 200]);
  near(north[0], 11.9778);
  near((north[1] - 57.6884) * 111_370, 100, 0.1);
  // Round trip.
  const back = frame.toTable(frame.toLonLat([123.4, 456.7]));
  near(back[0], 123.4);
  near(back[1], 456.7);
  assert.ok(frame.contains([0, 0]) && !frame.contains([-1, 0]) && frame.contains([-1, 0], 2));

  // mrs-engine: with the table's up edge at bearing 90 (east), 10 m east of the origin is 10 m towards row 0.
  const rotated = tableFrame({ ...site, extent: { ...site.extent, rotation_deg: 90 } });
  const east = rotated.toTable(tableFrame(site).toLonLat([510, 300]));
  near(east[0], 500);
  near(east[1], 290);
});

test('paths are measured and walked', () => {
  const path = measurePath([[0, 0], [30, 0], [30, 40]]);
  assert.equal(path.length, 70);
  assert.deepEqual(pointAlong(path, 0.5).point, [30, 5]);
  near(pointAlong(path, 0.5).heading, Math.PI / 2);
  assert.deepEqual(pointAlong(path, 2).point, [30, 40]);
  const curve = arc([0, 0], [100, 0], 0.2);
  assert.deepEqual(curve[0], [0, 0]);
  assert.deepEqual(curve.at(-1), [100, 0]);
  near(curve[12]![1], 10);
});

test('polygons know their centre and what is inside them', () => {
  const square = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] as const;
  assert.deepEqual(centroid(square), [5, 5]);
  const courtyard = [square[0], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] as const;
  assert.ok(pointInPolygon([1, 1], courtyard));
  assert.ok(!pointInPolygon([5, 5], courtyard));
  assert.ok(!pointInPolygon([11, 5], courtyard));
});

// ---- Sources ----------------------------------------------------------------

const collection: GeoJsonCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { id: 'Kårhus', demand: [1, 4, 2] }, geometry: { type: 'Polygon', coordinates: [[frame.toLonLat([100, 100]), frame.toLonLat([200, 100]), frame.toLonLat([200, 200]), frame.toLonLat([100, 200]), frame.toLonLat([100, 100])]] } },
    { type: 'Feature', properties: { id: 'grid-to-karhus' }, geometry: { type: 'LineString', coordinates: [frame.toLonLat([0, 0]), frame.toLonLat([300, 400])] } },
    { type: 'Feature', properties: { id: 'grid', kind: 'grid' }, geometry: { type: 'Point', coordinates: frame.toLonLat([0, 0]) } },
    { type: 'Feature', properties: { id: 'nothing' }, geometry: null },
  ],
};

test('GeoJSON becomes shapes in table metres', async () => {
  const shapes = readShapes(await geojsonSource(collection).load(), frame, 'id');
  assert.equal(shapes.areas.length, 1);
  assert.equal(shapes.areas[0]!.id, 'Kårhus');
  near(shapes.areas[0]!.centre[0], 150, 1e-4);
  near(shapes.paths[0]!.length, 500, 1e-4);
  near(shapes.spots[0]!.point[0], 0, 1e-4);

  const fetcher: Fetcher = async () => ({ ok: false, status: 404, text: async () => '', json: async () => null });
  await assert.rejects(geojsonSource('/site/data/missing.geojson', { fetch: fetcher }).load(), /404/);
});

test('CSV parses with quotes, separators and numbers, and joins onto shapes', async () => {
  const rows = parseCsv('﻿name;class;kwh\r\n"Karhus";B;12.5\n"Edit ""EDIT"" building";D;1e3\n\n');
  assert.deepEqual(rows, [
    { name: 'Karhus', class: 'B', kwh: 12.5 },
    { name: 'Edit "EDIT" building', class: 'D', kwh: 1000 },
  ]);
  assert.deepEqual(columns(rows, ['kwh']), { kwh: [12.5, 1000] });
  assert.equal(foldKey('Kårhus (A)'), 'karhusa');

  const shapes = readShapes(collection, frame, 'id');
  const joined = joinRows(shapes.areas, rows, { shape: 'id', row: 'name' });
  assert.equal(joined.matched, 1);
  assert.equal(shapes.areas[0]!.properties.class, 'B');
  assert.equal(joinRows(shapes.spots, rows, { shape: 'id', row: 'name' }).unmatched.length, 1);
});

test('a live source polls while watched, keeps the last value on failure and backs off', async () => {
  const replies: (number | Error)[] = [1, 1, new Error('down'), 2];
  const waits: number[] = [];
  let pending: (() => void) | null = null;
  const fetcher: Fetcher = async () => {
    const reply = replies.shift()!;
    if (reply instanceof Error) throw reply;
    return { ok: true, status: 200, text: async () => '', json: async () => ({ level: reply }) };
  };
  const source = liveSource('/api/battery', {
    every: 5,
    fetch: fetcher,
    parse: (body) => (body as { level: number }).level,
    timer: { set: (run, ms) => ((waits.push(ms), (pending = run)), 1), clear: () => (pending = null) },
  });
  const values: number[] = [];
  const errors: string[] = [];
  const stop = source.watch((v) => values.push(v), (e) => errors.push(e.message));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 3; i++) {
    await settle();
    pending!();
  }
  await settle();
  assert.deepEqual(values, [1, 2], 'an unchanged value is not repeated');
  assert.deepEqual(errors, ['down']);
  assert.deepEqual(waits, [5000, 5000, 10000, 5000]);
  stop();
  assert.equal(pending, null, 'polling stops with the last watcher');
});

// ---- Scales, series, readouts -------------------------------------------------

test('scales map values to levels and colours', () => {
  assert.deepEqual(colour('#f80'), [255, 136, 0, 1]);
  assert.deepEqual(colour('#00ffe580').map((v) => Math.round(v * 100) / 100), [0, 255, 229, 0.5]);
  assert.equal(css(colour('rgb(1, 2, 3)'), 0.5), 'rgba(1,2,3,0.5)');

  const demand = levelScale({ domain: [0, 1286], curve: 'sqrt', floor: 0.35 });
  assert.equal(demand(0), 0.35);
  assert.equal(demand(1286), 1);
  assert.ok(demand(0.04) > 0.35 && demand(0.04) < 0.36, 'a tiny member is still visibly a member');

  const ramp = rampScale(colormaps.speed);
  assert.deepEqual(ramp(0).slice(0, 3), [59, 130, 246]);
  assert.deepEqual(ramp(1).slice(0, 3), [239, 68, 68]);

  const delay = binScale([0, 5, 10], ['#000', '#888', '#fff']);
  assert.deepEqual([delay(-1)[0], delay(4.9)[0], delay(5)[0], delay(99)[0]], [0, 0, 136, 255]);
  assert.deepEqual(binLegend([0, 5, 10], ['#000', '#888', '#fff'], 'min').map((e) => e.label), ['0–5 min', '5–10 min', '10+ min']);

  const energyClass = categoryScale({ A: '#00ff00', G: '#ff0000' });
  assert.deepEqual(energyClass('G').slice(0, 3), [255, 0, 0]);
  assert.deepEqual(energyClass(undefined).slice(0, 3), [107, 114, 128]);
});

test('series are sampled and the clock plays, loops and scrubs', () => {
  assert.equal(sampleSeries([0, 10, 20], 1.5), 15);
  assert.equal(sampleSeries([0, 10, 20], 2.5, { wrap: true }), 10);
  assert.equal(sampleSeries([0, 10, 20], 1.5, { interpolate: false }), 10);
  assert.equal(sharedPeak([[1, -7], undefined, [3]]), 7);
  assert.deepEqual(cumulative([1, 2, -1], 10), [11, 13, 12]);

  const clock = new Clock({ span: 24, rate: 2, playing: true });
  assert.equal(clock.tick(0.25), false);
  assert.equal(clock.tick(0.25), true);
  assert.equal(clock.step, 1);
  clock.seek(23.5);
  assert.equal(clock.tick(0.5), true, 'wraps to the first hour');
  near(clock.position, 0.5);
  const once = new Clock({ span: 3, loop: false, playing: true });
  once.tick(10);
  assert.equal(once.step, 2);
  assert.equal(once.playing, false);
});

test('readouts are plain JSON in the shapes the dashboard binds to', () => {
  assert.equal(formatNumber(1286), '1.29 k');
  assert.equal(formatNumber(247), '247');
  assert.equal(formatNumber(0.04), '0.04');
  assert.equal(formatNumber(12.5), '12.5');
  assert.equal(formatNumber(2_400_000), '2.4 M');
  assert.equal(formatNumber(Number.NaN), '—');
  assert.deepEqual(stat(1286, 'kW', 'Campus demand now', { delta: -3 }), { value: '1.29 k', unit: 'kW', caption: 'Campus demand now', delta: -3 });
  assert.deepEqual(bars([{ label: 'Solar', value: 3 }, { label: 'Grid', value: 1, slot: 4 }]).items.map((b) => b.slot), [1, 4]);
  assert.deepEqual(shares([3, 1, -2]), [0.75, 0.25, 0]);
  assert.deepEqual(timeline({ position: 13.5, span: 48 }), { now: 13.5, start: 0, end: 48, dayFrom: 6, dayTo: 20 });
  const t = trend([{ label: 'Demand', values: Array.from({ length: 192 }, (_, i) => i) }], 0.25);
  assert.equal(t.series[0]!.values.length, 96);
  assert.equal(t.series[0]!.values[0], 0.5);
  assert.doesNotThrow(() => JSON.stringify(t));
});

// ---- Drawing ------------------------------------------------------------------

test('areas draw as a choropleth with holes, outlines and a level', () => {
  const shapes = readShapes(collection, frame, 'id');
  const { pen, ops } = recorder();
  const view = tableView(pen, frame, 2000);
  assert.equal(view.scale, 2);
  const scale = levelScale({ domain: [0, 4] });
  drawAreas(view, shapes.areas, {
    fill: (a) => [255, 0, 166, scale(a.properties.demand[1])],
    stroke: [255, 255, 255, 1],
    strokeWidth: 2,
    levelFill: [250, 54, 0, 1],
    level: 0.25,
  });
  assert.equal(ops('fill')[0]!.fillStyle, 'rgba(255,0,166,1)');
  assert.equal(ops('fill')[0]!.args[0], 'evenodd');
  // The level fills the bottom quarter of the footprint's pixel box.
  const rect = ops('rect')[0]!.args as number[];
  [200, 350, 200, 50].forEach((v, i) => near(rect[i]!, v, 1e-3));
  assert.equal(ops('stroke')[0]!.lineWidth, 2);

  const hidden = recorder();
  drawAreas(tableView(hidden.pen, frame, 2000), shapes.areas, { fill: [0, 0, 0, 1], show: () => false });
  assert.equal(hidden.calls.length, 0);
});

test('paths draw as flow lines, partly revealed, and spots as labelled markers', () => {
  const shapes = readShapes(collection, frame, 'id');
  const { pen, ops } = recorder();
  const view = tableView(pen, frame, 1000);
  drawPaths(view, shapes.paths, { colour: [0, 255, 229, 1], width: 6, glow: 3, reveal: 0.5 });
  const end = ops('lineTo').at(-1)!.args as number[];
  near(end[0]!, 150, 1e-3);
  near(end[1]!, 200, 1e-3);
  assert.deepEqual(ops('stroke').map((s) => s.lineWidth), [18, 6]);
  drawPaths(view, shapes.paths, { colour: [0, 0, 0, 1], width: 0 });
  assert.equal(ops('stroke').length, 2, 'a zero-width flow draws nothing');

  drawSpots(view, shapes.spots, { colour: [255, 255, 255, 1], radius: 6, core: 0.4, label: (s) => s.properties.id });
  assert.equal(ops('fillText')[0]!.args[0], 'grid');
  assert.equal(ops('arc').length, 2);
});

test('rings travel out or in, and stop when nothing flows', () => {
  const at = (time: number, direction: 1 | -1) => {
    const { pen, ops } = recorder();
    drawRings(tableView(pen, frame, 1000, time), [500, 300], { colour: [255, 255, 255, 1], radius_m: 100, direction, count: 1, period: 2 });
    return (ops('arc')[0]!.args as number[])[2]!;
  };
  assert.ok(at(0.5, 1) < at(1, 1), 'outward rings grow');
  assert.ok(at(0.5, -1) > at(1, -1), 'inward rings shrink');
  const still = recorder();
  drawRings(tableView(still.pen, frame, 1000), [0, 0], { colour: [0, 0, 0, 1], radius_m: 50, level: 0 });
  assert.equal(still.calls.length, 0);
});

// ---- Motion and fields ----------------------------------------------------------

test('lights travel along paths as a pure function of time', () => {
  const paths = [measurePath([[0, 0], [100, 0]]), measurePath([[0, 0], [0, 50]])];
  const heads = pathHeads(paths, 1, { period: 4, active: (_, i) => i === 0 });
  assert.equal(heads.length, 1);
  near(heads[0]!.point[0], 25);
  assert.deepEqual(pathHeads(paths, 1, { period: 4 }), pathHeads(paths, 1, { period: 4 }));
  const reversed = pathHeads(paths, 1, { period: 4, reverse: () => true, count: (_, i) => (i === 0 ? 2 : 0) });
  assert.equal(reversed.length, 2);
  near(reversed[0]!.point[0], 75);
  // A speed makes a long route take longer than a short one.
  const bySpeed = pathHeads([measurePath([[0, 0], [100, 0]])], 1, { speed: 10 });
  near(bySpeed[0]!.point[0], 10);
});

test('a swarm is drawn to attractors and retires on arrival', () => {
  const random = seeded(7);
  const venues = [{ point: [200, 200] as const, weight: 3 }, { point: [800, 400] as const, weight: 1 }];
  const picks = Array.from({ length: 400 }, () => pickWeighted(venues, random)!.weight);
  const heavy = picks.filter((w) => w === 3).length;
  assert.ok(heavy > 270 && heavy < 330, `weighted choice picked the heavy venue ${heavy} of 400 times`);

  const swarm = new Swarm({
    max: 50,
    spawnRate: 100,
    random,
    spawn: (rnd) => {
      const target = pickWeighted(venues, rnd)!;
      const [x, y] = aroundRing(target.point, 280, rnd);
      return { x, y, lifetime: 60, tag: target };
    },
    steer: pullTowards((p) => (p.tag as (typeof venues)[number]).point, { speed: 20, radius_m: 200 }),
  });
  swarm.step(1, 0.5);
  assert.equal(swarm.particles.length, 25, 'intensity caps the crowd');
  for (let i = 0; i < 240; i++) swarm.step(1 / 60, 0.5);
  const distanceLeft = (p: (typeof swarm.particles)[number]) => Math.hypot(p.x - (p.tag as any).point[0], p.y - (p.tag as any).point[1]);
  const walkers = swarm.particles.filter((p) => p.age > 4);
  assert.ok(walkers.length > 0);
  // Spawned at most 364 m out and walking at 20 m/s or more for over four seconds.
  walkers.forEach((p) => assert.ok(distanceLeft(p) < 364 - 70, `a particle is still ${distanceLeft(p)} m away`));
  for (let i = 0; i < 60 * 40; i++) swarm.step(1 / 60, 0);
  assert.equal(swarm.particles.length, 0, 'with no new arrivals everyone reaches a venue');

  const steer = gravity(venues, { speed: 10, radius_m: 200 });
  const between = steer({ x: 500, y: 300, vx: 0, vy: 0, age: 0, lifetime: 1, tag: null }, 0)!;
  assert.ok(between[0] < 0, 'between two venues the heavier one wins');
});

test('points cluster, and flow networks report which way a node is working', () => {
  const clusters = clusterPoints([{ point: [10, 10] as const }, { point: [20, 20] as const }, { point: [400, 400] as const }], 100);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.find((c) => c.members.length === 2)!.point, [15, 15]);

  const links = [
    { source: 'grid', target: 'karhus', values: [10, 0, 4] },
    { source: 'battery', target: 'grid', values: [0, 20, 0] },
  ];
  assert.equal(nodeBalance(links, 'grid', 0), 10);
  assert.deepEqual(nodePulse(links, 'grid', 1), { direction: -1, level: 1 });
  assert.deepEqual(nodePulse(links, 'grid', 2), { direction: 1, level: 0.2 });
});

test('data fields are frames: heat, gravity, sampling, gradient and contours', () => {
  const raster = { width: 100, height: 60, cell_m: 10 };
  const heat = heatField([{ point: [500, 300] }, { point: [500, 300], weight: 2 }], raster, 100);
  assert.ok(heat.data instanceof Float32Array && heat.width === 100 && heat.min === 0);
  near(sampleField(heat, 1000, [500, 300]), heat.max, heat.max * 0.02);
  assert.equal(sampleField(heat, 1000, [900, 300]), 0);
  assert.ok(sampleField(heat, 1000, [540, 300]) < heat.max);

  const pull = gravityField([{ point: [200, 300], weight: 1 }], raster, 150);
  const [gx, gy] = fieldGradient(pull, 1000, [600, 300]);
  assert.ok(gx < 0 && Math.abs(gy) < Math.abs(gx) * 0.01, 'uphill points at the attractor');

  const lines = contours(pull, 1000, [0.5]);
  assert.ok(lines[0]!.segments.length > 20);
  // The half-strength contour of a single attractor is a circle of one radius.
  for (const [a] of lines[0]!.segments) near(Math.hypot(a[0] - 200, a[1] - 300), 150, 3);

  // A quantised kernel frame samples in field units.
  const quantised = { ...heat, data: new Uint8Array(100 * 60).fill(255), min: 2, max: 6 };
  assert.equal(sampleField(quantised, 1000, [10, 10]), 6);
});

// ---- Story --------------------------------------------------------------------

test('a sequence waits, runs timed stages and reports levels', () => {
  const sequence = new Sequence([{ id: 'idle' }, { id: 'reveal', seconds: 3 }, { id: 'revealed' }, { id: 'ramp', seconds: 2 }, { id: 'full' }]);
  assert.equal(sequence.tick(100), false, 'a waiting stage does not time out');
  assert.equal(sequence.advance(), true);
  sequence.tick(1.5);
  assert.equal(sequence.level('reveal'), 0.5);
  assert.equal(revealedCount(sequence.level('reveal'), 12), 6);
  assert.equal(sequence.advance(), false, 'a timed stage is not interrupted');
  assert.equal(sequence.tick(1.5), true);
  assert.equal(sequence.stage.id, 'revealed');
  assert.equal(sequence.level('reveal'), 1);
  assert.equal(sequence.level('ramp'), 0);
  sequence.advance();
  sequence.tick(5);
  assert.equal(sequence.stage.id, 'full');
  assert.equal(sequence.advance(), false);
  assert.ok(sequence.goTo('idle') && !sequence.reached('reveal'));

  assert.deepEqual([0, 1, 2].map((i) => Math.round(stagger(0.5, i, 3) * 1e6) / 1e6), [1, 0.5, 0]);
  assert.ok(stagger(0.6, 2, 3, 0.5) > 0 && stagger(0.6, 2, 3) === 0, 'with overlap the last item starts earlier');
});

// ---- Interaction ----------------------------------------------------------------

let clockTime = 0;
function sample(id: string, phase: PointerSample['phase'], point: [number, number], extra: Partial<PointerSample> = {}): PointerSample {
  return { id, source: 'mouse', phase, point, lonLat: frame.toLonLat(point), pressed: phase === 'down', time: (clockTime += 0.1), ...extra };
}

test('phone point tools become the same samples as a mouse', () => {
  const lonLat = frame.toLonLat([250, 125]);
  const tap = fromToolInput({ layer: 'isovist', tool: 'viewer', geometry: { type: 'Point', coordinates: lonLat }, from: 7 }, frame, 3)!;
  assert.equal(tap.id, 'phone:7');
  assert.equal(tap.owner, 7);
  near(tap.point[0], 250, 1e-6);
  assert.equal(fromToolInput({ layer: 'x', tool: 'y', geometry: { type: 'LineString', coordinates: [] }, from: 1 }, frame), null);
});

test('an agent is dragged, placed or follows, and stays on the table', () => {
  const moves: [number, number][] = [];
  const person = new Agent({ position: [500, 300], constrain: keepOnTable(frame, 10), onMove: (a) => moves.push(a.position) });
  assert.equal(person.handle(sample('m', 'down', [700, 300])), false, 'a press away from the agent is not for it');
  assert.equal(person.handle(sample('m', 'down', [505, 300])), true);
  person.handle(sample('m', 'move', [600, 300]));
  near(person.heading, 0);
  person.handle(sample('m', 'move', [2000, 300]));
  assert.deepEqual(person.position, [990, 300]);
  person.handle(sample('m', 'up', [2000, 300]));
  assert.equal(person.handle(sample('m', 'move', [100, 100])), false, 'released');
  assert.equal(moves.length, 2);

  const placed = new Agent({ position: [0, 0], mode: 'place' });
  // The same behaviour takes a phone tap.
  placed.handle(fromToolInput({ layer: 'l', tool: 't', geometry: { type: 'Point', coordinates: frame.toLonLat([40, 50]) }, from: 2 }, frame)!);
  near(placed.position[0], 40, 1e-6);

  const token = new Agent({ position: [0, 0], mode: 'follow' });
  token.handle(sample('token:3', 'move', [10, 10], { source: 'token', rotation: 1.25 }));
  assert.equal(token.heading, 1.25, 'a token brings its own heading');
});

test('every pointer can own its own agent, and a drag is not stolen', () => {
  const colours = ['red', 'blue'];
  const people = new PerPointer((s) => new Agent({ position: s.point, mode: 'follow' }));
  people.handle(sample('touch:1', 'move', [100, 100]));
  people.handle(sample('touch:2', 'move', [900, 500]));
  people.handle(sample('touch:1', 'move', [150, 100]));
  assert.deepEqual(people.entries().map(([id, a]) => [id, a.position[0], colours.length]), [['touch:1', 150, 2], ['touch:2', 900, 2]]);
  people.handle(sample('touch:2', 'leave', [900, 500]));
  assert.equal(people.entries().length, 1);

  const a = new Agent({ position: [100, 100] });
  const b = new Agent({ position: [200, 100] });
  const router = pointerRouter([a, b]);
  router.handle(sample('m', 'down', [100, 100]));
  router.handle(sample('m', 'move', [200, 100]));
  router.handle(sample('m', 'up', [200, 100]));
  assert.deepEqual([a.position[0], b.position[0], b.heldBy], [200, 200, null]);
  router.handle(sample('m', 'down', [200, 100]));
  assert.equal(a.heldBy, 'm', 'the first behaviour in the list wins a tie');
});

test('a lens follows, pins, zooms with a dial and draws a magnified or different scene', () => {
  const lens = new Lens({ radius_m: 50, zoom: 3, zoomRange: [2, 6] });
  assert.equal(lens.visible, false);
  lens.handle(sample('m', 'move', [400, 300]));
  lens.handle(sample('m', 'down', [400, 300]));
  lens.handle(sample('m', 'move', [100, 100]));
  assert.deepEqual([lens.centre, lens.pinned], [[400, 300], true]);
  lens.handle(sample('m', 'down', [100, 100]));
  lens.handle(sample('m', 'move', [120, 100]));
  assert.deepEqual([lens.centre, lens.pinned], [[120, 100], false]);
  lens.handle(sample('dial', 'move', [120, 100], { source: 'token', rotation: Math.PI }));
  assert.equal(lens.zoom, 4);

  const { pen, ops } = recorder();
  const view = tableView(pen, frame, 1000);
  const inner = zoomedView(view, [120, 100], 4);
  assert.deepEqual(inner.toPx([120, 100]), [120, 100]);
  assert.deepEqual(inner.toPx([130, 100]), [160, 100]);
  let scaleInside = 0;
  drawLens(view, lens, (v) => (scaleInside = v.scale));
  assert.equal(scaleInside, 4);
  assert.deepEqual(ops('clip').length, 1);
  assert.deepEqual((ops('arc')[0]!.args as number[]).slice(0, 3), [120, 100, 50]);
  lens.handle(sample('m', 'leave', [0, 0]));
  assert.equal(lens.visible, false);
});

test('a probe reads what is under the pointer, small things first', () => {
  const shapes = readShapes(collection, frame, 'id');
  assert.equal(hitTest(shapes, [150, 150])!.kind, 'area');
  assert.equal(hitTest(shapes, [2, 2])!.kind, 'spot');
  assert.equal(hitTest(shapes, [62, 78])!.kind, 'path');
  assert.equal(hitTest(shapes, [900, 50]), null);

  const seen: (string | number | null)[] = [];
  const probe = new Probe({ shapes: () => shapes, onHover: (hit) => seen.push(hit?.shape.id ?? null) });
  probe.handle(sample('m', 'move', [150, 150]));
  probe.handle(sample('m', 'move', [160, 150]));
  probe.handle(sample('m', 'move', [900, 50]));
  assert.deepEqual(seen, ['Kårhus', null]);
  assert.equal(probe.handle(sample('m', 'down', [150, 150])), true);
  assert.equal(probe.selected!.shape.id, 'Kårhus');
});

test('dwelling in one place fires once, and moving away ends it', () => {
  const events: string[] = [];
  const dwell = new Dwell({ seconds: 1, radius_m: 10, onDwell: () => events.push('dwell'), onLeave: () => events.push('leave') });
  dwell.handle({ ...sample('m', 'move', [100, 100]), time: 0 });
  dwell.handle({ ...sample('m', 'move', [104, 100]), time: 0.6 });
  dwell.check(0.9);
  assert.deepEqual(events, []);
  dwell.check(1.1);
  dwell.check(1.5);
  assert.deepEqual(events, ['dwell']);
  dwell.handle({ ...sample('m', 'move', [300, 100]), time: 2 });
  assert.deepEqual(events, ['dwell', 'leave']);
});

// ---- Attention cue (#105) -------------------------------------------------------

test('a cue plays once, brightest at the start, and then stops drawing', () => {
  const brightest = (age: number) => {
    const { pen, calls } = recorder();
    const playing = drawCue(tableView(pen, frame, 1000, age), { point: [500, 300] }, age, { frame });
    return { playing, calls };
  };
  assert.ok(brightest(0).playing && brightest(0).calls.length > 0);
  assert.ok(brightest(CUE_SECONDS * 0.9).playing);
  const done = brightest(CUE_SECONDS + 0.01);
  assert.equal(done.playing, false);
  assert.equal(done.calls.length, 0, 'nothing is left on the table');
});

test('a line is drawn in from its start, and an area flashes its outline', () => {
  const { pen, ops } = recorder();
  drawCue(tableView(pen, frame, 1000), { line: [[100, 100], [900, 100]] }, CUE_SECONDS * 0.2, { frame });
  const reached = Math.max(...ops('lineTo').map((c) => (c.args as number[])[0]!));
  assert.ok(reached > 100 && reached < 900, `the head is part way along (${reached})`);
  const area = recorder();
  drawCue(tableView(area.pen, frame, 1000), { area: [[100, 100], [300, 100], [300, 300], [100, 100]] }, 0.3, { frame });
  assert.ok(area.ops('fill').length > 0 && area.ops('stroke').length > 0);
});

test('a change off the table is pointed at from the nearest edge', () => {
  assert.equal(offTable([[500, 300]], frame), null);
  assert.equal(offTable([[-50, 300], [50, 300]], frame), null, 'partly on the table');
  const away = offTable([[1200, 300]], frame)!;
  assert.deepEqual(away.at, [1000, 300]);
  assert.deepEqual(away.towards, [1, 0]);
});
