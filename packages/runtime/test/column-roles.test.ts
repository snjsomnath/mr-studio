import assert from 'node:assert/strict';
import { test } from 'node:test';

import { columnRoles } from '../src/editor/column-roles.ts';

test('columns are read by what they hold as a dataset comes in (#52)', () => {
  const rows = [
    { zone: 'Z1', population: 2152, kind: 'housing', pop_2000: 1, year: 2020, lat: 57.7, lon: 11.9, note: 'a' },
    { zone: 'Z2', population: 1744, kind: 'office', pop_2000: 2, year: 2021, lat: 57.71, lon: 11.91, note: 'b' },
    { zone: 'Z3', population: 1900, kind: 'housing', pop_2000: 3, year: 2022, lat: 57.72, lon: 11.92, note: 'c' },
  ];
  const roles = Object.fromEntries(columnRoles(rows).map((c) => [c.name, c.role]));
  assert.deepEqual(roles, { zone: 'id', population: 'value', kind: 'category', pop_2000: 'time', year: 'time', lat: 'place', lon: 'place', note: 'id' });
});

test('dates, empty columns and nested values', () => {
  const rows = [
    { when: '2024-05-01T08:00', count: 3, nested: { a: 1 }, empty: '' },
    { when: '2024-05-01T09:00', count: 3, nested: { a: 2 }, empty: null },
  ];
  assert.deepEqual(columnRoles(rows), [
    { name: 'when', role: 'time' },
    { name: 'count', role: 'category' },
  ]);
});
