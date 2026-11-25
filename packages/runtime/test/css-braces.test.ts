// Every stylesheet closes what it opens: an unclosed @media once hid every rule after it. A merge of two additions to editor.css left one open (#451).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const src = new URL('../src/', import.meta.url).pathname;
const sheets = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sheets(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));

test('every stylesheet closes its braces', () => {
  for (const file of sheets(src)) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '');
    let depth = 0;
    text.split('\n').forEach((line, i) => {
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      assert.ok(depth >= 0, `${file}:${i + 1} closes a brace it never opened`);
    });
    assert.equal(depth, 0, `${file} leaves ${depth} brace(s) open`);
  }
});
