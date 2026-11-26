import assert from 'node:assert/strict';
import { test } from 'node:test';

import { passingShare, ruleDate, ruleOf, ruleWindow, verdictFrame } from '../src/rules.ts';

const frame = (data: Uint8Array | Float32Array, min: number, max: number) => ({ width: data.length, height: 1, min, max, data });

test('Boverket is the default rule and BRE can be picked', () => {
  assert.deepEqual(ruleOf('se'), { monthDay: '03-20', window: [9, 17], hours: 5, share: 50 });
  assert.equal(ruleOf('nope'), ruleOf('se'));
  assert.equal(ruleOf('bre').hours, 2);
  assert.equal(ruleOf('bre').window, null);
});

test("a rule's day is in the year being looked at", () => {
  assert.equal(ruleDate('se', '2031-06-21'), '2031-03-20');
  assert.equal(ruleDate('bre', '2026-12-21'), '2026-03-21');
});

test('Boverket counts the sun from 9 to 17 in the site time zone; BRE the whole day', () => {
  assert.deepEqual(ruleWindow({ timezone: 'Europe/Stockholm' }, 'se', '2026-03-20'), { from: '2026-03-20T08:00:00Z', until: '2026-03-20T16:00:00Z' });
  assert.deepEqual(ruleWindow({ timezone: 'Europe/Stockholm' }, 'bre', '2026-03-21'), { from: null, until: null });
});

test('the share of open ground with enough sun leaves buildings out', () => {
  const hours = new Float32Array([8, 6, 1, 0, 5]);
  assert.equal(passingShare(frame(hours, 0, 8), 5, null), 60);
  // The two sunny roofs are not ground: of the three open cells, one passes.
  assert.equal(Math.round(passingShare(frame(hours, 0, 8), 5, new Uint8Array([1, 1, 0, 0, 0]))!), 33);
  assert.equal(passingShare(frame(hours, 0, 8), 5, new Uint8Array([1, 1, 1, 1, 1])), null);
});

test('a quantised field passes a place right at the rule', () => {
  // 5 h of an 8 h day, quantised: 5/8*255 = 159.4, stored as 159.
  assert.equal(passingShare(frame(new Uint8Array([159, 158, 0]), 0, 8), 5, null)! > 33, true);
  assert.equal(passingShare(frame(new Uint8Array([150]), 0, 8), 5, null), 0);
});

test('the table shows buildings clear, then fail or pass', () => {
  const out = verdictFrame({ stream: 1, field: 0, width: 4, height: 1, revision: 1, min: 0, max: 8, progress: 1, data: new Float32Array([8, 8, 2, 5]) }, 5, new Uint8Array([1, 0, 0, 0]));
  assert.deepEqual([...out.data], [0, 1, 0.5, 1]);
  assert.equal(out.min, 0);
  assert.equal(out.max, 1);
});
