import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lut, colormaps, stretch } from '../src/colormap.ts';
import { isVisible } from '../src/controls.ts';
import { clearSegment, FacadeGlow, facadeEdges, FlowField, ribbonLight, Streamlines, traceStreamline, Tracers } from '../src/flow.ts';
import { parseFrame, sample } from '../src/frame.ts';
import type { FieldFrame } from '../src/types.ts';
import { lonLatToTable, siteProjection, tableToLonLat } from '../src/geo.ts';
import { sunPosition } from '../src/solar.ts';
import { along, geojsonPolygons, insidePolygon, nearestAlong, seededRandom, STRAY_REACH, tableReach, tableSpace, track } from '../src/table-space.ts';
import { formatHour, zonedTimeToUtc } from '../src/time.ts';
import type { SiteInfo } from '../src/types.ts';

test('wall-clock time converts to UTC across daylight saving', () => {
  assert.equal(zonedTimeToUtc('2026-06-21', 12, 'Europe/Stockholm'), '2026-06-21T10:00:00Z');
  assert.equal(zonedTimeToUtc('2026-12-21', 12, 'Europe/Stockholm'), '2026-12-21T11:00:00Z');
  assert.equal(zonedTimeToUtc('2026-06-21', 0.25, 'Europe/Stockholm'), '2026-06-20T22:15:00Z');
  assert.equal(zonedTimeToUtc('2026-06-21', 24, 'Europe/Stockholm'), '2026-06-21T22:00:00Z');
  assert.equal(zonedTimeToUtc('2026-06-21', 12, 'America/New_York'), '2026-06-21T16:00:00Z');
  assert.equal(zonedTimeToUtc('2026-06-21', 12, null), '2026-06-21T12:00:00Z');
  assert.equal(formatHour(13.75), '13:45');
});

test('field frames parse in both encodings', () => {
  const header = (encoding: number, body: number) => {
    const buffer = new ArrayBuffer(40 + body);
    const view = new DataView(buffer);
    [0x4d, 0x52, 0x53, 0x46].forEach((c, i) => view.setUint8(i, c));
    view.setUint16(4, 1, true);
    view.setUint16(6, encoding, true);
    view.setUint32(8, 7, true);
    view.setUint32(12, 1, true);
    view.setUint32(16, 2, true);
    view.setUint32(20, 1, true);
    view.setUint32(24, 3, true);
    view.setFloat32(28, 0, true);
    view.setFloat32(32, 10, true);
    view.setFloat32(36, 0.5, true);
    return { buffer, view };
  };
  const u8 = header(1, 2);
  u8.view.setUint8(40, 0);
  u8.view.setUint8(41, 255);
  const frame = parseFrame(u8.buffer);
  assert.deepEqual([frame.stream, frame.field, frame.width, frame.height, frame.revision], [7, 1, 2, 1, 3]);
  assert.equal(sample(frame, 1, 0), 10);

  const f32 = header(0, 8);
  f32.view.setFloat32(44, 4.5, true);
  assert.equal(sample(parseFrame(f32.buffer), 1, 0), 4.5);

  assert.throws(() => parseFrame(new ArrayBuffer(10)));
  assert.throws(() => parseFrame(header(1, 3).buffer));
});

test('colormap lookup tables hit their end stops', () => {
  const table = lut(colormaps.sun);
  assert.equal(table.length, 1024);
  assert.deepEqual([...table.slice(0, 4)], [12, 8, 40, 235]);
  assert.deepEqual([...table.slice(1020)], [255, 250, 200, 235]);
});

test('visibleWhen hides controls', () => {
  const control = { id: 'x', type: 'toggle', label: 'X', default: false, visibleWhen: { mode: 'day' } } as const;
  assert.equal(isVisible(control, { mode: 'day' }), true);
  assert.equal(isVisible(control, { mode: 'instant' }), false);
});

