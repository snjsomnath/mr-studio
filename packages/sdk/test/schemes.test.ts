import assert from 'node:assert/strict';
import { test } from 'node:test';

import { categoryScheme, paintScale, pickScheme, resolvePalette, schemeColour, schemeFor, schemeOrder } from '../src/index.ts';

const rows = ['D', 'C', 'G', 'A', 'B', 'E', 'F', 'C', 'D', 'D'].map((energy_class) => ({ energy_class }));

test('energy classes are recognised in the ways datasets write them (#207)', () => {
  const epc = categoryScheme('epc')!;
  assert.equal(schemeFor(['A', 'b', 'Class C', 'energiklass D', ' e ']), epc);
  assert.equal(schemeFor(['A', 'B', 'office']), null);
  assert.equal(schemeFor([]), null);
  assert.equal(schemeFor(['A', 'G', 'Unknown', 'N/A', 'saknas']), epc);
  assert.equal(schemeFor(['C']), null);
  assert.equal(schemeColour(epc, 'a'), '#00a651');
  assert.equal(schemeColour(epc, 'G'), '#ed1c24');
  assert.equal(schemeColour(epc, 'H'), null);
  assert.deepEqual(schemeOrder(epc, ['D', 'x', 'A', 'G']), ['A', 'D', 'G', 'x']);
});

test('auto picks the scheme, palette turns it off, an id forces it', () => {
  assert.equal(pickScheme(undefined, ['A', 'G'])?.id, 'epc');
  assert.equal(pickScheme('auto', ['A', 'G'])?.id, 'epc');
  assert.equal(pickScheme('palette', ['A', 'G']), null);
  assert.equal(pickScheme('epc', ['A', 'other'])?.id, 'epc');
  assert.equal(pickScheme('nonsense', ['A', 'G']), null);
});

test('an energy class column paints green A to red G in order, and picked colours win', () => {
  const palette = resolvePalette();
  const scale = paintScale({ by: 'energy_class', kind: 'category' }, rows, palette);
  assert.deepEqual(scale.legend.map((l) => l.label), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.equal(scale.legend[0]!.color, '#00a651');
  assert.equal(scale.legend[6]!.color, '#ed1c24');
  assert.deepEqual(scale.colour({ energy_class: 'A' }), [0, 0xa6, 0x51, 1]);
  const plain = paintScale({ by: 'energy_class', kind: 'category', scheme: 'palette' }, rows, palette);
  assert.equal(plain.legend[0]!.label, 'D');
  assert.notEqual(plain.legend.find((l) => l.label === 'A')!.color, '#00a651');
  const picked = paintScale({ by: 'energy_class', kind: 'category', colors: { A: '#123456' } }, rows, palette);
  assert.equal(picked.legend[0]!.color, '#123456');
  assert.equal(picked.legend[1]!.color, '#50b848');
});
