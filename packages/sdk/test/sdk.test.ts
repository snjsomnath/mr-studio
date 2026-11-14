import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lut, colormaps } from '../src/colormap.ts';
import { isVisible } from '../src/controls.ts';
import { parseFrame, sample } from '../src/frame.ts';
import { lonLatToTable, tableToLonLat } from '../src/geo.ts';
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
