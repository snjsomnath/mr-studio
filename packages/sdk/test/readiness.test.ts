import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readiness } from '../src/readiness.ts';
import type { ReadyTable } from '../src/readiness.ts';

const ready: ReadyTable = {
  data: ['buildings', 'roads'],
  size: true,
  timezone: 'Europe/Stockholm',
  calibrated: true,
  welcome: 'Touch a layer',
  layers: [
    { id: 'basemap', name: 'Base map', ambient: true },
    { id: 'sunlight', name: 'Sunlight', ambient: false, side: 'left' },
    { id: 'cars', name: 'Traffic', ambient: false, side: 'right', needs: ['roads'] },
  ],
};

test('a finished table has nothing to check', () => {
  assert.deepEqual(readiness(ready), []);
});

test('an empty table must get buildings and layers first', () => {
  const checks = readiness({ data: [], layers: [], size: false });
  assert.deepEqual(
    checks.filter((c) => c.level === 'must').map((c) => c.id),
    ['data:buildings', 'layers:none'],
  );
  assert.ok(checks.some((c) => c.id === 'rest:empty' && c.fix.kind === 'guide'));
});

test('a layer without its data is named, with the data to bring in', () => {
  const [check] = readiness({ ...ready, data: ['buildings'] });
  assert.equal(check!.id, 'data:cars:roads');
  assert.equal(check!.level, 'must');
  assert.match(check!.text, /^Traffic has no streets/);
  assert.deepEqual(check!.fix, { kind: 'data', dataset: 'roads' });
});

test('musts come before shoulds before nice-to-haves', () => {
  const checks = readiness({ data: [], layers: [], size: false, calibrated: false });
  const order = checks.map((c) => c.level);
  assert.deepEqual(order, [...order].sort((a, b) => ['must', 'should', 'nice'].indexOf(a) - ['must', 'should', 'nice'].indexOf(b)));
  assert.ok(checks.some((c) => c.id === 'projector'));
});

test('a one-sided controller and hidden buttons are found', () => {
  const layers = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, ambient: false, side: 'left' as const }));
  assert.ok(readiness({ ...ready, layers: [...ready.layers.slice(0, 1), ...layers] }).some((c) => c.id === 'controller:one-side'));
  const hidden = ready.layers.map((l) => ({ ...l, hidden: !l.ambient }));
  assert.ok(readiness({ ...ready, layers: hidden }).some((c) => c.id === 'layers:hidden'));
});

test('a name with an id in it, and a data layer with no words, are flagged for visitors (#586)', () => {
  const layers = [
    ...ready.layers,
    { id: 'showcase-today', name: 'Web map (WMS) (showcase-today)', ambient: false, side: 'right' as const },
    { id: 'epc', name: 'EPC classes', ambient: false, side: 'right' as const, noWords: true },
  ];
  const checks = readiness({ ...ready, layers });
  assert.equal(checks.find((c) => c.id === 'words:showcase-today:name')?.level, 'should');
  assert.deepEqual(checks.find((c) => c.id === 'words:epc:about')?.fix, { kind: 'layer', id: 'epc' });
  assert.ok(!checks.some((c) => c.id.startsWith('words:') && !['showcase-today', 'epc'].some((id) => c.id.includes(id))));
});
