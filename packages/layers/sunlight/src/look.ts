// How the sun study looks: the colour of light and shade for a sun height,
// and the sun's path over a day. Pure functions, shared by the table and the TV panel.
import { sunPosition, zonedTimeToUtc } from '@mrstudio/sdk';
import type { Colormap, SiteInfo } from '@mrstudio/sdk';

type Rgb = [number, number, number];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const NIGHT: Rgb = [9, 12, 30];
const NOON_LIGHT: Rgb = [255, 244, 222];
const LOW_LIGHT: Rgb = [255, 146, 62];
const NOON_SHADE: Rgb = [20, 30, 74];
const LOW_SHADE: Rgb = [52, 26, 78];

/**
 * Light and shade for a sun `altitude` in degrees. High sun gives pale light and blue shade;
 * a low sun turns the light amber and the shade violet; below the horizon everything settles into night.
 */
export function skyColormap(altitude: number): Colormap {
  const day = clamp01((altitude + 5) / 9);
  const low = clamp01(1 - altitude / 38) ** 1.6;
  const strength = 0.6 + 0.4 * Math.sqrt(clamp01(Math.sin((Math.max(0, altitude) * Math.PI) / 180)));
  const light = mix(NIGHT, mix(NOON_LIGHT, LOW_LIGHT, low).map((c) => c * strength) as Rgb, day);
  const shade = mix(NIGHT, mix(NOON_SHADE, LOW_SHADE, low), day);
  // The half-lit edge leans warm, like light bouncing into a shadow's rim.
  const edge = mix(mix(shade, light, 0.42), LOW_LIGHT, 0.12 * day);
  const stop = (p: number, c: Rgb, a: number): Colormap['stops'][number] => [p, Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), a];
  return { stops: [stop(0, shade, 236), stop(0.5, edge, 236), stop(1, light, 236)] };
}

/**
 * The same light as `skyColormap`, as a sun and a sky for lighting the 3D model: the sun's own
 * colour, and the colour the sky leaves in the shade.
 */
export function skyLight(altitude: number): { sun: string; sky: string; intensity: number } {
  const day = clamp01((altitude + 5) / 9);
  const low = clamp01(1 - altitude / 38) ** 1.6;
  const css = (c: Rgb) => `rgb(${c.map((v) => Math.round(v)).join(' ')})`;
  // A low sun rakes across the ground, so it is given more strength to keep the model readable.
  return { sun: css(mix(NOON_LIGHT, LOW_LIGHT, low)), sky: css(mix(NIGHT, mix(NOON_SHADE, LOW_SHADE, low), day)), intensity: day * (1 + 0.6 * low) };
}

/** Hours of direct sun: cool where there is little, warm where there is a lot. */
export const sunHoursColormap: Colormap = {
  stops: [
    [0, 10, 14, 44, 236],
    [0.18, 34, 44, 122, 236],
    [0.4, 104, 62, 160, 236],
    [0.6, 214, 86, 108, 236],
    [0.8, 250, 158, 64, 236],
    [1, 255, 240, 186, 236],
  ],
};

export interface SunSample {
  /** Wall-clock hour in the site's time zone, 0..24. */
  hour: number;
  azimuth: number;
  altitude: number;
}

export interface SunDay {
  samples: SunSample[];
  /** Wall-clock hours, or null when the sun does not rise or set that day. */
  sunrise: number | null;
  sunset: number | null;
  /** The highest sample of the day. */
  peak: SunSample;
}

const SAMPLE_MINUTES = 10;

export function sunAt(site: SiteInfo, date: string, hour: number): SunSample {
  const p = sunPosition(Date.parse(zonedTimeToUtc(date, hour, site.timezone)), site.origin.lat, site.origin.lon);
  return { hour, azimuth: p.azimuth, altitude: p.altitude };
}

/** The sun's path over one wall-clock day at the site. */
export function sunDay(site: SiteInfo, date: string): SunDay {
  const samples: SunSample[] = [];
  for (let minute = 0; minute <= 1440; minute += SAMPLE_MINUTES) samples.push(sunAt(site, date, minute / 60));
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let peak = samples[0]!;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (b.altitude > peak.altitude) peak = b;
    if (a.altitude <= 0 === b.altitude <= 0) continue;
    const crossing = a.hour + ((0 - a.altitude) / (b.altitude - a.altitude)) * (b.hour - a.hour);
    if (a.altitude <= 0) sunrise ??= crossing;
    else sunset = crossing;
  }
  return { samples, sunrise, sunset, peak };
}

/**
 * Shade cast by trees, in a colour of its own so it reads apart from building shadow.
 * Clear where trees take no light, so it is drawn over the light and shade.
 */
export const treeShadeColormap: Colormap = {
  stops: [
    [0, 52, 211, 153, 0],
    [0.5, 45, 205, 140, 190],
    [1, 12, 148, 104, 240],
  ],
};

/** Hours of sun lost to trees. A few hours is already a lot, so the colour comes in early. */
export const treeHoursColormap: Colormap = {
  stops: [
    [0, 52, 211, 153, 0],
    [0.06, 52, 211, 153, 120],
    [0.3, 30, 180, 124, 215],
    [1, 8, 120, 86, 240],
  ],
};

/** The tree shade colour as CSS, for legends. */
export const TREE_SHADE_CSS = 'rgb(45 205 140)';

/**
 * Sun hours with a design threshold: everything below `share` (0..1 of the scale) is flagged
 * in one flat colour, and the rest keeps the usual ramp, so a rule reads as pass and fail.
 */
