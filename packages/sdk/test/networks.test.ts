import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileLook, makeTestData, moverRoutes, networkBalance, networkData, networkPosition, parseCsv, readShapes, resolvePalette, spotlight, tableFrame } from '../src/index.ts';
import type { GeoJsonCollection, Pen, Shapes, Spot, View } from '../src/index.ts';

const spot = (id: string, x: number, y: number, kind?: string): Spot => ({ id, point: [x, y], properties: { id, ...(kind ? { kind } : {}) } });
const nodes = [spot('grid', 0, 0, 'grid'), spot('battery', 100, 0, 'battery'), spot('home', 100, 100)];

test('links join nodes by id; a link without a line goes straight, or along the streets', () => {
  const rows = [{ from: 'grid', to: 'home' }, { from: 'battery', to: 'home' }, { from: 'grid', to: 'nowhere' }];
  const straight = networkData(nodes, { linkRows: rows });
  assert.equal(straight.links.length, 2);
  assert.equal(straight.links[0]!.route, 'straight');
  assert.ok(Math.abs(straight.links[0]!.path.length - Math.hypot(100, 100)) < 1e-6);
  assert.match(straight.problems.join(' '), /nowhere/);
  // An L of streets: grid → (0,100) → home.
  const streets: Shapes = { areas: [], spots: [], paths: [{ id: 's', properties: {}, ...measured([[0, 0], [0, 100], [100, 100]]) }] };
  const routed = networkData(nodes, { linkRows: rows.slice(0, 1), streets });
  assert.equal(routed.links[0]!.route, 'streets');
  assert.ok(Math.abs(routed.links[0]!.path.length - 200) < 1e-6);
  // No streets wanted: straight even when the site has them.
  assert.equal(networkData(nodes, { linkRows: rows.slice(0, 1), streets }, { streets: null }).links[0]!.route, 'straight');
});

function measured(points: [number, number][]) {
  const stations = [0];
  for (let i = 1; i < points.length; i++) stations.push(stations[i - 1]! + Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]));
  return { points, stations, length: stations[stations.length - 1]! };
}

test('a long series sets each link\'s flow and each node\'s gauge by step, in time order', () => {
  const series = [
    { time: '02:00', from: 'grid', to: 'home', flow: 3 },
    { time: '00:00', from: 'grid', to: 'home', flow: 1 },
    { time: '01:00', id: 'battery>home', flow: -2 },
    { time: '00:00', id: 'battery', level: 0.2 },
    { time: '02:00', id: 'battery', level: 0.8 },
    { time: '01:00', id: 'mystery', flow: 5 },
  ];
  const data = networkData(nodes, { linkRows: [{ from: 'grid', to: 'home' }, { from: 'battery', to: 'home' }], series });
  assert.deepEqual(data.labels, ['00:00', '01:00', '02:00']);
  assert.equal(data.steps, 3);
  // A gap takes the step before it.
  assert.deepEqual(data.links[0]!.values, [1, 1, 3]);
  assert.deepEqual(data.links[1]!.values, [0, -2, -2]);
  assert.deepEqual(data.nodes[1]!.gauge, [0.2, 0.2, 0.8]);
  assert.equal(data.nodes[0]!.gauge, null);
  assert.equal(data.peak, 3);
  assert.match(data.problems.join(' '), /mystery/);
  // Grid gives 3 at step 2; home takes 3 from the grid and gives 2 back to the battery (a negative flow).
  assert.equal(networkBalance(data, 0, 2), 3);
  assert.equal(networkBalance(data, 2, 2), -3 + 2);
});

test('the play head walks one step every step_s seconds and loops', () => {
  assert.equal(networkPosition(24, 0, 2), 0);
  assert.equal(networkPosition(24, 3, 2), 1.5);
  assert.equal(networkPosition(24, 50, 2), 1);
});

