// The play head (#373): every view works out the same time from the host's anchor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockAt, clockControl } from '../src/clock.ts';
import type { LayerManifest } from '../src/types.ts';

const hour = { min: 0, max: 24, clock: 'hour' as const };
const progress = { min: 0, max: 100, clock: 'progress' as const };

test('a play head moves at its rate from where the table set it', () => {
  assert.equal(clockAt(undefined, 1000), null);
  assert.equal(clockAt({ value: 9, rate: 0.5, at: 1000 }, 5000), 11);
  // A clock that stands still stays put, and the host's moment before `at` does not run it back.
  assert.equal(clockAt({ value: 9, rate: 0, at: 1000 }, 99_000, hour), 9);
  assert.equal(clockAt({ value: 9, rate: 0.5, at: 1000 }, 0), 9);
});

test('a day wraps around midnight, a run stops at its end', () => {
  assert.equal(clockAt({ value: 23, rate: 1, at: 0 }, 3000, hour), 2);
  assert.equal(clockAt({ value: 95, rate: 2, at: 0 }, 10_000, progress), 100);
  assert.equal(clockAt({ value: 5, rate: -2, at: 0 }, 10_000, progress), 0);
});

test('a layer’s time control is its clock hour or progress range', () => {
  const manifest = {
    controls: [
      { id: 'play', type: 'toggle', clock: 'play', label: 'Play', default: false },
      { id: 'hour', type: 'range', clock: 'hour', label: 'Time', min: 0, max: 24, default: 12 },
    ],
  } as unknown as LayerManifest;
  assert.equal(clockControl(manifest)?.id, 'hour');
  assert.equal(clockControl({ controls: [] } as unknown as LayerManifest), undefined);
});
