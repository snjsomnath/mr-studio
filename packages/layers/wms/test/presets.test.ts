import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { PRESETS, resolve } from '../src/presets.ts';
import { request } from '../src/request.ts';

const manifest = JSON.parse(readFileSync(new URL('../layer.json', import.meta.url), 'utf8'));
const map = manifest.controls.find((c: { id: string }) => c.id === 'map');

test('every built-in map is offered, and every choice but custom is a built-in map', () => {
  const offered = map.options.map((o: { value: string }) => o.value).filter((v: string) => v !== 'custom');
  assert.deepEqual(offered.sort(), Object.keys(PRESETS).sort());
  assert.equal(map.default, 'custom');
});

test('built-in maps are open https services with their credit', () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    assert.match(preset.url, /^https:\/\/[^?]+$/, id);
    assert.ok(preset.layers.trim() && preset.source.trim(), id);
  }
});

test('a built-in map replaces the address, layers and sign-in, and keeps an own credit', () => {
  const hand = { url: 'https://a.org/wms', layers: 'roads', styles: '', source: '', signin: 'lm' };
  assert.deepEqual(resolve({ ...hand, map: 'custom' }), { url: 'https://a.org/wms', layers: 'roads', styles: '', source: '', signin: 'lm' });
  const photo = resolve({ ...hand, map: 'slu-ortofoto' });
  assert.equal(photo.url, 'https://hades.slu.se/lm/ortofoto/wms/v1.3');
  assert.equal(photo.layers, 'Ortofoto_0.5');
  assert.equal(photo.signin, undefined);
  assert.equal(photo.source, '© Lantmäteriet, via SLU');
  assert.equal(resolve({ ...hand, map: 'slu-ortofoto', source: 'Lantmäteriet 2024' }).source, 'Lantmäteriet 2024');
  const site = { corners: [[11.97, 57.705], [11.99, 57.704], [11.989, 57.696], [11.969, 57.697]] } as never;
  const query = new URL(request(site, photo).href, 'http://host').searchParams;
  assert.equal(query.get('format'), 'image/jpeg');
  assert.equal(query.get('source'), null);
});
