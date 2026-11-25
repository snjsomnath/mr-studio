// What a version changed (#395): the History panel's lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeChange, type DiffNames } from '../src/editor/history-diff.ts';

const names: DiffNames = {
  layer: (use) => ({ wind: 'Wind', sunlight: 'Sun study', trees: 'Trees' })[use],
  control: (use, id) => (use === 'wind' && id === 'speed' ? { label: 'Wind speed', unit: 'm/s', default: 5 } : undefined),
};

test('a changed setting reads with its label, before and after', () => {
  const before = { name: 'A', layers: [{ use: 'wind', params: { speed: 5 } }] };
  const after = { name: 'A', layers: [{ use: 'wind', params: { speed: 8 } }] };
  assert.deepEqual(describeChange(before, after, names), ['Wind: wind speed 5 → 8 m/s']);
  // Never set before: it was at its default.
  assert.deepEqual(describeChange({ name: 'A', layers: [{ use: 'wind' }] }, after, names), ['Wind: wind speed 5 → 8 m/s']);
});

test('added and removed layers, items inside layers, and the name', () => {
  const before = { name: 'A', layers: [{ use: 'wind' }, { use: 'trees' }] };
  const after = { name: 'B', layers: [{ use: 'wind', items: [{ use: 'sunlight' }] }] };
  assert.deepEqual(describeChange(before, after, names), ['Added Sun study', 'Removed Trees', 'Name: A → B']);
});

test('the first version and a reorder', () => {
  assert.deepEqual(describeChange(null, {}, names), ['The table as it was when it was first opened']);
  const before = { layers: [{ use: 'wind' }, { use: 'trees' }] };
  const after = { layers: [{ use: 'trees' }, { use: 'wind' }] };
  assert.deepEqual(describeChange(before, after, names), ['The order of the layers']);
});
