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
