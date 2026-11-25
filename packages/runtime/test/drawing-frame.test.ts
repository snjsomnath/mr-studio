import assert from 'node:assert/strict';
import { test } from 'node:test';

// The frame's geometry only: the class needs a browser.
globalThis.ResizeObserver ??= class {} as unknown as typeof ResizeObserver;
const { frameAngle, frameCorners, moveFrame, returnFrame, scaleFrame, squareUp, turnFrame } = await import('../src/editor/drawing-frame.ts');

type Frame = [[number, number], [number, number], [number, number]];
const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-9);

test('a drawing frame moves, scales and turns about its middle (#301)', () => {
  const frame: Frame = [[0, 0], [100, 0], [0, 60]];
  assert.deepEqual(moveFrame(frame, [10, 5]), [[10, 5], [110, 5], [10, 65]]);
  assert.deepEqual(scaleFrame(frame, 0.5), [[25, 15], [75, 15], [25, 45]]);
  assert.deepEqual(frameCorners(frame)[2], [100, 60]);
  const turned = turnFrame(frame, 90);
  assert.ok(near(turned[0], [80, -20]) && near(turned[1], [80, 80]), JSON.stringify(turned));
  assert.ok(Math.abs(frameAngle(turned) - 90) < 1e-9);
  // Nearly square to the table snaps square; well off it is left alone.
  assert.ok(Math.abs(frameAngle(squareUp(turnFrame(frame, 1))) % 360) < 1e-9);
  assert.ok(Math.abs(frameAngle(squareUp(turnFrame(frame, 10))) - 10) < 1e-9);
});

test('a quarter turn swaps the frame sides about its middle and keeps its direction', () => {
  const frame: Frame = [[0, 0], [100, 0], [0, 60]];
  const swapped = returnFrame(frame, 1);
  assert.ok(near(swapped[0], [20, -20]) && near(swapped[1], [80, -20]) && near(swapped[2], [20, 80]), JSON.stringify(swapped));
  assert.deepEqual(returnFrame(frame, 2), frame);
});

test('Snap to buildings fits a drawing frame to the footprint outlines (#379)', async () => {
  const { fitFrame, frameScore, outlinePoints } = await import('../src/editor/drawing-snap.ts');
  // A 200 x 100 m drawing of two building outlines, pictured 400 x 200 px (2 px a metre).
  const [W, H] = [400, 200];
  const edges = new Uint8Array(W * H);
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) for (const d of [-1, 0, 1]) edges[(y + d) * W + x] = 1;
    for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) for (const d of [-1, 0, 1]) edges[y * W + x + d] = 1;
  };
  box(40, 40, 140, 120);
  box(220, 60, 340, 160);
  const ink = { width: W, height: H, edges };
  // The same buildings on the table, where the drawing belongs at (50, 30), 200 x 100 m.
  const at = (x: number, y: number): [number, number] => [50 + x / 2, 30 + y / 2];
  const rings = [
    [at(40, 40), at(140, 40), at(140, 120), at(40, 120), at(40, 40)],
    [at(220, 60), at(340, 60), at(340, 160), at(220, 160), at(220, 60)],
  ];
  const points = outlinePoints(rings, 0.5);
  const right: Frame = [[50, 30], [250, 30], [50, 130]];
  assert.ok(frameScore(ink, right, points) > 0.95);
  // Placed 6 m off, a little turned and 5 % too large, it snaps back.
  const off = (f: Frame) => moveFrame(scaleFrame(turnFrame(f, 1.2), 1.05), [6, -4]);
  const fit = fitFrame(ink, off(right), points);
  assert.ok(fit.before < 0.5 && fit.after > 0.9, JSON.stringify({ before: fit.before, after: fit.after }));
  for (let k = 0; k < 3; k++) assert.ok(Math.hypot(fit.frame[k]![0] - right[k]![0], fit.frame[k]![1] - right[k]![1]) < 1.5, JSON.stringify(fit.frame));
});