test('a stretched colormap reaches its top colour early', () => {
  const half = lut(stretch(colormaps.speed, 0.5));
  const full = lut(colormaps.speed);
  assert.deepEqual([...half.slice(0, 4)], [...full.slice(0, 4)]);
  // Half way along the stretched ramp is the end of the original, and it stays there.
  assert.deepEqual([...half.slice(128 * 4, 128 * 4 + 4)], [...full.slice(1020)]);
  assert.deepEqual([...half.slice(1020)], [...full.slice(1020)]);
});

/** A uniform flow to the right at `speed`, with a wall of obstacles in columns 10 and 11 except rows 8 to 11. */
function gapField(encoding: 'u8' | 'f32', speed = 4): FlowField {
  const [width, height, max] = [24, 20, 12.5];
  const min = (-max * 128) / 127;
  const frame = (value: (col: number, row: number) => number): FieldFrame => {
    const data = encoding === 'f32' ? new Float32Array(width * height) : new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const v = value(col, row);
        data[row * width + col] = encoding === 'f32' ? v : Math.round(((v - min) / (max - min)) * 255);
      }
    }
    return { stream: 1, field: 0, width, height, revision: 1, min, max, progress: 1, data };
  };
  const wall = (col: number, row: number) => (col === 10 || col === 11) && (row < 8 || row > 11);
  return FlowField.fromFrames(
    frame((col, row) => (wall(col, row) ? 0 : speed)),
    frame(() => 0),
  );
}

test('a flow field finds obstacles and interpolates around them', () => {
  for (const encoding of ['u8', 'f32'] as const) {
    const field = gapField(encoding);
    assert.equal(field.isBlocked(10, 3), true, encoding);
    assert.equal(field.isBlocked(10, 9), false, encoding);
    assert.equal(field.isBlocked(-1, 0), true);
    assert.ok(Math.abs(field.meanU - 4) < 0.05 && Math.abs(field.meanV) < 0.05, encoding);
    const out: [number, number] = [0, 0];
    assert.ok(Math.abs(field.sample(5.3, 5.7, out)[0] - 4) < 0.05);
    assert.deepEqual(field.sample(10.5, 3.5, out), [0, 0], 'no flow inside an obstacle');
    assert.deepEqual(field.sample(-1, 3, out), [0, 0]);
    // Through the gap is clear, through the wall is not, and neither is clipping its corner.
    assert.equal(field.crossesBlocked(8.5, 9.5, 13.5, 9.5), false);
    assert.equal(field.crossesBlocked(8.5, 3.5, 13.5, 3.5), true);
    assert.equal(field.crossesBlocked(9.5, 8.5, 10.5, 7.5), true);
    assert.equal(field.crossesBlocked(9.5, 8.5, 9.5, 8.5), false);
  }
});

test('tracers follow the flow, respect obstacles and re-enter upwind', () => {
  const field = gapField('u8');
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const tracers = new Tracers(field, { count: 200, trailSeconds: 0.5, random });
  const startX = Float32Array.from(tracers.x);
  // One cell per second per unit of speed: 4 cells a second here.
  tracers.update(1 / 60, 1);
  let moved = 0;
  for (let i = 0; i < tracers.count; i++) if (Math.abs(tracers.x[i]! - startX[i]! - 4 / 60) < 1e-3) moved++;
  assert.ok(moved > 150, `${moved} tracers advanced with the flow`);
  for (let frame = 0; frame < 600; frame++) {
    tracers.update(1 / 60, 1);
    for (let i = 0; i < tracers.count; i++) {
      const [x, y] = [tracers.x[i]!, tracers.y[i]!];
      assert.ok(x >= 0 && x < field.width && y >= 0 && y < field.height, 'tracers stay on the field');
      assert.equal(field.isBlocked(Math.floor(x), Math.floor(y)), false, 'tracers never sit inside an obstacle');
      assert.ok(tracers.length[i]! <= Tracers.capacity);
    }
  }
  // After ten seconds every tracer has been replaced at least once: they came back in at the left edge.
  const beyond = [...tracers.x].filter((x, i) => x > 12 && !(tracers.y[i]! >= 8 && tracers.y[i]! < 12)).length;
  assert.equal(beyond, 0, 'nothing got past the wall except through the gap');
  assert.ok([...tracers.x].some((x) => x > 12), 'some tracers went through the gap');
  // A trail holds points no older than its length.
  const i = [...tracers.length].findIndex((n) => n > 3);
  assert.ok(i >= 0);
  const oldest = tracers.trailT[i * Tracers.capacity + tracers.start[i]!]!;
  assert.ok(tracers.time - oldest <= 0.5 + 1 / 60);
});

