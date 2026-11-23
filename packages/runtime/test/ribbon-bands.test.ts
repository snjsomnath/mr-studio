import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pixelsPerCm, ribbonBands, sidesByPreference } from '../src/ribbon-bands.ts';

// A 100 x 60 cm model drawn 1000 x 600 px (10 px per cm) at the top of a 1000 x 800 window: 20 cm free below.
const footprint: [number, number][] = [[0, 0], [1000, 0], [1000, 600], [0, 600]];
const surface = { width: 1000, height: 800 };
const table = { width_cm: 100, height_cm: 60 };

test('pixels per cm come from the model and its size', () => {
  assert.equal(pixelsPerCm(footprint, table), 10);
});

test('the front edge gets an auto ribbon by default, below the model with a gap (#78)', () => {
  const [band, ...rest] = ribbonBands({ footprint, surface, table });
  assert.equal(rest.length, 0, 'the other sides are off');
  assert.equal(band!.side, 'bottom');
  assert.equal(band!.cm, 9);
  assert.deepEqual(band!.rect, { left: 0, top: 605, width: 1000, height: 90 });
  assert.equal(band!.turn, 0);
});

test('a set size is clamped to the free space, and a side without room is skipped', () => {
  const big = ribbonBands({ footprint, surface, table: { ...table, ribbons: { bottom: { cm: 30 } } } });
  assert.equal(big[0]!.cm, 19.5, '20 cm free, less the gap');
  const tight = ribbonBands({ footprint, surface: { width: 1000, height: 630 }, table });
  assert.deepEqual(tight, [], '3 cm free is less than a ribbon needs');
  const top = ribbonBands({ footprint, surface, table: { ...table, ribbons: { top: 'auto' } } });
  assert.deepEqual(top, [], 'no room above the model');
});

test('ribbons face their own edge and auto prefers the front', () => {
  assert.deepEqual(sidesByPreference('left'), ['left', 'bottom', 'top', 'right']);
  const centred: [number, number][] = [[200, 100], [800, 100], [800, 460], [200, 460]];
  const bands = ribbonBands({ footprint: centred, surface, table: { ...table, front: 'left', ribbons: { left: 'auto', right: { cm: 6 }, top: 'off' } } });
  assert.deepEqual(bands.map((b) => [b.side, b.turn, b.front]), [['left', 90, true], ['right', -90, false]]);
});

test('the editor preview always has room', () => {
  const bands = ribbonBands({ footprint, surface: { width: 1000, height: 600 }, table, preview: true });
  assert.equal(bands[0]!.cm, 9);
});
