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