test('streamlines run whole through the gap, never through the wall, and morph instead of jumping (#159)', () => {
  const field = gapField('f32');
  // Downstream and upstream from a point in front of the gap.
  const down = traceStreamline(field, { x: 5, y: 9.5 }, 1, 1);
  const up = traceStreamline(field, { x: 5, y: 9.5 }, -1, 1);
  assert.ok(down.at(-1)!.x > 15, 'the line runs on through the gap');
  assert.ok(up.at(-1)!.x < 1, 'and back to the upwind edge');
  assert.ok(down.every((p, i) => i === 0 || p.travel > down[i - 1]!.travel), 'travel time grows downstream');
  assert.ok(Math.abs(down[2]!.travel - 1 / 4) < 1e-6, 'two half-cell steps at 4 cells a second take a quarter second');
  // A line aimed at the wall stops in front of it.
  const blocked = traceStreamline(field, { x: 5, y: 3.5 }, 1, 1);
  assert.ok(blocked.at(-1)!.x < 10 && blocked.at(-1)!.x > 9, 'stops at the wall');

  const lines = new Streamlines(field, 24);
  lines.update(0.2, 1);
  assert.ok(lines.anchors.length > 10 && lines.anchors.every((a) => !field.isBlocked(Math.floor(a.x), Math.floor(a.y))));
  lines.update(0.2, 1);
  for (const line of lines.lines) {
    for (let i = 1; i < line.points.length; i++) {
      const [a, b] = [line.points[i - 1]!, line.points[i]!];
      assert.ok(b.station > a.station, 'points ordered along the line');
      assert.ok(clearSegment(field, a.x, a.y, b.x, b.y), 'no piece crosses the wall');
    }
  }
  // A faster field retraces the same points: same stations, only the travel times change.
  const before = lines.lines.map((line) => line.points.map((p) => p.station).join());
  const fast = gapField('f32', 8);
  lines.setField(fast);
  const point = lines.lines[0]!.points.find((p) => p.station === 2)!;
  lines.update(0.2, 1);
  assert.deepEqual(lines.lines.map((line) => line.points.map((p) => p.station).join()), before);
  assert.equal(lines.lines[0]!.points.find((p) => p.station === 2), point, 'the drawn point is kept and eased, not replaced');
  assert.ok(point.travel < point.targetTravel * 2 && point.travel > point.targetTravel, 'easing towards the shorter travel time');
});

