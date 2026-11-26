import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePalette } from '../src/palette.ts';
import { rasterPicture, rasterProps } from '../src/raster-look.ts';
import type { FieldFrame } from '../src/types.ts';

/** A 10 by 1 field of 0 to 9 m, with one cell of no data. */
const field = (): FieldFrame => {
  const data = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  data[4] = NaN;
  return { stream: 0, field: 0, width: 10, height: 1, revision: 1, min: 0, max: 9, progress: 1, data };
};

test('a raster is coloured by value, with no data left empty', () => {
  const picture = rasterPicture(field(), rasterProps({ unit: 'm' }), resolvePalette());
  assert.deepEqual(picture.range, [0, 9]);
  const levels = [...picture.frame.data];
  assert.equal(levels[4], 0, 'no data is hidden');
  assert.equal(levels[0], 1, 'the lowest value is the first level');
  assert.equal(levels[9], 255, 'the highest value is the last level');
  assert.ok(levels[1]! < levels[2]!, 'levels follow the values');
  assert.equal(picture.colormap.stops[0]![4], 0, 'level 0 is transparent');
  assert.equal(picture.edge, null, 'nothing is cut, so nothing glows');
  assert.ok(picture.legend.length > 0 && picture.legend.every((row) => row.label.endsWith(' m')));
});

test('Dig hides what is below the cut and the cut can glow', () => {
  const picture = rasterPicture(field(), rasterProps({ hide_below: 0, edge_glow: 0.8 }, { hide_below: 6 }), resolvePalette());
  const levels = [...picture.frame.data];
  assert.deepEqual(levels.slice(0, 6), [0, 0, 0, 0, 0, 0]);
  assert.ok(levels.slice(6).every((v) => v > 0));
  // The glow is the band just inside the cut: the cell at 6 m, not the ones well past it.
  assert.ok(picture.edge);
  assert.equal(picture.edge.data[6], 255);
  assert.equal(picture.edge.data[9], 0);
  assert.equal(picture.edgeColormap.stops[1]![4], Math.round(255 * 0.8));
});

test('cut-offs read from controls as numbers, and an empty one hides nothing', () => {
  const props = rasterProps({ hide_above: '' }, { hide_below: '3' });
  assert.equal(props.hide_below, 3);
  assert.equal(props.hide_above, null);
  const picture = rasterPicture(field(), rasterProps({}, { hide_above: 2 }), resolvePalette());
  assert.deepEqual([...picture.frame.data].slice(3).filter((v) => v > 0), []);
});
