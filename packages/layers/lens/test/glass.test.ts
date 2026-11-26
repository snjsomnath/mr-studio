import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drawGlass, type GlassLook } from '../src/glass.ts';

/** A drawing context that records every arc's radius and refuses a negative one, as a canvas does. */
function recorder() {
  const radii: number[] = [];
  const gradient = { addColorStop() {} };
  const g = new Proxy(
    {
      arc(_x: number, _y: number, r: number) {
        if (r < 0) throw new Error(`IndexSizeError: The radius provided (${r}) is negative.`);
        radii.push(r);
      },
      createRadialGradient: () => gradient,
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : () => {}), set: () => true },
  );
  return { g: g as unknown as CanvasRenderingContext2D, radii };
}

const look = (radius: number, line = 1): GlassLook => ({
  centre: [100, 100],
  radius,
  width: 400,
  height: 300,
  dim: 0.5,
  pinned: false,
  time: 0,
  arrival: 1,
  line,
  inside: null,
});

test('a glass that shrinks to nothing after its slide draws no negative circle (#553)', () => {
  for (const radius of [0, -5, 0.5, 2, 3, Number.NaN]) {
    const { g, radii } = recorder();
    assert.doesNotThrow(() => drawGlass(g, look(radius, 1.2)));
    assert.ok(radii.every((r) => r >= 0));
    if (!(radius > 0)) assert.equal(radii.length, 0, `radius ${radius} draws nothing`);
  }
});

test('a usual glass draws its rim, halo and the ring inside', () => {
  const { g, radii } = recorder();
  drawGlass(g, look(120));
  assert.ok(radii.includes(120 - 3), 'the faint ring inside');
});