test('facades facing the wind glow, the sheltered side stays dark (#174)', () => {
  const field = gapField('f32', 4);
  // The top half of the wall, wound either way round: the normals still point out.
  for (const ring of [
    [[10, 0], [12, 0], [12, 8], [10, 8], [10, 0]],
    [[10, 0], [10, 8], [12, 8], [12, 0]],
  ] as [number, number][][]) {
    const edges = facadeEdges([[ring]], field.width, field.height, 1);
    const glow = new FacadeGlow(field, edges);
    for (let k = 0; k < 120; k++) glow.update(1 / 30);
    const lit = (pick: (e: (typeof edges)[number]) => boolean) => edges.map((e, i) => [e, glow.intensity[i]!] as const).filter(([e]) => pick(e));
    const windward = lit((e) => e.ax === 10 && e.bx === 10 && Math.max(e.ay, e.by) < 7);
    const leeward = lit((e) => e.ax === 12 && e.bx === 12);
    assert.ok(windward.length > 3 && windward.every(([e, v]) => e.nx === -1 && v > 0.7), 'the face into a 4 m/s wind glows');
    assert.ok(leeward.length > 3 && leeward.every(([e, v]) => e.nx === 1 && v === 0), 'the face out of the wind stays dark');
  }
  // It builds slowly and lets go fast.
  const edges = facadeEdges([[[[10, 0], [12, 0], [12, 8], [10, 8]]]], field.width, field.height, 1);
  const glow = new FacadeGlow(field, edges);
  const face = edges.findIndex((e) => e.nx === -1 && e.ay < 6);
  glow.update(0.5);
  assert.ok(glow.intensity[face]! < 0.5, 'half a second in, still building');
  glow.setField(gapField('f32', 0.5));
  glow.update(0.5);
  assert.ok(glow.intensity[face]! < 0.1, 'and gone within half a second when the wind drops');
});

test('the light along a ribbon is a soft pulse that moves downstream', () => {
  assert.equal(ribbonLight(0.3 - 0.3, 0, 0), ribbonLight(1.3 - 0.3, 1, 0), 'one second later the light is one second further along');
  assert.ok(ribbonLight(0, 0, 0) > 0.99);
  assert.equal(ribbonLight(0.5, 0, 0), 0, 'dark between pulses');
});

test('a flow field eases towards new frames', () => {
  const field = gapField('f32', 4);
  const target = gapField('f32', 8);
  field.blendTowards(target, 0.25);
  assert.ok(Math.abs(field.u[0]! - (4 + 4 * (1 - Math.exp(-1)))) < 1e-4);
  for (let k = 0; k < 40; k++) field.blendTowards(target, 0.25);
  assert.ok(Math.abs(field.u[0]! - 8) < 1e-3);
});

test('table coordinates map to WGS84 and back, also on a rotated table', () => {
  // A 1000 m by 600 m table at Gothenburg, turned 30 degrees: top left, top right, bottom right, bottom left.
  const corners = [
    [11.9601, 57.7], [11.9746, 57.7045], [11.9796, 57.6998], [11.9651, 57.6953],
  ] as [[number, number], [number, number], [number, number], [number, number]];
  const site = { corners };
  assert.deepEqual(tableToLonLat(site, 0, 0), corners[0]);
  assert.deepEqual(tableToLonLat(site, 1, 0), corners[1]);
  assert.deepEqual(tableToLonLat(site, 0, 1), corners[3]);
  const near = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - b[i]!) < 1e-9);
  assert.ok(near(tableToLonLat(site, 1, 1), corners[2]));
  assert.ok(near(lonLatToTable(site, ...corners[2]), [1, 1]));
  for (const [u, v] of [[0.5, 0.5], [0.13, 0.87], [1.2, -0.1]] as const) {
    assert.ok(near(lonLatToTable(site, ...tableToLonLat(site, u, v)), [u, v]));
  }
});

test('sun position matches the engine reference values', () => {
  // The same cases as crates/mrs-engine/src/solar.rs.
  const at = (iso: string) => sunPosition(Date.parse(iso), 57.6884, 11.9778);
  const noon = at('2026-06-21T11:14:00Z');
  assert.ok(Math.abs(noon.altitude - 55.75) < 0.1, JSON.stringify(noon));
  assert.ok(Math.abs(noon.azimuth - 180) < 1, JSON.stringify(noon));
  assert.ok(Math.abs(at('2026-12-21T11:10:00Z').altitude - 8.87) < 0.15);
  const rise = at('2026-03-20T05:20:00Z');
  assert.ok(Math.abs(rise.altitude) < 1.5 && Math.abs(rise.azimuth - 90) < 2, JSON.stringify(rise));
  assert.ok(at('2026-12-21T23:00:00Z').altitude < -40);
});

