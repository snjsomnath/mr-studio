import assert from 'node:assert/strict';
import { test } from 'node:test';

import { request } from '../src/request.ts';

const site = {
  // A table turned a little, around 57.7° N.
  corners: [
    [11.97, 57.705],
    [11.99, 57.704],
    [11.989, 57.696],
    [11.969, 57.697],
  ],
} as never;

test('the host is asked for the box around the table, with square metres', () => {
  const { href, bbox, width, height } = request(site, { url: ' https://maps.example.org/wms ', layers: 'roads', styles: '' });
  assert.deepEqual(bbox, [11.969, 57.696, 11.99, 57.705]);
  assert.equal(width, 2048);
  // 0.021° of longitude is about 1.25 km here, 0.009° of latitude about 1 km.
  assert.ok(height > 1500 && height < 1700, String(height));
  const query = new URL(href, 'http://host').searchParams;
  assert.equal(query.get('url'), 'https://maps.example.org/wms');
  assert.equal(query.get('bbox'), '11.969,57.696,11.99,57.705');
});
