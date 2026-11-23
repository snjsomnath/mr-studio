import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MOTIONS_FOR, arrowMarks, motionFor, timeColumns, timeReveal, timeValue } from '../src/index.ts';

test('arrows sit at the end or spread evenly along a line, pointing the way it runs', () => {
  const line: [number, number][] = [[0, 0], [100, 0]];
  const end = arrowMarks(line, 'end', 10);
  assert.equal(end.length, 1);
  assert.deepEqual(end[0]!.at, [100, 0]);
  assert.equal(end[0]!.angle, 0);
  const along = arrowMarks(line, 'along', 25);
  assert.equal(along.length, 4);
  // Centred: the gaps at both ends match.
  assert.ok(Math.abs(along[0]!.at[0] - (100 - along[3]!.at[0])) < 1e-9);
  assert.equal(arrowMarks(line, 'none', 10).length, 0);
  // A line shorter than the gap still shows its direction once, in the middle.
  const short = arrowMarks([[0, 0], [0, 5]], 'along', 50);
  assert.equal(short.length, 1);
  assert.ok(Math.abs(short[0]!.angle - Math.PI / 2) < 1e-9);
});

test('time values read years, numbers and dates', () => {
  assert.equal(timeValue(1998), 1998);
  assert.equal(timeValue('2001'), 2001);
  assert.equal(timeValue('2024-05-01'), Date.parse('2024-05-01'));
  assert.ok(Number.isNaN(timeValue('soon')));
  assert.deepEqual(timeColumns([{ built: 1990, name: 'A', opened: '2020-01-01', population: 2152 }, { built: 2005, name: 'B', opened: '2021-06-01', population: 1500.5 }]), ['built', 'opened']);
  // Year-like numbers count; named columns come first.
  assert.deepEqual(timeColumns([{ count: 1200, year: 1999 }, { count: 1300, year: 2001 }]), ['year', 'count']);
});

test('a timeline reveals features as the sweep passes their time, and can let them go again', () => {
  const rows = [{ year: 2000 }, { year: 2010 }, { year: 2020 }, {}];
  const keep = timeReveal(rows, { column: 'year', duration_s: 10, hold_s: 2, keep: true })!;
  assert.equal(keep.at(rows[1], 2).alpha, 0, 'not yet');
  assert.equal(keep.at(rows[1], 6).alpha, 1, 'shown once its time has passed');
  assert.ok(keep.at(rows[1], 5.02).fresh > 0.5, 'a fresh arrival flares');
  assert.equal(keep.at(rows[0], 11).alpha, 1, 'holds at the end');
  assert.equal(keep.at(rows[2], 12.5).alpha, 0, 'starts over after the hold');
  assert.equal(keep.at(rows[3], 0).alpha, 1, 'features with no time are always shown');
  const window = timeReveal(rows, { column: 'year', duration_s: 10, keep: false, window: 0.1 })!;
  assert.equal(window.at(rows[0], 9).alpha, 0, 'gone after its window');
  assert.equal(timeReveal(rows, { column: null }), null);
});

test('every look can be played through time', () => {
  for (const kind of ['points', 'lines', 'fill'] as const) assert.ok(MOTIONS_FOR[kind].includes('timeline'));
  const motion = motionFor({ motion: [{ id: 't', block: 'timeline', on: 'look', props: { column: 'year' } }] }, 'look');
  assert.equal(motion.timeline?.column, 'year');
});
