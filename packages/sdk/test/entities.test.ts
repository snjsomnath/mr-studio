import assert from 'node:assert/strict';
import { test } from 'node:test';

import { entityChanges, entityFeatures, entityValues, factsOf, pickEntity } from '../src/entities.ts';
import type { EntitySet } from '../src/types.ts';

const set: EntitySet = {
  id: 'members',
  dataset: 'buildings',
  key: 'id',
  label: 'name',
  group: 'owner',
  controls: [
    { id: 'in', type: 'toggle', label: 'In', default: false },
    { id: 'pv', type: 'range', label: 'PV', min: 0, max: 80, default: 0 },
  ],
};

const square = (x: number, y: number, d = 0.001) => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]],
});

const collection = {
  features: [
    { properties: { id: 1, name: 'Kårhuset', owner: 'Chalmers' }, geometry: square(11.97, 57.69) },
    { properties: { id: 2, owner: 'Akademiska Hus' }, geometry: square(11.972, 57.69) },
    { properties: { name: 'no key' }, geometry: square(11.974, 57.69) },
    { properties: { id: 1, name: 'twice' }, geometry: square(11.976, 57.69) },
    { properties: { id: 'stop' }, geometry: { type: 'Point', coordinates: [11.98, 57.69] } },
  ],
};

test('features are listed by key, with their name and group', () => {
  const list = entityFeatures(collection, set);
  assert.deepEqual(list.map((f) => [f.id, f.label, f.group]), [
    ['1', 'Kårhuset', 'Chalmers'],
    ['2', '2', 'Akademiska Hus'],
    ['stop', 'stop', undefined],
  ]);
});

test('a tap picks the area it is in, or the nearest point within reach', () => {
  const list = entityFeatures(collection, set);
  assert.equal(pickEntity(list, [11.9705, 57.6905])?.id, '1');
  assert.equal(pickEntity(list, [11.9725, 57.6905])?.id, '2');
  // About 6 m east of the stop: picked; 60 m away: nothing.
  assert.equal(pickEntity(list, [11.9801, 57.69])?.id, 'stop');
  assert.equal(pickEntity(list, [11.981, 57.69]), null);
});

test('values are the defaults with the changes on top', () => {
  const params = { entities: { members: { '1': { pv: 40 } } } };
  assert.deepEqual(entityValues(set, params, '1'), { in: false, pv: 40 });
  assert.deepEqual(entityValues(set, params, '2'), { in: false, pv: 0 });
  assert.deepEqual(entityValues(set, {}, '1'), { in: false, pv: 0 });
});

test('changes name the entities whose values differ', () => {
  const before = { entities: { members: { '1': { pv: 40 }, '2': { in: true } } } };
  const after = { entities: { members: { '1': { pv: 45 }, '2': { in: true }, '3': { pv: 5 } } } };
  assert.deepEqual(entityChanges(before, after), [{ set: 'members', ids: ['1', '3'] }]);
  assert.deepEqual(entityChanges(after, after), []);
  assert.deepEqual(entityChanges(after, {}), [{ set: 'members', ids: ['1', '2', '3'] }]);
});

test('tap to read: features by their place in the file, with their facts', () => {
  const read = entityFeatures(collection, { key: '#', label: 'name', facts: ['owner', 'floor_area', 'name'] });
  assert.deepEqual(read.map((f) => f.id), ['1', '2', '3', '4', '5']);
  assert.equal(read[0]!.label, 'Kårhuset');
  assert.equal(read[1]!.label, '2');
  assert.deepEqual(read[0]!.facts, [['Owner', 'Chalmers']]);
  assert.deepEqual(factsOf({ floor_area: 12345.678, ok: true }, ['floor_area', 'ok', 'missing']), [['Floor area', '12,345.68'], ['Ok', 'Yes']]);
  // Without facts nothing extra is kept.
  assert.equal(entityFeatures(collection, set)[0]!.facts, undefined);
});
