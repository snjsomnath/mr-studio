import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HTTP_REQUEST, Joiner, PIECE, parse, pieces, restream, splitHead, withHead } from '../src/link.ts';

test('a request survives being cut into data channel pieces', () => {
  const body = new Uint8Array(PIECE * 3 + 17).map((_, i) => i % 251);
  const bytes = withHead(HTTP_REQUEST, 7, { method: 'GET', path: '/phone?c=1234', headers: [] }, body);
  const cut = pieces(bytes);
  assert.equal(cut.length, 4);
  assert.ok(cut.every((p) => p.length <= PIECE + 1));
  const joiner = new Joiner();
  const back = cut.map((p) => joiner.push(p));
  assert.deepEqual(back.slice(0, 3), [null, null, null]);
  const parsed = parse(back[3]!)!;
  assert.equal(parsed.kind, HTTP_REQUEST);
  assert.equal(parsed.stream, 7);
  const split = splitHead<{ path: string }>(parsed.payload)!;
  assert.equal(split.head.path, '/phone?c=1234');
  assert.deepEqual(split.body, body);
});

test('an empty frame is one piece, and renumbering keeps the rest', () => {
  assert.equal(pieces(new Uint8Array(0)).length, 1);
  const bytes = withHead(HTTP_REQUEST, 1, { headers: [] });
  const moved = parse(restream(bytes, 0xfffffff0))!;
  assert.equal(moved.stream, 0xfffffff0);
  assert.deepEqual(moved.payload, parse(bytes)!.payload);
});

test('a frame over the limit is refused', () => {
  const joiner = new Joiner(10);
  assert.throws(() => joiner.push(new Uint8Array(20)));
});
