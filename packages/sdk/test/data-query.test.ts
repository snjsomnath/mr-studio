import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dataQueryProblems, isDataQuery, rowsOf, runDataQuery } from '../src/data-query.ts';
import type { DataQuery } from '../src/data-query.ts';

const rows = rowsOf(
  ['building,year,hour,kwh,use', 'Kårhuset,2020,8,120,school', 'Kårhuset,2021,9,80,school', 'Library,2020,8,200,public', 'Library,2021,10,40,public', 'Depot,2021,12,,store'].join('\n'),
  true,
);
const vars = { params: { year: 2021, hour: 9 }, shared: {}, site: {} };
const run = (query: Omit<DataQuery, 'data'>) => runDataQuery(rows, { data: 'energy', ...query }, vars);

test('reduces a column to one number (#670)', () => {
  assert.equal(run({ sum: 'kwh' }), 440);
  assert.equal(run({ average: 'kwh' }), 110);
  assert.equal(run({ min: 'kwh' }), 40);
  assert.equal(run({ max: 'kwh' }), 200);
  assert.equal(run({ count: true }), 5);
  assert.equal(run({ count: 'kwh' }), 4);
  assert.equal(run({ latest: 'building' }), 'Depot');
});

test('filters with an expression that reads the row and the live values', () => {
  assert.equal(run({ sum: 'kwh', where: ['==', ['get', 'year'], ['bind', 'params.year']] }), 120);
  assert.equal(run({ count: true, where: ['==', ['get', 'use'], 'school'] }), 2);
  // Nothing left: a sum is 0, an average has no value.
  assert.equal(run({ sum: 'kwh', where: false }), 0);
  assert.equal(run({ average: 'kwh', where: false }), null);
});

test('groups into a list, biggest first unless told otherwise', () => {
  assert.deepEqual(run({ sum: 'kwh', group_by: 'building' }), [
    { label: 'Library', value: 240 },
    { label: 'Kårhuset', value: 200 },
    { label: 'Depot', value: 0 },
  ]);
  assert.deepEqual(run({ sum: 'kwh', group_by: 'year', order: 'name' }), [
    { label: '2020', value: 320 },
    { label: '2021', value: 120 },
  ]);
  assert.deepEqual((run({ max: 'kwh', group_by: 'use', order: 'lowest' }) as { label: string }[]).map((i) => i.label), ['school', 'public']);
});

test('follows the play head through a time column', () => {
  const at = ['bind', 'params.hour'] as const;
  assert.equal(run({ sum: 'kwh', time: 'hour', at }), 400);
  assert.equal(run({ latest: 'kwh', time: 'hour', at }), 80);
  assert.equal(runDataQuery(rows, { data: 'energy', sum: 'kwh', time: 'hour', at }, { params: { hour: 7 } }), 0);
  assert.deepEqual(run({ latest: 'kwh', group_by: 'building', time: 'hour', at }), [
    { label: 'Library', value: 200 },
    { label: 'Kårhuset', value: 80 },
  ]);
});

test('says what is wrong with a query, and a faulty one gives null', () => {
  const problems = (query: object) => dataQueryProblems({ data: 'energy', ...query } as DataQuery).problems;
  assert.deepEqual(problems({ sum: 'kwh' }), []);
  assert.match(problems({})[0]!, /exactly one of sum/);
  assert.match(problems({ sum: 'kwh', max: 'kwh' })[0]!, /not sum and max/);
  assert.match(problems({ count: 3 })[0]!, /count: true, or a column name/);
  assert.match(problems({ sum: 'kwh', time: 'hour' })[0]!, /time and at go together/);
  assert.match(problems({ sum: 'kwh', order: 'name' })[0]!, /only applies with group_by/);
  assert.match(problems({ sum: 'kwh', where: ['nope'] })[0]!, /where: .*not an operator/);
  assert.match(problems({ sum: 'kwh', filter: 1 })[0]!, /'filter' is not part of a data query/);
  assert.deepEqual(dataQueryProblems({ data: 'e', sum: 'kwh', where: ['==', ['bind', 'params.year'], 1] }).reads, ['params.year']);
  assert.equal(run({ sum: 'kwh', max: 'kwh' }), null);
  assert.equal(isDataQuery({ data: 'energy' }), true);
  assert.equal(isDataQuery({ bind: 'shared.x' }), false);
});

test('reads GeoJSON features as rows of their properties', () => {
  const geojson = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null, properties: { storeys: 4 } }, { type: 'Feature', geometry: null, properties: null }] });
  assert.deepEqual(rowsOf(geojson, false), [{ storeys: 4 }, {}]);
  assert.throws(() => rowsOf('{"type":"Feature"}', false), /not a CSV or a GeoJSON/);
});
