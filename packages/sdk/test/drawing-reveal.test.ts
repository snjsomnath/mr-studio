import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, batchProgress, growRadius, invert, multiply, openingAt, parseCorners, parseTransform, placement, shapePath, stagedWeight, traceBucket } from '../src/drawing-reveal.ts';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('SVG transforms read in order and invert', () => {
  const m = parseTransform('translate(10 20) scale(2) rotate(90)');
  const [x, y] = apply(m, [1, 0]);
  assert.ok(near(x, 10) && near(y, 22), 'rotate first, then scale, then translate');
  const back = apply(invert(m), [x, y]);
  assert.ok(near(back[0], 1) && near(back[1], 0));
  assert.deepEqual(parseTransform('matrix(1, 0, 0, -1, 5, 6)'), [1, 0, 0, -1, 5, 6]);
  assert.deepEqual(parseTransform(null), [1, 0, 0, 1, 0, 0]);
  const around = apply(parseTransform('rotate(180 5 5)'), [0, 0]);
  assert.ok(near(around[0], 10) && near(around[1], 10), 'rotate about a point');
  assert.deepEqual(multiply([1, 0, 0, 1, 1, 1], [2, 0, 0, 2, 0, 0]), [2, 0, 0, 2, 1, 1]);
});

test('shapes become path data', () => {
  assert.equal(shapePath('line', (n) => ({ x1: '0', y1: '1', x2: '2', y2: '3' })[n] ?? null), 'M0 1L2 3');
  assert.equal(shapePath('polygon', (n) => (n === 'points' ? '0,0 4,0 4,4' : null)), 'M0 0L4 0L4 4Z');
  assert.equal(shapePath('rect', (n) => ({ x: '1', y: '2', width: '3', height: '4' })[n] ?? null), 'M1 2h3v4h-3Z');
  assert.match(shapePath('circle', (n) => ({ cx: '5', cy: '5', r: '2' })[n] ?? null) ?? '', /^M3 5a2 2/);
  assert.equal(shapePath('g', () => null), null);
});

test('the trace wakes from the middle outwards and every batch finishes', () => {
  const middle = traceBucket(500, 300, 1000, 600);
  const corner = traceBucket(2, 2, 1000, 600);
  assert.ok(middle < corner, 'the middle comes in before the corners');
  assert.equal(traceBucket(500, 300, 1000, 600), middle, 'the same every time');
  assert.equal(batchProgress(0, 0), 0);
  assert.equal(batchProgress(1, 23), 1);
  assert.ok(batchProgress(0.5, 0) > batchProgress(0.5, 20));
});

test('the opening comes in, holds, then turns to colour', () => {
  const timing = { in_s: 10, colour_after_s: 2, colour_s: 4 };
  assert.deepEqual(openingAt(0, timing), { drawn: 0, colour: 0 });
  assert.equal(openingAt(5, timing).drawn, 0.5);
  assert.equal(openingAt(11, timing).colour, 0, 'still lines while it holds');
  assert.equal(openingAt(14, timing).colour, 0.5);
  assert.equal(openingAt(20, timing).colour, 1);
  assert.equal(openingAt(20, { ...timing, colour_after_s: null }).colour, 0, 'no colour version, no turn');
  assert.equal(openingAt(0, { in_s: 0, colour_after_s: null, colour_s: 0 }).drawn, 1);
});

test('a drawing is stretched over the table or placed by its corners', () => {
  const table = { width: 1000, height: 600 };
  assert.deepEqual(apply(placement(table), [1, 1]), [1000, 600]);
  const placed = placement(table, [[-100, -50], [1100, -50], [-100, 650]]);
  assert.deepEqual(apply(placed, [0, 0]), [-100, -50]);
  assert.deepEqual(apply(placed, [1, 1]), [1100, 650]);
  assert.deepEqual(parseCorners('11.9,57.7; 11.95,57.7; 11.9,57.68'), [[11.9, 57.7], [11.95, 57.7], [11.9, 57.68]]);
  assert.equal(parseCorners(''), null);
  assert.equal(parseCorners('1,2; 3,4'), null);
  assert.equal(growRadius([0, 0], [0, 0, 3, 4]), 5);
});

test('staged weights: a masterplan keeps its phases, viewpoints dim the earlier ones', () => {
  const plan = { overview: 'all', earlier: 1, later: 0.12, finale: null } as const;
  assert.deepEqual([0, 1, 2].map((k) => stagedWeight(k, 0, 3, plan)), [1, 1, 1]);
  assert.deepEqual([0, 1, 2].map((k) => stagedWeight(k, 2, 3, plan)), [1, 1, 0.12]);
  const viewpoints = { overview: 'none', earlier: 0.25, later: 0, finale: 0.8 } as const;
  assert.deepEqual([0, 1, 2].map((k) => stagedWeight(k, 0, 3, viewpoints)), [0, 0, 0]);
  assert.deepEqual([0, 1, 2].map((k) => stagedWeight(k, 2, 3, viewpoints)), [0.25, 1, 0]);
  assert.deepEqual([0, 1, 2].map((k) => stagedWeight(k, 4, 3, viewpoints)), [0.8, 0.8, 0.8]);
});