test('the energy network test data plays a day without problems, and draws', () => {
  const site = { origin: { lon: 11.97, lat: 57.7 }, extent: { width_m: 1000, height_m: 600, rotation_deg: 0 } };
  const frame = tableFrame(site);
  const files = makeTestData('network', site, 5);
  assert.deepEqual(files.map((f) => f.suffix), ['', '-links', '-series']);
  const shapes = readShapes(JSON.parse(files[0]!.text) as GeoJsonCollection, frame);
  const table = (suffix: string) => parseCsv(files.find((f) => f.suffix === suffix)!.text);
  const data = networkData(shapes.spots, { linkRows: table('-links'), series: table('-series') }, { note: 'note' });
  assert.deepEqual(data.problems, []);
  assert.equal(data.steps, 24);
  assert.equal(data.nodes.length, 12);
  // The chargers open at 08:00, announced with a spotlight on the charger, and cars arrive there (#338).
  const charger = data.nodes.findIndex((n) => n.id === 'Charger');
  assert.deepEqual(data.notes[8], { text: 'The car chargers open', nodes: [charger] });
  assert.equal(data.notes.filter(Boolean).length, 1);
  assert.equal(data.arrivals[charger]![18], 4);
  assert.equal(data.arrivals[charger]!.reduce((a, b) => a + b, 0), 13);
  assert.ok(data.links.length >= 12);
  // Solar flows only by day; the battery fills, then gives in the evening.
  const solar = data.links.find((l) => data.nodes[l.from]!.id === 'Solar 1' && data.nodes[l.to]!.id === 'Battery')!;
  assert.equal(solar.values[2], 0);
  const battery = data.nodes.find((n) => n.id === 'Battery')!;
  assert.ok(battery.gauge![15]! > battery.gauge![5]!);
  assert.ok(battery.gauge![23]! < battery.gauge![17]!);

  const calls: string[] = [];
  const pen = new Proxy({}, { get: (_, key) => (key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => calls.push(String(key))), set: () => true }) as unknown as Pen;
  const view: View = { pen, scale: 1, time: 0, detail: 1, toPx: ([x, y]) => [x, y] };
  const look = compileLook({ id: 'nodes', block: 'points' }, shapes, resolvePalette(), 1, { network: { inputs: { linkRows: table('-links'), series: table('-series') }, position: () => 13 } });
  assert.equal(look!.network!.steps, 24);
  assert.deepEqual(look!.legend.map((l) => l.label), ['Giving', 'Taking', 'Level']);
  look!.draw(view, 0, 1);
  look!.draw(view, 0.1, 1);
  assert.ok(calls.filter((c) => c === 'stroke').length > 20);
});

test('a link that holds its own list of flows plays it, one step each, without a series table (#373)', () => {
  const rows = [
    { from: 'grid', to: 'home', flow_hourly: '[1, 2, 3, 4]' },
    { from: 'battery', to: 'home', flow_hourly: 5 },
  ];
  const data = networkData(nodes, { linkRows: rows }, { flow: 'flow_hourly' });
  assert.equal(data.steps, 4);
  assert.deepEqual(data.labels, ['0', '1', '2', '3']);
  assert.deepEqual(data.links[0]!.values, [1, 2, 3, 4]);
  assert.deepEqual(data.links[1]!.values, [5, 5, 5, 5]);
  assert.equal(data.peak, 5);
  // Lines carry arrays as they are.
  const shapes: Shapes = { areas: [], spots: [], paths: [{ id: 'l', properties: { from: 'grid', to: 'battery', flow_hourly: [0, -2] }, ...measured([[0, 0], [100, 0]]) }] };
  assert.deepEqual(networkData(nodes, { linkShapes: shapes }, { flow: 'flow_hourly' }).links[0]!.values, [0, -2]);
});

test('a change spotlights its node for a few seconds, and movers come along the streets to arrive in their step (#338)', () => {
  assert.equal(spotlight(-1, 4), 0);
  assert.equal(spotlight(0.2, 4), 0.5);
  assert.equal(spotlight(2, 4), 1);
  assert.equal(spotlight(3.5, 4), 0.5);
  assert.equal(spotlight(4.5, 4), 0);
  const rows = [
    { time: '1', id: 'home', arrivals: 2, note: 'Home joins' },
    { time: '2', id: 'grid', arrivals: 0 },
    { time: '2', note: 'A quiet hour' },
  ];
  const data = networkData(nodes, { linkRows: [{ from: 'grid', to: 'home' }], series: rows }, { note: 'note' });
  assert.deepEqual(data.problems, []);
  assert.deepEqual(data.notes, [{ text: 'Home joins', nodes: [2] }, { text: 'A quiet hour', nodes: [] }]);
  const movers = moverRoutes(data);
  assert.equal(movers.length, 2);
  assert.deepEqual(movers.map((m) => m.due), [0.25, 0.75]);
  // Without streets, they come straight in from about 320 m away, and end at the node.
  assert.ok(Math.abs(movers[0]!.path.length - 320) < 1);
  assert.deepEqual(movers[0]!.path.points.at(-1), data.nodes[2]!.point);
  // Without the note option, the notes are not read: an existing layer looks the same.
  assert.deepEqual(networkData(nodes, { linkRows: [{ from: 'grid', to: 'home' }], series: rows }).notes, [null, null]);
});
