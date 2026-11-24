// The guide's "What a good file looks like" says what the editor's "?" says (#36), and every
// example file the editor offers is one the importer reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DATA_FORMATS } from '../src/data-formats.ts';

const guide = readFileSync(new URL('../../../docs/guide/03-your-data.md', import.meta.url), 'utf8');

test('the guide lists every data format in the editor’s words', () => {
  for (const format of DATA_FORMATS) {
    assert.ok(guide.includes(`### ${format.name} (${format.files})`), `docs/guide/03-your-data.md has no section for ${format.name}`);
    const words = format.example.split('\n\n')[0]!;
    assert.ok(guide.includes(words), `the guide's ${format.name} section says something else than the editor's "?"`);
  }
});

test('example files sit around the table and parse', () => {
  const origin = { lon: 11.97, lat: 57.7 };
  for (const format of DATA_FORMATS) {
    const sample = format.sample(origin);
    if (!sample) continue;
    if (sample.name.endsWith('.csv')) {
      const [head, ...rows] = sample.text.trim().split('\n');
      assert.equal(head, 'lat;lon;höjd');
      for (const row of rows) {
        const [lat, lon] = row.split(';').map((v) => Number(v.replace(',', '.')));
        assert.ok(Math.abs(lat! - origin.lat) < 0.01 && Math.abs(lon! - origin.lon) < 0.01, row);
      }
      continue;
    }
    const json = JSON.parse(sample.text);
    const points: number[][] = [];
    const walk = (v: unknown) => (Array.isArray(v) && typeof v[0] === 'number' ? points.push(v as number[]) : Array.isArray(v) ? v.forEach(walk) : v && typeof v === 'object' ? Object.values(v).forEach(walk) : null);
    walk(json);
    assert.ok(points.length > 0, sample.name);
    for (const [lon, lat] of points) assert.ok(Math.abs(lon! - origin.lon) < 0.01 && Math.abs(lat! - origin.lat) < 0.01, `${sample.name}: ${lon}, ${lat}`);
  }
});