test('table space maps WGS84 to metres from the top left corner', () => {
  // A 1000 x 600 m table turned 90 degrees: its top edge runs north to south on the east side.
  const site = {
    extent: { width_m: 1000, height_m: 600, rotation_deg: 90 },
    corners: [[11.975, 57.7045], [11.975, 57.6955], [11.965, 57.6955], [11.965, 57.7045]],
  } as unknown as SiteInfo;
  const space = tableSpace(site);
  const near = (actual: number[], expected: number[]) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]!) < 1e-6, `${actual} vs ${expected}`));
  near(space.toTable(11.975, 57.7045), [0, 0]);
  near(space.toTable(11.975, 57.6955), [1000, 0]);
  near(space.toTable(11.965, 57.6955), [1000, 600]);
  near(space.toTable(11.97, 57.7), [500, 300]);

  const [polygon] = geojsonPolygons(
    { type: 'Feature', properties: { kind: 'x' }, geometry: { type: 'Polygon', coordinates: [[[11.975, 57.7045], [11.975, 57.6955], [11.965, 57.6955], [11.975, 57.7045]]] } },
    space,
  );
  assert.equal(polygon!.properties.kind, 'x');
  assert.equal(insidePolygon(polygon!.geometry, 900, 100), true);
  assert.equal(insidePolygon(polygon!.geometry, 100, 500), false);
});

