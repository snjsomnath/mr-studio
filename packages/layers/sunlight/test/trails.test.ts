import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nearestTrail, shadeClock, softened, trailColour, trailHours } from '../src/trails.ts';

test('only hours with the sun well up get a trail', () => {
  // A sun that rises at 6 and sets at 18, highest at noon.
  const altitude = (h: number) => 40 * Math.sin(((h - 6) / 12) * Math.PI);
  assert.deepEqual(trailHours(altitude), [8, 10, 12, 14, 16]);
  assert.equal(nearestTrail([8, 10, 12], 10.6), 10);
  assert.equal(nearestTrail([8, 10, 12], 15), null);
});

test('trails run from cool morning through pale noon to warm evening', () => {
  const [morning, noon, evening] = [trailColour(0), trailColour(0.5), trailColour(1)];
  assert.ok(morning[2] > morning[0], 'morning is blue');
  assert.ok(noon.every((c) => c > 200), 'noon is pale');
  assert.ok(evening[0] > evening[2], 'evening is warm');
});

const frame = (width: number, height: number, data: Uint8Array) => ({ stream: 0, field: 0, width, height, revision: 0, min: 0, max: 1, progress: 1, data });

test('softening turns a step into a slope', () => {
  const out = softened(frame(4, 2, new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255])));
  assert.deepEqual([...out.data].slice(0, 4).map((v) => Math.round(v * 100) / 100), [0, 0.33, 0.67, 1]);
});

test('a fine grid is traced on a coarser one', () => {
  const out = softened(frame(1000, 600, new Uint8Array(1000 * 600)), 320);
  assert.equal(out.width, 250);
  assert.equal(out.height, 150);
});

test('the shade clock colours ground by the hours that shade it', () => {
  const field = (data: number[]) => ({ stream: 0, field: 0, width: 3, height: 1, revision: 0, min: 0, max: 1, progress: 1, data: new Float32Array(data) });
  // Cell 0 is shaded in the morning, cell 1 in the evening, cell 2 never.
  const pixels = shadeClock([
    { share: 0, field: field([0, 1, 1]) },
    { share: 1, field: field([1, 0, 1]) },
  ]);
  assert.deepEqual([...pixels.slice(0, 3)], trailColour(0));
  assert.deepEqual([...pixels.slice(4, 7)], trailColour(1));
  assert.equal(pixels[11], 0);
  assert.ok(pixels[3]! > 0 && pixels[3]! < 255);
});
