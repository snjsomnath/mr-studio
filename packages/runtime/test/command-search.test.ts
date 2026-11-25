// Command search ranking (#464): the exact match first, and no padding from descriptions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, type Command } from '../src/editor/command-rank.ts';

const c = (id: string, label: string, group: string, also = ''): Command => ({ id, label, group, also, run: () => {} });
const list: Command[] = [
  c('add:video-walk', 'Add Video walk', 'Add a layer', 'new a walk through a street on video'),
  c('add:field-walk', 'Add Field walk', 'Add a layer', 'new spots people find on a walk with their phone'),
  c('set:fields', 'Data fields', 'Setting', 'columns'),
  c('add:mobility', 'Add Mobility', 'Add a layer', 'new how people walk and cycle in the field'),
  c('go:field-walk', 'Field walk', 'Go to', 'layer open edit field-walk'),
  c('help:field-walk', 'Field walk', 'Help', 'guide spots on a walk'),
  c('help:walks', 'Walks with the field team', 'Help', 'guide'),
];

test('the exact label comes first, then labels that hold the phrase', () => {
  const ids = rank(list, 'field walk').map((x) => x.id);
  assert.deepEqual(ids.slice(0, 2), ['go:field-walk', 'help:field-walk']);
  assert.equal(ids[2], 'add:field-walk');
});

test('a match only in the description is left out once the label matches', () => {
  const ids = rank(list, 'field walk').map((x) => x.id);
  assert.ok(!ids.includes('add:mobility'), ids.join());
  assert.ok(!ids.includes('add:video-walk'), ids.join());
});

test('a word in the description still finds a command when nothing else does', () => {
  assert.deepEqual(rank(list, 'columns').map((x) => x.id), ['set:fields']);
});

test('a prefix of the label ranks above words in any order', () => {
  const ids = rank(list, 'field').map((x) => x.id);
  assert.equal(ids[0], 'go:field-walk');
});
