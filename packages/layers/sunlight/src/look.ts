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