test('tracks give positions, headings and nearest points', () => {
  const t = track([[0, 0], [10, 0], [10, 10]]);
  assert.equal(t.length, 20);
  assert.deepEqual(along(t, 5), { x: 5, y: 0, angle: 0 });
  assert.deepEqual(along(t, 15), { x: 10, y: 5, angle: Math.PI / 2 });
  assert.deepEqual(along(t, 99), { x: 10, y: 10, angle: Math.PI / 2 });
  assert.equal(nearestAlong(t, 12, 4), 14);
  const a = seededRandom(3);
  const b = seededRandom(3);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('the site projection matches the host and the grid', () => {
  // The same numbers as mrs-site's projection test.
  const flat = siteProjection({ origin: { lon: 11.9778, lat: 57.6884 }, grid: { width: 100, height: 50, cell_m: 2, rotation_deg: 0 } });
  const [east, north] = flat.toLocal([12.9778, 58.6884]);
  assert.ok(Math.abs(north - 111_370) < 100 && Math.abs(east - 59_640) < 100);
  const back = flat.toLonLat(east, north);
  assert.ok(Math.abs(back[0] - 12.9778) < 1e-9 && Math.abs(back[1] - 58.6884) < 1e-9);
  // The origin is the middle of the grid, and north is up.
  assert.deepEqual(flat.toGrid([11.9778, 57.6884]), [50, 25]);
  const [col, row] = flat.toGrid(flat.toLonLat(0, 10));
  assert.ok(Math.abs(col - 50) < 1e-9 && Math.abs(row - 20) < 1e-9);
  assert.ok(Math.abs(flat.distance(flat.toLonLat(0, 0), flat.toLonLat(30, 40)) - 50) < 1e-6);

  // With the table turned so east is up, a point 10 m east is 5 cells above the middle.
  const turned = siteProjection({ origin: { lon: 11.9778, lat: 57.6884 }, grid: { width: 100, height: 50, cell_m: 2, rotation_deg: 90 } });
  const [c, r] = turned.toGrid(turned.toLonLat(10, 0));
  assert.ok(Math.abs(c - 50) < 1e-9 && Math.abs(r - 20) < 1e-9);
});

// ---- Model surface --------------------------------------------------------

import { parseTwin } from '../src/model.ts';
import { composeProjector, decomposeProjector, describeProjector, projectPoint, projectorMatrices, solveProjector } from '../src/projector.ts';
import type { CalibrationPair, ProjectorCamera, Vec3 } from '../src/projector.ts';

test('the twin mesh parses from its wire form', () => {
  // Two vertices and one (degenerate) triangle are enough to check every block's offset.
  const buffer = new ArrayBuffer(32 + 2 * 20 + 3 * 4);
  const view = new DataView(buffer);
  [0x4d, 0x52, 0x53, 0x4d].forEach((c, i) => view.setUint8(i, c));
  view.setUint16(4, 1, true);
  view.setUint32(8, 2, true);
  view.setUint32(12, 3, true);
  view.setFloat32(16, -1.5, true);
  view.setFloat32(20, 9, true);
  [1, 2, 3, 4, 5, 6].forEach((v, i) => view.setFloat32(32 + i * 4, v, true));
  [0, 0, 127, 1, 129, 0, 0, 2].forEach((v, i) => view.setUint8(56 + i, v));
  view.setUint32(64, 0, true);
  view.setUint32(68, 12, true);
  [0, 1, 1].forEach((v, i) => view.setUint32(72 + i * 4, v, true));
  const twin = parseTwin(buffer);
  assert.deepEqual([...twin.positions], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...twin.normals], [0, 0, 127, -127, 0, 0]);
  assert.deepEqual([...twin.kinds], [1, 2]);
  assert.deepEqual([...twin.buildings], [0, 12]);
  assert.deepEqual([...twin.indices], [0, 1, 1]);
  assert.equal(twin.minZ, -1.5);
  assert.throws(() => parseTwin(buffer.slice(0, 60)));
});

/** A projector 900 m up and off to the south-west, looking at the model through a shifted lens. */
function testCamera(mirrored = false): { camera: ProjectorCamera; image: { width: number; height: number } } {
  const image = { width: 1920, height: 1080 };
  const position: Vec3 = [-180, -260, 900];
  const norm = (v: Vec3): Vec3 => v.map((c) => c / Math.hypot(...v)) as Vec3;
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const forward = norm([30 - position[0], 20 - position[1], -position[2]]);
  const right = norm(cross(forward, [0, 1, 0.2]));
  const down = cross(forward, right);
  const rotation: [Vec3, Vec3, Vec3] = [right, down, forward];
  const translation = rotation.map((r) => -(r[0] * position[0] + r[1] * position[1] + r[2] * position[2])) as Vec3;
  return { camera: { fx: 1650, fy: 1640, cx: 1010, cy: 380, skew: 0, rotation, translation, position, mirrored }, image };
}

const corners: Vec3[] = [
  [-480, 290, 2], [470, 280, 0], [460, -285, 4], [-470, -290, 1],
  [-200, 120, 42], [150, 60, 82], [240, -150, 24], [-60, -200, 55], [20, 10, 12], [-320, -40, 30],
];

test('a projector is recovered from marker and corner pairs', () => {
  const { camera, image } = testCamera();
  const truth = composeProjector(camera, image);
  const pairs: CalibrationPair[] = corners.map((model) => ({ model, image: projectPoint(truth, model).slice(0, 2) as [number, number] }));
  const solved = solveProjector(pairs, image);
  assert.ok(solved.error_px < 1e-3, `error ${solved.error_px}`);
  const found = decomposeProjector(solved.matrix, image);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(found.position[i]! - camera.position[i]!) < 0.05, `position ${found.position}`);
  assert.ok(Math.abs(found.fx - camera.fx) < 0.5 && Math.abs(found.cy - camera.cy) < 0.5);
  assert.equal(found.mirrored, false);
  // A point that was not a marker lands where the true camera puts it.
  const [u, v] = projectPoint(solved.matrix, [333, -77, 19]);
  const [tu, tv] = projectPoint(truth, [333, -77, 19]);
  assert.ok(Math.hypot(u - tu, v - tv) < 0.01);

  const summary = describeProjector(solved.matrix, image);
  assert.ok(summary.pitch_deg > 60 && summary.pitch_deg < 90, `pitch ${summary.pitch_deg}`);
  assert.ok(Math.abs(summary.lens_shift.y - (380 / 1080 - 0.5)) < 0.002);
});

