import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PALETTE, categories, strength } from '../src/categories.ts';

const feature = (kind: unknown) => ({ properties: { kind } });

test('categories are the values of the property, in order of first appearance', () => {
  assert.deepEqual(categories([feature('street'), feature('park'), feature('street'), feature(null)], 'kind'), ['street', 'park']);
  assert.deepEqual(categories([feature('street')], ''), [], 'no property, no categories');
});

test('too many categories to tell apart are drawn as one', () => {
  const many = Array.from({ length: PALETTE.length + 1 }, (_, n) => feature(`k${n}`));
  assert.deepEqual(categories(many, 'kind'), []);
});

test('Next reveals categories one at a time, with the rest faint as context', () => {
  // 0 revealed is the overview, and so is all of them.
  assert.equal(strength(2, 0, 3), 1);
  assert.equal(strength(2, 3, 3), 1);
  assert.equal(strength(0, 1, 3), 1);
  assert.ok(strength(1, 1, 3) < 0.5);
  assert.equal(strength(1, 2, 3), 1);
});
