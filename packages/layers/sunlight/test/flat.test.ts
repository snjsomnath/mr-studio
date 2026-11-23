import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasShade, isFlat } from '../src/flat.ts';

const frame = (data: Uint8Array | Float32Array, min: number, max: number) =>
  ({ stream: 1, field: 0, width: data.length, height: 1, revision: 1, min, max, progress: 1, data }) as never;

test('a table lit everywhere is flat', () => {
  assert.equal(isFlat(frame(new Float32Array([1, 1, 1, 1]), 1, 1)), true);
  assert.equal(isFlat(frame(new Uint8Array([255, 255, 254, 255]), 0, 1)), true);
});

test('a shadow anywhere is not flat', () => {
  assert.equal(isFlat(frame(new Float32Array([1, 1, 0.2, 1]), 0.2, 1)), false);
  assert.equal(isFlat(frame(new Uint8Array([255, 0, 255, 255]), 0, 1)), false);
});

test('sun hours the same everywhere are flat', () => {
  assert.equal(isFlat(frame(new Float32Array([18.4, 18.4, 18.4]), 18.4, 18.4)), true);
});

test('tree shade is found only where there is some', () => {
  assert.equal(hasShade(frame(new Float32Array([0, 0, 0]), 0, 0)), false);
  assert.equal(hasShade(frame(new Uint8Array([0, 0, 0]), 0, 1)), false);
  assert.equal(hasShade(frame(new Uint8Array([0, 40, 0]), 0, 1)), true);
});
