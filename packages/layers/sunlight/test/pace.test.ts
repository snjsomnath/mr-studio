import assert from 'node:assert/strict';
import { test } from 'node:test';

import { playPace, sharpSoften } from '../src/pace.ts';

test('the day plays at full speed with the sun well up or well down, and lingers at the horizon', () => {
  assert.equal(playPace(40), 1);
  assert.equal(playPace(-3), 1);
  assert.equal(playPace(0), 0.35);
  assert.ok(playPace(5) < playPace(10) && playPace(10) < 1);
  // No jump as the sun crosses the horizon.
  assert.ok(Math.abs(playPace(0.01) - playPace(-0.01)) < 0.01);
});

test('shadows soften as the sun gets low, within a limit', () => {
  assert.ok(sharpSoften(60) < 1.5);
  assert.ok(sharpSoften(5) > sharpSoften(20));
  assert.equal(sharpSoften(0.5), 5);
});

test('a winter day in Gothenburg plays in about ten seconds, a summer day lingers longer (#661)', async () => {
  const { playSeconds } = await import('../src/pace.ts');
  const { sunDay } = await import('../src/look.ts');
  const site = { origin: { lon: 11.97, lat: 57.69 }, timezone: 'Europe/Stockholm' } as Parameters<typeof sunDay>[0];
  const winter = sunDay(site, '2026-12-21');
  const summer = sunDay(site, '2026-06-21');
  const winterS = playSeconds(winter.samples, winter.peak.altitude);
  const summerS = playSeconds(summer.samples, summer.peak.altitude);
  assert.ok(winterS > 6 && winterS < 15, `winter ${winterS.toFixed(1)} s`);
  assert.ok(summerS > winterS && summerS < 30, `summer ${summerS.toFixed(1)} s`);
  // Twice the speed, half the time.
  assert.ok(Math.abs(playSeconds(winter.samples, winter.peak.altitude, 2) - winterS / 2) < 0.01);
});

test('the night hurries by once the sun is well down', () => {
  assert.equal(playPace(-30), 6);
  assert.ok(playPace(-6) > 1 && playPace(-6) < 6);
  // A low winter sun reaches full speed lower than 15°.
  assert.equal(playPace(5, 9), 1);
  assert.ok(playPace(5, 50) < 1);
});
