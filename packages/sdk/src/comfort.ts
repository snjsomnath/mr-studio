// Outdoor thermal comfort: clear-sky sunlight, mean radiant temperature and PET (#196).
//
// A building block for any layer that turns sun and shade into how hot it feels on foot.
// The numbers follow the Chalmers demo's CoolPaths study (interactive_map `coolpaths/thermal.py`
// and `coolpaths/prepare.py`), so a site without prepared PET rasters gets the same kind of
// estimate live, from the sunlight kernel's shadow and a few weather values.
//
// - `clearSky`: Ineichen-Perez clear-sky irradiance (as pvlib's `ineichen`, Kasten-Young air mass).
// - `radiantTemperature`: a standing walker's mean radiant temperature (the demo's body-aware MRT).
// - `pet`: Physiological Equivalent Temperature from the MEMI model, after Walther and Goestchel
//   (2018), ported from pythermalcomfort's `pet_steady` (which the demo calls).

import type { Colormap } from './colormap.ts';

const SIGMA = 5.67e-8;
const RAD = Math.PI / 180;

export interface Irradiance {
  /** Global horizontal, W/m². */
  ghi: number;
  /** Direct normal, W/m². */
  dni: number;
  /** Diffuse horizontal, W/m². */
  dhi: number;
}

/**
 * Clear-sky irradiance for a sun `altitudeDeg` above the horizon.
 * `linke` is the Linke turbidity (about 3 for a clear European summer sky); `elevationM` the ground's height.
 */
export function clearSky(altitudeDeg: number, options: { linke?: number; elevationM?: number; dayOfYear?: number } = {}): Irradiance {
  if (!(altitudeDeg > 0)) return { ghi: 0, dni: 0, dhi: 0 };
  const tl = options.linke ?? 3;
  const h = options.elevationM ?? 0;
  const day = options.dayOfYear ?? 172;
  const zenith = 90 - altitudeDeg;
  const cosZ = Math.cos(zenith * RAD);
  // Kasten and Young (1989), then corrected for pressure at the ground's height.
  const relative = 1 / (cosZ + 0.50572 * (96.07995 - zenith) ** -1.6364);
  const pressure = 101325 * (1 - 2.25577e-5 * h) ** 5.25588;
  const am = (relative * pressure) / 101325;
  // Spencer (1971) extraterrestrial radiation.
  const b = (2 * Math.PI * (day - 1)) / 365;
  const extra = 1366.1 * (1.00011 + 0.034221 * Math.cos(b) + 0.00128 * Math.sin(b) + 0.000719 * Math.cos(2 * b) + 0.000077 * Math.sin(2 * b));
  const fh1 = Math.exp(-h / 8000);
  const fh2 = Math.exp(-h / 1250);
  const cg1 = 5.09e-5 * h + 0.868;
  const cg2 = 3.92e-5 * h + 0.0387;
  const ghi = cg1 * extra * cosZ * Math.max(0, Math.exp(-cg2 * am * (fh1 + fh2 * (tl - 1))));
  const bnci = extra * Math.max(0, (0.664 + 0.163 / fh1) * Math.exp(-0.09 * am * (tl - 1)));
  const bnci2 = ghi * Math.min(Math.max((1 - (0.1 - 0.2 * Math.exp(-tl)) / (0.1 + 0.882 / fh1)) / cosZ, 0), 1e20);
  const dni = Math.min(bnci, bnci2);
  return { ghi, dni, dhi: ghi - dni * cosZ };
}

export interface RadiantInput {
  /** Air temperature, °C. Surfaces are taken to be at air temperature. */
  airC: number;
  /** Direct sun on a horizontal surface, W/m² (0 in shade). */
  directWm2: number;
  /** Diffuse sky radiation on a horizontal surface, W/m². */
  diffuseWm2: number;
  /** Share of the sky the walker sees, 0..1. */
  svf: number;
  /** Ground reflectivity, 0..1. Default 0.15 (asphalt, paving). */
  albedo?: number;
  /** 1 under a tree crown, 0 in the open. Default 0. */
  canopy?: number;
  sunAltitudeDeg: number;
}

