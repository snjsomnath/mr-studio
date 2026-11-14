import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lut, colormaps, stretch } from '../src/colormap.ts';
import { isVisible } from '../src/controls.ts';
import { FlowField, Tracers } from '../src/flow.ts';
import { parseFrame, sample } from '../src/frame.ts';
import type { FieldFrame } from '../src/types.ts';
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

test('a flow field eases towards new frames', () => {
  const field = gapField('f32', 4);
  const target = gapField('f32', 8);
  field.blendTowards(target, 0.25);
  assert.ok(Math.abs(field.u[0]! - (4 + 4 * (1 - Math.exp(-1)))) < 1e-4);
  for (let k = 0; k < 40; k++) field.blendTowards(target, 0.25);
  assert.ok(Math.abs(field.u[0]! - 8) < 1e-3);
});
