import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fitSize, isVideo, parseBounds, quarterTurn } from '../src/fit.ts';

test('a stretched picture takes the table, its sides swapped when turned a quarter', () => {
  assert.deepEqual(fitSize(400, 300, 1250, 750, 'stretch', 0), [1250, 750]);
  assert.deepEqual(fitSize(400, 300, 1250, 750, 'stretch', 90), [750, 1250]);
});

test('contain keeps the whole picture, cover fills the table', () => {
  assert.deepEqual(fitSize(1000, 1000, 1250, 750, 'contain', 0), [750, 750]);
  assert.deepEqual(fitSize(1000, 1000, 1250, 750, 'cover', 0), [1250, 1250]);
  // Turned, a tall picture fits the long side of the table.
  assert.deepEqual(fitSize(750, 1250, 1250, 750, 'contain', 270), [750, 1250]);
});

test('turns are quarter turns, and video is known by its file type', () => {
  assert.equal(quarterTurn('90'), 90);
  assert.equal(quarterTurn(-90), 270);
  assert.equal(quarterTurn('nonsense'), 0);
  assert.ok(isVideo('data/media/sunstudy.mp4'));
  assert.ok(isVideo('clip.WEBM?v=2'));
  assert.ok(!isVideo('data/media/satellite.png'));
});

test('a picture is placed by its edges typed as a bbox or read from its side file (#52)', () => {
  const box = { west: 11.96, south: 57.69, east: 11.98, north: 57.7 };
  assert.deepEqual(parseBounds('11.96, 57.69, 11.98, 57.70'), box);
  assert.deepEqual(parseBounds('{"image":"overlay.png","bounds":{"west":11.96,"south":57.69,"east":11.98,"north":57.7}}'), box);
  assert.equal(parseBounds(''), null);
  assert.equal(parseBounds('11.98, 57.69, 11.96, 57.70'), null, 'west must be west of east');
  assert.equal(parseBounds('1, 2, 3'), null);
});