/**
 * A standing walker's mean radiant temperature, °C (the demo's `radiant_temperature`).
 * The body's projected direct-beam area is 0.28 of its surface (SOLWEIG); sky and ground each fill half the view;
 * shortwave absorption 0.70 and longwave emissivity 0.97 (ISO 7726).
 */
export function radiantTemperature(input: RadiantInput): number {
  const albedo = input.albedo ?? 0.15;
  const svf = input.svf * (1 - 0.5 * (input.canopy ?? 0));
  const sinAltitude = Math.max(Math.sin(input.sunAltitudeDeg * RAD), 0.05);
  const direct = (input.directWm2 / sinAltitude) * 0.28;
  const sky = 0.5 * svf * input.diffuseWm2;
  const ground = 0.5 * albedo * (input.directWm2 + input.diffuseWm2);
  const shortwave = (direct + sky + ground) * (0.7 / 0.97);
  const longwave = (svf * 0.9 + (1 - svf) * 0.95) * SIGMA * (input.airC + 273.15) ** 4;
  return (Math.max(shortwave + longwave, 1) / SIGMA) ** 0.25 - 273.15;
}

/** Saturation vapour pressure over water or ice, Pa (ASHRAE, as pythermalcomfort's `p_sat`). */
function pSat(t: number): number {
  const k = t + 273.15;
  const ln = Math.log(k);
  return k < 273.15
    ? Math.exp(-5674.5359 / k + 6.3925247 + k * (-0.9677843e-2 + k * (0.62215701e-6 + k * (0.20747825e-8 + -0.9484024e-12 * k))) + 4.1635019 * ln)
    : Math.exp(-5800.2206 / k + 1.3914993 + k * (-0.048640239 + k * (0.41764768e-4 + k * -0.14452093e-7)) + 6.5459673 * ln);
}

export interface PetInput {
  airC: number;
  mrtC: number;
  /** Wind at about 1.1 m, m/s. */
  windMs: number;
  /** Relative humidity, %. */
  humidity: number;
  /** Activity, met. Default 2.3 (walking, as in the demo). */
  met?: number;
  /** Clothing, clo. Default 0.9 (as in the demo). */
  clo?: number;
  position?: 'standing' | 'sitting';
}

// The reference person of pythermalcomfort: 23 years old, male, 75 kg, 1.80 m.
const AGE = 23;
const WEIGHT = 75;
const HEIGHT = 1.8;
const A_DUBOIS = 0.202 * WEIGHT ** 0.425 * HEIGHT ** 0.725;
const MET_CORRECTION = 3.45 * WEIGHT ** 0.75 * (1 + 0.004 * (30 - AGE) + 0.01 * ((HEIGHT * 100) / WEIGHT ** (1 / 3) - 43.4));

function vasomotricity(tCore: number, tSkin: number): { blood: number; alpha: number } {
  const skin = Math.max(0, 34 - tSkin);
  const core = Math.max(0, tCore - 36.6);
  const blood = Math.min(90, (6.3 + 75 * core) / (1 + 0.5 * skin));
  return { blood, alpha: 0.0417737 + 0.7451833 / (blood + 0.585417) };
}

interface Environment {
  air: number;
  mrt: number;
  wind: number;
  humidity: number;
  /** W/m². */
  met: number;
  clo: number;
  standing: boolean;
  /** False for PET's reference room, where the vapour pressure is 12 hPa. */
  actual: boolean;
}

