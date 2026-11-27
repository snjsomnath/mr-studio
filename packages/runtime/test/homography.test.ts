import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cssMatrix, homography } from '../src/model/homography.ts';

const apply = (h: number[], [x, y]: [number, number]): [number, number] => {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
};

test('a homography takes the four corners where they were asked to go (#650)', () => {
  const from: [number, number][] = [[0, 0], [1920, 0], [1920, 1200], [0, 1200]];
  const to: [number, number][] = [[14, -11], [1930, 2], [1910, 1195], [8, 1185]];
  const h = homography(from, to)!;
  for (let i = 0; i < 4; i++) {
    const [x, y] = apply(h, from[i]!);
    assert.ok(Math.abs(x - to[i]![0]) < 1e-6 && Math.abs(y - to[i]![1]) < 1e-6, `corner ${i}`);
  }
});

test('a pure shift is a translation, written for CSS', () => {
  const from: [number, number][] = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const h = homography(from, from.map(([x, y]) => [x + 12, y - 9]))!;
  assert.equal(cssMatrix(h).replace(/(\d)\.\d+e-\d+/g, '0'), 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,12,-9,0,1)');
});

test('degenerate corners give no homography', () => {
  assert.equal(homography([[0, 0], [0, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [1, 1], [0, 1]]), null);
});
