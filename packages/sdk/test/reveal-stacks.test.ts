import assert from 'node:assert/strict';
import { test } from 'node:test';

import { revealComplement, revealContains, revealPolygon, revealUniform } from '../src/reveal.ts';
import type { RevealShape } from '../src/reveal.ts';

test('the surface stack shows everywhere the glass does not (#606)', () => {
  const glass: RevealShape = { kind: 'circle', centre: [50, 30], radius_m: 10 };
  const around = revealComplement(glass)!;
  assert.deepEqual(around, { ...glass, outside: true });
  assert.equal(revealContains(glass, [52, 31]), true);
  assert.equal(revealContains(around, [52, 31]), false);
  assert.equal(revealContains(around, [5, 5]), true);
  assert.deepEqual(revealComplement(around), { ...glass, outside: false });
  assert.equal(revealUniform(around).kind, 4);
  // One outline with a hole: the far box, then the circle the other way round.
  const outline = revealPolygon(around, 100, 60, 8);
  assert.equal(outline.length, 6 + 1 + 7 + 1);
  assert.ok(outline[1]![0] > 100 && outline[1]![1] > 60);
});

test('the other stacks: a side turns round, nowhere and everywhere swap', () => {
  assert.deepEqual(revealComplement({ kind: 'side', axis: 'x', at_m: 4, keep: 'before' }), { kind: 'side', axis: 'x', at_m: 4, keep: 'after' });
  assert.deepEqual(revealComplement({ kind: 'none' }), null);
  assert.deepEqual(revealComplement(null), { kind: 'none' });
});