/** The MEMI heat balances: the three node balances, and the whole body's. */
function balance([tCore, tSkin, tClo]: readonly [number, number, number], env: Environment): { nodes: [number, number, number]; total: number } {
  const hVap = 2.42e6;
  const cb = 3640;
  const pAtm = 1013.25;
  const he = (env.met + MET_CORRECTION) / A_DUBOIS;
  const h = he;
  const im = 0.38;
  const fcl = 1 + 0.31 * env.clo;
  let faCl = (173.51 * env.clo - 2.36 - 100.76 * env.clo * env.clo + 19.28 * env.clo ** 3) / 100;
  const aClo = A_DUBOIS * faCl + A_DUBOIS * (fcl - 1);
  const fEff = env.standing ? 0.696 : 0.725;
  const aREff = A_DUBOIS * fEff;
  const vpa = env.actual ? ((env.humidity / 100) * pSat(env.air)) / 100 : 12;
  let hc = env.standing ? 2.26 + 7.42 * env.wind ** 0.67 : 2.67 + 6.5 * env.wind ** 0.67;
  hc = Math.max(3 * (pAtm / 1013.25) ** 0.53, hc) * (pAtm / 1013.25) ** 0.55;

  const tExp = 0.47 * env.air + 21;
  const vent = he * 1.44e-6;
  const cRes = 1010 * (env.air - tExp) * vent;
  const qRes = ((0.623 * hVap) / pAtm) * (vpa - pSat(tExp) / 100) * vent;
  const ere = cRes + qRes;

  const { blood, alpha } = vasomotricity(tCore, tSkin);
  const tBody = alpha * tSkin + (1 - alpha) * tCore;

  const rCl = env.clo / 6.45;
  faCl = Math.min(faCl, 1);
  let y = 0;
  if (env.clo >= 2) y = 1;
  if (env.clo > 0.6 && env.clo < 2) y = (HEIGHT - 0.2) / HEIGHT;
  if (env.clo <= 0.6 && env.clo > 0.3) y = 0.5;
  if (env.clo <= 0.3 && env.clo > 0) y = 0.1;
  const r2 = (A_DUBOIS * (fcl - 1 + faCl)) / (6.28 * HEIGHT * y);
  const r1 = (faCl * A_DUBOIS) / (6.28 * HEIGHT * y);
  const htcl = (6.28 * HEIGHT * y * (r2 - r1)) / (rCl * Math.log(r2 / r1) * aClo);

  const sigBody = Math.max(0, tBody - (0.1 * 34 + 0.9 * 36.6));
  let esw = ((hVap / 1000) * Math.min(304.94 * sigBody, 500)) / 3600;
  const pvSkin = pSat(tSkin) / 100;
  const lr = 1.67;
  const fecl = 1 / (1 + 0.92 * hc * rCl);
  let eMax = hc * lr * fecl * (pvSkin - vpa);
  if (eMax === 0) eMax = 0.001;
  let w = esw / eMax;
  if (w > 1) {
    w = 1;
    if (esw - eMax < 0) esw = eMax;
  }
  esw = Math.max(esw, 0);
  const rEcl = (1 / (fcl * hc) + rCl) / (lr * im);
  const evap = -((1 - w) * (pvSkin - vpa) / rEcl + esw);

  const k4 = (t: number) => (t + 273.15) ** 4;
  const rBare = (aREff * (1 - faCl) * 0.99 * SIGMA * (k4(env.mrt) - k4(tSkin))) / A_DUBOIS;
  const rClo = (fEff * aClo * 0.95 * SIGMA * (k4(env.mrt) - k4(tClo))) / A_DUBOIS;
  const cBare = (hc * (env.air - tSkin) * A_DUBOIS * (1 - faCl)) / A_DUBOIS;
  const cClo = (hc * (env.air - tClo) * aClo) / A_DUBOIS;

  const flow = ((blood / 3600) * cb + 5.28) * (tCore - tSkin);
  return {
    nodes: [h + ere - flow, rBare + cBare + evap + flow - htcl * (tSkin - tClo), cClo + rClo + htcl * (tSkin - tClo)],
    total: h + ere + rBare + rClo + cBare + cClo + evap,
  };
}

