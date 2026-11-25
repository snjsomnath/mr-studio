// One formatter (#397): decimal comma in Swedish, a point in English; typed numbers read either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, formatDistance, formatDecimal, formatUnit, parseNumber, setNumberLanguage } from '../src/format.ts';

test('English writes a point, Swedish a comma', () => {
  setNumberLanguage('en');
  assert.equal(formatUnit(5, 'm/s', 1), '5.0 m/s');
  setNumberLanguage('sv');
  assert.equal(formatUnit(5, 'm/s', 1), '5,0 m/s');
  assert.equal(formatDecimal(1234.5, 1).replace(/\s/g, ' '), '1 234,5');
  setNumberLanguage('en');
});

test('degrees and times sit tight; metres turn to kilometres', () => {
  setNumberLanguage('en');
  assert.equal(formatUnit(270, '°'), '270°');
  assert.equal(formatUnit(13.5, 'h', 0, { clock: true }), '13:30');
  assert.equal(formatClock(24), '24:00');
  assert.equal(formatDistance(850), '850 m');
  assert.equal(formatDistance(1200), '1.2 km');
});

test('a typed number reads with a point or a comma', () => {
  assert.equal(parseNumber('5,5'), 5.5);
  assert.equal(parseNumber('5.5'), 5.5);
  assert.equal(parseNumber('1 234,5'), 1234.5);
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('−3'), -3);
  assert.equal(parseNumber('abc'), null);
});
