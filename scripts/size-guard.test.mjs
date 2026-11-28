import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from './size-guard.mjs';

const none = () => false;
const all = () => true;

test('a new file over the limit fails, a small one passes', () => {
  const { errors } = judge({ code: [{ path: 'a.ts', before: 0, after: 1600 }, { path: 'b.ts', before: 0, after: 200 }], pictures: [], linked: all });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /a\.ts is a new file of 1600 lines/);
});

test('a file crossing the limit fails; one already over it only warns', () => {
  const { errors, warnings } = judge({
    code: [
      { path: 'cross.ts', before: 1400, after: 1501 },
      { path: 'big.css', before: 4244, after: 4637 },
      { path: 'shrinks.rs', before: 2000, after: 1900 },
    ],
    pictures: [],
    linked: all,
  });
  assert.deepEqual(errors.map((e) => e.split(' ')[0]), ['cross.ts']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /big\.css grows from 4244 to 4637/);
});

test('pictures: over 1 MB fails, over 5 MB in all fails, unlinked warns', () => {
  const mb = 1024 * 1024;
  const one = judge({ pictures: [{ path: 'docs/screenshots/1-big.png', bytes: 1.2 * mb }], code: [], linked: all });
  assert.match(one.errors[0], /1-big\.png is 1\.2 MB/);
  const many = judge({ pictures: Array.from({ length: 6 }, (_, i) => ({ path: `docs/screenshots/${i}.png`, bytes: 0.9 * mb })), code: [], linked: all });
  assert.match(many.errors.at(-1), /5\.4 MB of pictures/);
  const lone = judge({ pictures: [{ path: 'docs/screenshots/2-lone.png', bytes: 1000 }], code: [], linked: none });
  assert.equal(lone.errors.length, 0);
  assert.match(lone.warnings[0], /linked from nothing/);
});