/** Solves the three node balances for core, skin and clothing temperature (Newton with a numerical Jacobian). */
function bodyTemperatures(env: Environment): [number, number, number] {
  let t: [number, number, number] = [36.7, 34, 0.5 * (env.air + env.mrt)];
  for (let iteration = 0; iteration < 100; iteration++) {
    const f = balance(t, env).nodes;
    if (Math.max(...f.map(Math.abs)) < 1e-9) break;
    const jacobian = [0, 1, 2].map((j) => {
      const step = 1e-6 * Math.max(1, Math.abs(t[j]!));
      const moved: [number, number, number] = [...t];
      moved[j]! += step;
      const g = balance(moved, env).nodes;
      return g.map((v, i) => (v - f[i]!) / step);
    });
    // jacobian[j][i] = d f_i / d t_j; solve J dx = -f by Cramer's rule.
    const m = [0, 1, 2].map((i) => [0, 1, 2].map((j) => jacobian[j]![i]!));
    const det = (a: number[][]) =>
      a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) - a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) + a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);
    const d = det(m);
    if (!Number.isFinite(d) || Math.abs(d) < 1e-14) break;
    const dx = [0, 1, 2].map((k) => det(m.map((row, i) => row.map((v, j) => (j === k ? -f[i]! : v)))) / d);
    // A damped step keeps the first iterations from leaping out of the body's range.
    const largest = Math.max(...dx.map(Math.abs));
    const scale = largest > 5 ? 5 / largest : 1;
    t = [t[0] + dx[0]! * scale, t[1] + dx[1]! * scale, t[2] + dx[2]! * scale];
    if (largest * scale < 1e-10) break;
  }
  return t;
}

/**
 * Physiological Equivalent Temperature, °C: the air temperature of a standard room (still air, 12 hPa vapour,
 * walls at air temperature) in which the body would be in the same thermal state as outdoors.
 */
export function pet(input: PetInput): number {
  const env: Environment = {
    air: input.airC,
    mrt: input.mrtC,
    wind: Math.max(0, input.windMs),
    humidity: input.humidity,
    met: (input.met ?? 2.3) * 58.2,
    clo: input.clo ?? 0.9,
    standing: (input.position ?? 'standing') === 'standing',
    actual: true,
  };
  const body = bodyTemperatures(env);
  // The reference room: the given body temperatures, 0.1 m/s, 80 W/m² and 0.9 clo, with air = walls = PET.
  const room = (x: number) => balance(body, { air: x, mrt: x, wind: 0.1, humidity: 50, met: 80, clo: 0.9, standing: env.standing, actual: false }).total;
  // The balance rises with the room's temperature: bracket and bisect, then polish with a secant step.
  let lo = -60;
  let hi = 90;
  let flo = room(lo);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const fm = room(mid);
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
    if (hi - lo < 1e-7) break;
  }
  return (lo + hi) / 2;
}

/** Where the weather and the sun give a walker in full sun and in full shade. */
export interface SunShadeComfort {
  sun: { mrt: number; pet: number };
  shade: { mrt: number; pet: number };
  irradiance: Irradiance;
}

export interface ComfortWeather {
  airC: number;
  humidity: number;
  windMs: number;
}

/**
 * PET in full sun and in full shade for one moment. Between the two, a place's PET is close to a mix by its share
 * of sun, which is how a walk's PET is estimated live from the shadow field.
 * Sky view is assumed: 0.85 in the open (streets between low buildings) and 0.6 in shade, which on a street is
 * usually cast by something close.
 */