export function thresholdColormap(share: number): Colormap {
  const t = Math.min(0.98, Math.max(0.01, share));
  const flag: [number, number, number, number] = [226, 54, 76, 240];
  const above = sunHoursColormap.stops.filter(([p]) => p > t + 0.005);
  // The ramp's own colour at the threshold, so the passing side starts where it would have been.
  const stops = sunHoursColormap.stops;
  let k = 0;
  while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
  const [a, b] = [stops[k]!, stops[k + 1]!];
  const f = (t - a[0]) / (b[0] - a[0]);
  const at = [1, 2, 3, 4].map((c) => Math.round(a[c]! + (b[c]! - a[c]!) * f)) as [number, number, number, number];
  return { stops: [[0, ...flag], [t - 0.004, ...flag], [t + 0.004, ...at], ...above] };
}

/** The windows of the day sun hours can be counted in (#81), in the site's wall-clock hours. */
export const WINDOWS: Record<string, [number, number]> = {
  morning: [6, 12],
  lunch: [11, 14],
  afternoon: [12, 17],
  evening: [17, 21],
};

/** The kernel's `from` and `until` for a window on a date; nulls for the whole day. */
export function windowParams(site: Pick<SiteInfo, 'timezone'>, date: string, window: string): { from: string | null; until: string | null } {
  const hours = WINDOWS[window];
  return hours ? { from: zonedTimeToUtc(date, hours[0], site.timezone), until: zonedTimeToUtc(date, hours[1], site.timezone) } : { from: null, until: null };
}

/** The golden hour runs while the sun is this low (#363): from 6° up to 4° under the horizon, where the blue hour takes over. */
export const GOLDEN_TOP = 6;
export const GOLDEN_BOTTOM = -4;

export interface GoldenWindow {
  /** Wall-clock hours in the site's time zone; `from` is earlier than `to`. */
  from: number;
  to: number;
}

/**
 * The day's golden hours: the morning one around sunrise and the evening one around sunset. In midwinter far north
 * the sun never climbs past 6°, and one window spans the whole day; both are then the same.
 */
export function goldenWindows(day: SunDay): { morning: GoldenWindow | null; evening: GoldenWindow | null } {
  const runs: GoldenWindow[] = [];
  const inside = (alt: number) => alt <= GOLDEN_TOP && alt >= GOLDEN_BOTTOM;
  // Where a sample pair crosses a level, by straight-line interpolation.
  const cross = (a: SunSample, b: SunSample, level: number) => a.hour + ((level - a.altitude) / (b.altitude - a.altitude)) * (b.hour - a.hour);
  let start: number | null = inside(day.samples[0]!.altitude) ? day.samples[0]!.hour : null;
  for (let i = 1; i < day.samples.length; i++) {
    const a = day.samples[i - 1]!;
    const b = day.samples[i]!;
    if (inside(a.altitude) === inside(b.altitude)) continue;
    const level = (inside(a.altitude) ? b.altitude : a.altitude) > GOLDEN_TOP ? GOLDEN_TOP : GOLDEN_BOTTOM;
    const at = cross(a, b, level);
    if (inside(b.altitude)) start = at;
    else if (start !== null) {
      runs.push({ from: start, to: at });
      start = null;
    }
  }
  if (start !== null) runs.push({ from: start, to: day.samples[day.samples.length - 1]!.hour });
  // A window that holds the sunrise is the morning's; one that holds the sunset is the evening's.
  const holds = (w: GoldenWindow, hour: number | null) => hour !== null && hour >= w.from && hour <= w.to;
  const morning = runs.find((w) => holds(w, day.sunrise)) ?? (day.sunrise === null && day.peak.altitude > GOLDEN_BOTTOM ? (runs[0] ?? null) : null);
  const evening = [...runs].reverse().find((w) => holds(w, day.sunset)) ?? (day.sunset === null && day.peak.altitude > GOLDEN_BOTTOM ? (runs[runs.length - 1] ?? null) : null);
  return { morning, evening };
}

const GOLD_LIGHT: Rgb = [255, 196, 102];
const EMBER_LIGHT: Rgb = [255, 112, 64];
const GOLD_SHADE: Rgb = [46, 30, 96];
const EMBER_SHADE: Rgb = [58, 22, 82];
const RIM: Rgb = [255, 92, 110];
const BLUE_HOUR_LIGHT: Rgb = [74, 100, 196];
const BLUE_HOUR_SHADE: Rgb = [22, 32, 88];

/**
 * Light and shade in golden hour mode (#363), warmer and deeper than `skyColormap`: honey light at 6° turning
 * ember orange as the sun meets the horizon, violet shade, and a hot rose rim along each shadow's edge where the
 * light rakes in. Under the horizon it cools into the blue hour.
 */
export function goldenColormap(altitude: number): Colormap {
  // 0 at the top of the golden hour, 1 at sunset.
  const ember = clamp01(1 - altitude / GOLDEN_TOP) ** 1.3;
  // 0 at sunset, 1 by the bottom of the golden hour.
  const blue = clamp01(-altitude / -GOLDEN_BOTTOM);
  const light = mix(mix(GOLD_LIGHT, EMBER_LIGHT, ember), BLUE_HOUR_LIGHT, blue ** 0.8);
  const shade = mix(mix(GOLD_SHADE, EMBER_SHADE, ember), BLUE_HOUR_SHADE, blue);
  const rim = mix(mix(mix(shade, light, 0.55), RIM, 0.4 * (1 - blue)), shade, blue * 0.6);
  const stop = (p: number, c: Rgb, a: number): Colormap['stops'][number] => [p, Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), a];
  return { stops: [stop(0, shade, 240), stop(0.42, mix(shade, rim, 0.5), 240), stop(0.55, rim, 240), stop(1, light, 240)] };
}
