import assert from 'node:assert/strict';
import { test } from 'node:test';

import { edgeColours, glowSettings, paintGlow, SEGMENTS } from '../src/ambient-glow.ts';

type Quad = [[number, number], [number, number], [number, number], [number, number]];

/** A 100 × 60 picture: a dark map with a red band along the top of the model and a blue one down its left. */
function picture() {
  const [width, height] = [100, 60];
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const colour = y < 22 ? [230, 40, 30] : x < 24 ? [30, 60, 230] : [20, 22, 26];
      data.set([...colour, 255], i);
    }
  }
  return { width, height, data };
}
const model: Quad = [[10, 10], [90, 10], [90, 50], [10, 50]];

test('each edge glows in the colours along it, vivid colours over the dark map (#476)', () => {
  const [top, right, bottom, left] = edgeColours(picture(), model, 'edges');
  assert.equal(top!.length, SEGMENTS);
  for (const [r, , b] of top!) assert.ok(r > 150 && b < 80, 'the top edge is red');
  // Each edge runs clockwise from its first corner: the left edge goes from the bottom up.
  const [r, , b] = left![2]!;
  assert.ok(b > 150 && r < 80, 'low on the left edge is blue');
  // The bottom right is dark map only: the glow there stays dim, not grey or white.
  const [dr, dg, db] = bottom![1]!;
  assert.ok(dr < 100 && dg < 100 && db < 100, JSON.stringify(bottom![1]));
  assert.ok(right!.length === SEGMENTS);
});

test('one colour gives every edge the dominant colour', () => {
  const sides = edgeColours(picture(), model, 'one');
  const first = JSON.stringify(sides[0]![0]);
  for (const side of sides) for (const c of side) assert.equal(JSON.stringify(c), first);
  assert.ok(sides[0]![0]![0] > sides[0]![0]![1], 'red outweighs the dark map');
});

test('the glow is clear over the model and fades away from its edge', () => {
  const [width, height] = [100, 60];
  const out = new Uint8ClampedArray(width * height * 4);
  const white = Array.from({ length: 4 }, () => Array.from({ length: SEGMENTS }, () => [255, 255, 255] as [number, number, number]));
  paintGlow(out, width, height, model, white, 0.8, 8);
  const alpha = (x: number, y: number) => out[(y * width + x) * 4 + 3]!;
  assert.equal(alpha(50, 30), 0, 'nothing over the model');
  assert.ok(alpha(50, 9) > 150 && alpha(50, 9) <= 0.8 * 255, 'brightest at the edge, never past the strength');
  assert.ok(alpha(50, 2) < alpha(50, 6) && alpha(50, 6) < alpha(50, 9), 'fading outwards');
});

test('the setting is off unless the table turns it on', () => {
  assert.equal(glowSettings(null), null);
  assert.equal(glowSettings({ width_cm: 100, height_cm: 60 }), null);
  assert.equal(glowSettings({ width_cm: 100, height_cm: 60, glow: { on: false } }), null);
  assert.deepEqual(glowSettings({ width_cm: 100, height_cm: 60, glow: { strength: 3 } }), { on: true, strength: 1, colours: 'edges' });
});