export function sunShadeComfort(weather: ComfortWeather, sunAltitudeDeg: number, options: { dayOfYear?: number; linke?: number; elevationM?: number } = {}): SunShadeComfort {
  const irradiance = clearSky(sunAltitudeDeg, options);
  const altitude = Math.max(sunAltitudeDeg, 0);
  const common = { airC: weather.airC, diffuseWm2: irradiance.dhi, sunAltitudeDeg: altitude };
  const directWm2 = irradiance.dni * Math.sin(altitude * RAD);
  const sunMrt = radiantTemperature({ ...common, directWm2, svf: 0.85 });
  const shadeMrt = radiantTemperature({ ...common, directWm2: 0, svf: 0.6 });
  const at = (mrtC: number) => pet({ airC: weather.airC, mrtC, windMs: weather.windMs, humidity: weather.humidity });
  return { sun: { mrt: sunMrt, pet: at(sunMrt) }, shade: { mrt: shadeMrt, pet: at(shadeMrt) }, irradiance };
}

/**
 * Air temperature through a clear summer day, from the afternoon high: lowest near 05:00, highest near 15:00.
 * `rangeC` is the swing between them (8 °C is typical on a clear day by the sea).
 */
export function airTemperatureAt(hour: number, highC: number, rangeC = 8): number {
  const h = (((hour - 5) % 24) + 24) % 24; // hours since the 05:00 low
  // Ten hours of warming to the high, then fourteen of cooling back, each half a cosine.
  const warmth = h <= 10 ? (1 - Math.cos((Math.PI * h) / 10)) / 2 : (1 + Math.cos((Math.PI * (h - 10)) / 14)) / 2;
  return highC - rangeC * (1 - warmth);
}

/** The PET range the demo colours over, °C. */
export const PET_RANGE: readonly [number, number] = [20, 44];

/** The demo's PET colours (cool cyan to hot red), as stops in °C. */
export const PET_STOPS: readonly (readonly [number, string])[] = [
  [20, '#22d3ee'],
  [24, '#10b981'],
  [30, '#facc15'],
  [36, '#fb923c'],
  [44, '#ef4444'],
];

const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** The colour of a PET value, as `#rrggbb`. */
export function petColour(value: number): string {
  const stops = PET_STOPS;
  const v = Math.min(stops[stops.length - 1]![0], Math.max(stops[0]![0], value));
  let k = 0;
  while (k < stops.length - 2 && v > stops[k + 1]![0]) k++;
  const [a, b] = [stops[k]!, stops[k + 1]!];
  const t = (v - a[0]) / (b[0] - a[0]);
  const [ca, cb] = [hexRgb(a[1]), hexRgb(b[1])];
  return `#${ca.map((c, i) => Math.round(c + (cb[i]! - c) * t).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A colormap for PET frames quantised by `petFrame`: 0 is "no data" and stays clear, 1..255 run over `PET_RANGE`.
 * `alpha` is the wash's strength (0..255).
 */
export function petColormap(alpha = 150): Colormap {
  const [lo, hi] = PET_RANGE;
  const first = 1 / 255;
  const stops: Colormap['stops'] = [[0, ...hexRgb(PET_STOPS[0]![1]), 0] as [number, number, number, number, number]];
  for (const [value, colour] of PET_STOPS) stops.push([first + ((value - lo) / (hi - lo)) * (1 - first), ...hexRgb(colour), alpha]);
  return { stops };
}

/** Quantises PET values (NaN where there is no data) into a byte per cell for `petColormap`. */
export function quantisePet(values: ArrayLike<number>, out: Uint8Array = new Uint8Array(values.length)): Uint8Array {
  const [lo, hi] = PET_RANGE;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    out[i] = Number.isFinite(v) ? 1 + Math.round(Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * 254) : 0;
  }
  return out;
}

/** How a PET value feels, on the scale for Central Europe (Matzarakis and Mayer, 1996). */
export function petFeeling(value: number): string {
  if (value < 4) return 'very cold';
  if (value < 8) return 'cold';
  if (value < 13) return 'cool';
  if (value < 18) return 'slightly cool';
  if (value < 23) return 'comfortable';
  if (value < 29) return 'slightly warm';
  if (value < 35) return 'warm';
  if (value < 41) return 'hot';
  return 'very hot';
}
