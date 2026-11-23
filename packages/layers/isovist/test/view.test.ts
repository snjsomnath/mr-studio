import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compassWord } from '../src/hero.ts';
import { greenWord, mixWord, streetViewImageUrl, throughSource, viewParts } from '../src/view.ts';

test('the parts of a view keep the demo order and drop empty building types', () => {
  const parts = viewParts(90, 45, { Verksamhet: 10, Bostad: 35 }, 180);
  assert.deepEqual(parts.map((p) => p.label), ['Open sky', 'Trees', 'Homes', 'Business']);
  assert.equal(parts[1]!.share, 0.25);
  assert.equal(parts[1]!.colour, '#2D5A27');
});

test('green view is rated as in the demo', () => {
  assert.equal(greenWord(0.31), 'Good');
  assert.equal(greenWord(0.2), 'Fair');
  assert.equal(greenWord(0.05), 'Poor');
});

test('the soundscape is put in words', () => {
  assert.equal(mixWord(null), 'Soundscape off');
  assert.equal(mixWord({ nature: 0.45, city: 0.05 }), 'Mostly birdsong');
  assert.equal(mixWord({ nature: 0, city: 0.5 }), 'Traffic');
});

test('Street View is asked through the host, which adds the key', () => {
  const url = streetViewImageUrl([11.97776, 57.68838], 92.4);
  assert.match(url, /^https:\/\/maps\.googleapis\.com\/maps\/api\/streetview\?size=640x400&location=57\.688380,11\.977760&heading=92/);
  assert.ok(!url.includes('key='));
  assert.equal(throughSource('streetview', 'https://x.org/a?b=1'), '/api/sources/streetview/proxy?url=https%3A%2F%2Fx.org%2Fa%3Fb%3D1');
});

test('headings read as compass words', () => {
  assert.equal(compassWord(0), 'north');
  assert.equal(compassWord(100), 'east');
  assert.equal(compassWord(350), 'north');
});
