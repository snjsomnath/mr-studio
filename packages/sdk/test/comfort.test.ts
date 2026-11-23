import assert from 'node:assert/strict';
import { test } from 'node:test';

import { airTemperatureAt, clearSky, pet, petColour, quantisePet, radiantTemperature, sunShadeComfort } from '../src/comfort.ts';

// Reference values from pythermalcomfort 4.8 `pet_steady(..., met=2.3, clo=0.9, position="standing")`,
// the call the Chalmers demo's CoolPaths study makes: [air, mrt, wind, humidity, pet].
const PET_CASES = [
  [25, 25, 0.1, 50, 28.36],
  [24, 55, 1.5, 50, 32.55],
  [24, 30, 1.5, 50, 24.15],
  [30, 60, 0.5, 40, 45.1],
  [15, 20, 3, 70, 12.27],
  [20, 45, 2, 60, 24.17],
  [10, 10, 1, 80, 7.55],
] as const;

test('PET matches pythermalcomfort', () => {
  for (const [airC, mrtC, windMs, humidity, expected] of PET_CASES) {
    const value = pet({ airC, mrtC, windMs, humidity });
    assert.ok(Math.abs(value - expected) < 0.02, `PET(${airC}, ${mrtC}, ${windMs}, ${humidity}) = ${value.toFixed(3)}, expected ${expected}`);
  }
});

test('clear-sky irradiance matches pvlib ineichen (Linke 3, sea level, 15 July)', () => {
  // pvlib 0.16 ineichen(zenith, kastenyoung1989 airmass, 3, altitude=0, dni_extra=spencer(day 196)).
  const cases = [
    [10, 104.108, 399.74, 34.694],
    [30, 454.866, 763.054, 73.339],
    [55, 815.316, 877.19, 96.763],
  ] as const;
  for (const [altitude, ghi, dni, dhi] of cases) {
    const sky = clearSky(altitude, { dayOfYear: 196 });
    assert.ok(Math.abs(sky.ghi - ghi) < 0.5, `ghi ${sky.ghi} at ${altitude}°`);
    assert.ok(Math.abs(sky.dni - dni) < 0.5, `dni ${sky.dni} at ${altitude}°`);
    assert.ok(Math.abs(sky.dhi - dhi) < 0.5, `dhi ${sky.dhi} at ${altitude}°`);
  }
  assert.deepEqual(clearSky(-3), { ghi: 0, dni: 0, dhi: 0 });
});

test('sun raises the radiant temperature well above the air; shade keeps it near', () => {
  const sky = clearSky(50, { dayOfYear: 196 });
  const direct = sky.dni * Math.sin((50 * Math.PI) / 180);
  const sun = radiantTemperature({ airC: 24, directWm2: direct, diffuseWm2: sky.dhi, svf: 0.85, sunAltitudeDeg: 50 });
  const shade = radiantTemperature({ airC: 24, directWm2: 0, diffuseWm2: sky.dhi, svf: 0.6, sunAltitudeDeg: 50 });
  assert.ok(sun > 45 && sun < 70, `sun MRT ${sun}`);
  assert.ok(shade > 20 && shade < 32, `shade MRT ${shade}`);
});

test('a summer afternoon is warmer in the sun than in the shade, and the same at night', () => {
  const day = sunShadeComfort({ airC: 24, humidity: 50, windMs: 1.5 }, 50, { dayOfYear: 196 });
  assert.ok(day.sun.pet - day.shade.pet > 5, `sun ${day.sun.pet}, shade ${day.shade.pet}`);
  const night = sunShadeComfort({ airC: 16, humidity: 70, windMs: 1.5 }, -10);
  assert.ok(Math.abs(night.sun.pet - night.shade.pet) < 2);
});

test('the air warms to the afternoon high and cools to a dawn low', () => {
  assert.equal(airTemperatureAt(15, 24), 24);
  assert.equal(airTemperatureAt(5, 24), 16);
  assert.ok(airTemperatureAt(10, 24) > 16 && airTemperatureAt(10, 24) < 24);
  assert.ok(Math.abs(airTemperatureAt(29, 24) - 16) < 1e-9);
});

test('PET colours and frames', () => {
  assert.equal(petColour(20), '#22d3ee');
  assert.equal(petColour(50), '#ef4444');
  assert.deepEqual([...quantisePet([Number.NaN, 0, 20, 44, 99])], [0, 1, 1, 255, 255]);
});
