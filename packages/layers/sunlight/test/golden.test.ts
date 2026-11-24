import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GOLDEN_BOTTOM, GOLDEN_TOP, goldenColormap, goldenWindows, sunAt, sunDay } from '../src/look.ts';

const gothenburg = { origin: { lat: 57.69, lon: 11.97 }, timezone: 'Europe/Stockholm' } as never;

test('midsummer in Gothenburg has a golden hour at each end of the day, around sunrise and sunset', () => {
  const day = sunDay(gothenburg, '2026-06-21');
  const { morning, evening } = goldenWindows(day);
  assert.ok(morning && evening);
  assert.ok(morning.from < day.sunrise! && day.sunrise! < morning.to);
  assert.ok(evening.from < day.sunset! && day.sunset! < evening.to);
  // The edges are where the sun is 6° up and 4° down.
  assert.ok(Math.abs(sunAt(gothenburg, '2026-06-21', evening.from).altitude - GOLDEN_TOP) < 0.2);
  assert.ok(Math.abs(sunAt(gothenburg, '2026-06-21', evening.to).altitude - GOLDEN_BOTTOM) < 0.2);
  // A long northern summer dusk: more than an hour.
  assert.ok(evening.to - evening.from > 1);
});

test('in midwinter, when the sun barely clears 6°, the golden hours are still found', () => {
  const { morning, evening } = goldenWindows(sunDay(gothenburg, '2026-12-21'));
  assert.ok(morning && evening);
  assert.ok(morning.to <= evening.from);
});

test('the grade warms towards sunset and cools into the blue hour', () => {
  const light = (alt: number) => goldenColormap(alt).stops.at(-1)!;
  // Redder at the horizon than at 6°: less green.
  assert.ok(light(0)[2] < light(6)[2]);
  // Under the horizon blue takes over.
  assert.ok(light(-4)[3] > light(-4)[1]);
});
