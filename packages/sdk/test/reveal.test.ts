import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HoverRegions, areaRegion, circleRegion, maskRegion } from '../src/blocks/interaction.ts';
import type { PointerSample } from '../src/blocks/interaction.ts';
import { revealContains, revealPolygon, revealUniform, sameReveal } from '../src/reveal.ts';

const sample = (id: string, point: [number, number], time: number, phase: PointerSample['phase'] = 'move', source: PointerSample['source'] = 'mouse'): PointerSample => ({
  id,
  source,
  phase,
  point,
  lonLat: [0, 0],
  pressed: false,
  time,
});

test('a reveal circle and a reveal side say what is inside', () => {
  const circle = { kind: 'circle', centre: [50, 50], radius_m: 10 } as const;
  assert.ok(revealContains(circle, [55, 50]));
  assert.ok(!revealContains(circle, [61, 50]));
  const left = { kind: 'side', axis: 'x', at_m: 40, keep: 'before' } as const;
  assert.ok(revealContains(left, [39, 0]));
  assert.ok(!revealContains(left, [41, 0]));
  const below = { kind: 'side', axis: 'y', at_m: 30, keep: 'after' } as const;
  assert.ok(revealContains(below, [0, 31]));
  assert.ok(!revealContains(below, [0, 29]));
  assert.ok(revealContains(null, [0, 0]), 'no shape shows everything');
  assert.ok(!revealContains({ kind: 'none' }, [0, 0]));
});

test('reveal polygons cover what the shape keeps', () => {
  const ring = revealPolygon({ kind: 'circle', centre: [10, 10], radius_m: 5 }, 100, 60, 8);
  assert.equal(ring.length, 8);
  for (const [x, y] of ring) assert.ok(Math.abs(Math.hypot(x - 10, y - 10) - 5) < 1e-9);
  const side = revealPolygon({ kind: 'side', axis: 'x', at_m: 40, keep: 'after' }, 100, 60);
  assert.ok(side.every(([x]) => x >= 40), 'the kept side starts at the line');
  assert.ok(side.some(([x]) => x > 100) && side.some(([, y]) => y > 60), 'and reaches past the table');
  assert.deepEqual(revealPolygon({ kind: 'none' }, 100, 60), []);
});

test('reveal shapes become shader numbers and compare by value', () => {
  assert.deepEqual(revealUniform(null), { kind: 0, values: [0, 0, 0] });
  assert.deepEqual(revealUniform({ kind: 'circle', centre: [1, 2], radius_m: 3 }), { kind: 1, values: [1, 2, 3] });
  assert.deepEqual(revealUniform({ kind: 'side', axis: 'y', at_m: 7, keep: 'before' }), { kind: 2, values: [1, 7, -1] });
  assert.deepEqual(revealUniform({ kind: 'none' }), { kind: 3, values: [0, 0, 0] });
  assert.ok(sameReveal({ kind: 'circle', centre: [1, 2], radius_m: 3 }, { kind: 'circle', centre: [1, 2], radius_m: 3 }));
  assert.ok(!sameReveal(null, { kind: 'none' }));
});

test('hover regions settle before they play, and end as soon as the pointer leaves', () => {
  const events: string[] = [];
  const regions = [circleRegion('a', [10, 10], 5), areaRegion('b', [[[[30, 0], [50, 0], [50, 20], [30, 20]]]])];
  const hover = new HoverRegions({ regions: () => regions, settle_s: 0.3, onEnter: (r) => events.push(`+${r.id}`), onLeave: (r) => events.push(`-${r.id}`) });
  hover.handle(sample('mouse:1', [10, 10], 0));
  hover.tick(0.1, 0.1);
  assert.deepEqual(events, [], 'passing over does nothing yet');
  hover.tick(0.25, 0.35);
  assert.deepEqual(events, ['+a']);
  assert.deepEqual(hover.active().map((r) => r.id), ['a']);
  hover.tick(1, 1.35);
  assert.equal(hover.level('a'), 1);
  hover.handle(sample('mouse:1', [40, 10], 1.4));
  assert.deepEqual(events, ['+a', '-a'], 'leaving ends it at once');
  hover.tick(0.3, 1.7);
  assert.deepEqual(events, ['+a', '-a', '+b']);
  assert.ok(hover.level('a') < 1 && hover.level('a') > 0, 'the old region fades out');
  hover.handle(sample('mouse:1', [40, 10], 1.8, 'leave'));
  assert.deepEqual(events.at(-1), '-b');
});

test('hover regions count a region held while any pointer, a hand too, is over it', () => {
  const events: string[] = [];
  const hover = new HoverRegions({ regions: () => [circleRegion('a', [0, 0], 10)], settle_s: 0, onEnter: (r) => events.push(`+${r.id}`), onLeave: (r) => events.push(`-${r.id}`) });
  hover.handle(sample('mouse:1', [1, 1], 0));
  hover.handle(sample('hand:right', [2, 2], 0, 'move', 'hand'));
  hover.handle(sample('mouse:1', [50, 50], 0.1));
  assert.deepEqual(events, ['+a'], 'the hand still holds it');
  hover.handle(sample('hand:right', [2, 2], 0.2, 'leave', 'hand'));
  assert.deepEqual(events, ['+a', '-a']);
  // A phone tap has no hover, and never uses a sample.
  assert.equal(hover.handle(sample('phone:3', [1, 1], 0.3, 'down', 'phone')), false);
  assert.deepEqual(events, ['+a', '-a']);
});

test('a mask region is inside where its picture is painted', () => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  data[(1 * 4 + 2) * 4 + 3] = 255; // pixel (2, 1)
  const region = maskRegion('m', { width: 4, height: 4, data }, { width: 100, height: 100 });
  assert.ok(region.contains([60, 30]));
  assert.ok(!region.contains([10, 10]));
  assert.ok(!region.contains([-5, 30]));
});
