import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lut, colormaps } from '../src/colormap.ts';
import { isVisible } from '../src/controls.ts';
import { parseFrame, sample } from '../src/frame.ts';
import { sunPosition } from '../src/solar.ts';
import { formatHour, zonedTimeToUtc } from '../src/time.ts';

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