test('calibration tolerates marker noise and reports it', () => {
  const { camera, image } = testCamera();
  const truth = composeProjector(camera, image);
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 3;
  const pairs: CalibrationPair[] = corners.map((model) => {
    const [u, v] = projectPoint(truth, model);
    return { model, image: [u + noise(), v + noise()] };
  });
  const solved = solveProjector(pairs, image);
  assert.ok(solved.error_px > 0.1 && solved.error_px < 2, `error ${solved.error_px}`);
  const [u, v] = projectPoint(solved.matrix, [0, 0, 20]);
  const [tu, tv] = projectPoint(truth, [0, 0, 20]);
  assert.ok(Math.hypot(u - tu, v - tv) < 3, 'the solved camera stays within the noise');
});

test('calibration refuses too few or coplanar markers', () => {
  const { camera, image } = testCamera();
  const truth = composeProjector(camera, image);
  const pair = (model: Vec3): CalibrationPair => ({ model, image: projectPoint(truth, model).slice(0, 2) as [number, number] });
  assert.throws(() => solveProjector(corners.slice(0, 5).map(pair), image), /at least 6/);
  const flat: Vec3[] = [[-400, 200, 0], [400, 200, 0], [400, -200, 0], [-400, -200, 0], [0, 0, 0], [100, 50, 0], [-150, 80, 0]];
  assert.throws(() => solveProjector(flat.map(pair), image), /one plane/);
});

test('a mirrored projector is recognised and rendered unmirrored', () => {
  const { camera, image } = testCamera(true);
  const truth = composeProjector(camera, image);
  const pairs: CalibrationPair[] = corners.map((model) => ({ model, image: projectPoint(truth, model).slice(0, 2) as [number, number] }));
  const solved = solveProjector(pairs, image);
  assert.ok(solved.error_px < 1e-3, `error ${solved.error_px}`);
  const found = decomposeProjector(solved.matrix, image);
  assert.equal(found.mirrored, true);
  assert.ok(Math.abs(found.position[2] - 900) < 0.05);
});

test('the renderer matrices agree with the projection', () => {
  const { camera, image } = testCamera();
  const matrix = composeProjector(camera, image);
  const { view, projection } = projectorMatrices(camera, image, 100, 2000);
  const apply = (m: number[], p: number[]) => [0, 1, 2, 3].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]! * p[3]!);
  for (const point of corners) {
    const clip = apply(projection, apply(view, [...point, 1]));
    const [u, v, depth] = projectPoint(matrix, point);
    assert.ok(Math.abs(((clip[0]! / clip[3]! + 1) / 2) * image.width - u) < 1e-6);
    assert.ok(Math.abs(((1 - clip[1]! / clip[3]!) / 2) * image.height - v) < 1e-6);
    assert.ok(Math.abs(clip[3]! - depth) < 1e-6);
    assert.ok(Math.abs(clip[2]! / clip[3]!) < 1, 'inside the depth range');
  }
});

test('streets that cross the table reach all of it; streets from another place reach a corner (#180)', () => {
  const space = { width: 1000, height: 600 };
  // A grid of streets running past every edge.
  const grid: [number, number][][] = [];
  for (let x = -500; x <= 1500; x += 100) grid.push([[x, -300], [x, 900]]);
  for (let y = -300; y <= 900; y += 100) grid.push([[-500, y], [1500, y]]);
  assert.equal(tableReach(grid, space), 1);
  // The same grid moved a kilometre north-west clips one corner.
  const away = grid.map((line) => line.map(([x, y]): [number, number] => [x - 1400, y - 800]));
  assert.ok(tableReach(away, space) > 0 && tableReach(away, space) < STRAY_REACH);
  assert.equal(tableReach([[[2000, 2000]]], space), 0);
});
