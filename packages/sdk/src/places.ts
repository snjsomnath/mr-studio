// The place data standard (#160): every place motion (#161, #162, #163) reads the same few
// files, so an author prepares data once and can try any motion on it.
//
//   places.geojson   points (or a CSV with lon, lat): name, weight, optional category
//   activity.csv     optional, long format: place,time,activity
//   flows.csv        optional: from,to,volume
//   links.csv        optional: from,to (without it, places sharing a category are linked)
//
// Streets and buildings come from the site itself, never authored per motion.

import type { Point } from './blocks/geo.ts';
import type { Rgba } from './blocks/scale.ts';
import { colour } from './blocks/scale.ts';
import { StreetNetwork } from './blocks/network.ts';
import type { Shapes, Spot } from './blocks/sources.ts';
import { timeValue } from './marks.ts';
import { categorySlots, paletteColour } from './palette.ts';
import type { ResolvedPalette } from './palette.ts';

type Row = Record<string, unknown>;

/** One place, ready for a motion. */
export interface Place {
  index: number;
  name: string;
  /** Table metres. */
  point: Point;
  /** 0 to 1, rescaled from the weight column (0.6 for all when there is none). */
  weight: number;
  category: string | null;
  colour: Rgba;
}

/** Everything a place motion reads, prepared once per data change. */
export interface PlaceData {
  places: Place[];
  /** Liveliness of place `i` at time `t`, 0 to 1: from activity.csv, or a slow ambient swell without it. */
  activity(i: number, t: number): number;
  /** Whether `activity` comes from data. */
  hasActivity: boolean;
  /** Flows between places, volume rescaled 0 to 1. Empty without flows.csv. */
  flows: { from: number; to: number; volume: number }[];
  /** Relations between places: links.csv, else places sharing a category. */
  links: { a: number; b: number }[];
  /** Points a motion reaches out to (spokes, density): a targets dataset, or none. */
  targets: Point[];
  streets: StreetNetwork | null;
  /** Building footprints as boxes in table metres. */
  buildings: { point: Point; w: number; h: number }[];
  /** The table, in metres. */
  frame: { width: number; height: number };
  /** Problems an author should see (a flow naming a place that is not there, a weight that is not a number). */
  problems: string[];
}

/** Which columns the places use. Each is found by name when not given. */
export interface PlaceColumns {
  name?: string | null;
  weight?: string | null;
  category?: string | null;
  /** How places are coloured: one palette colour each, by category, or one slot (`@warm`) for all. */
  colours?: 'each' | 'category' | string;
}

export interface PlaceTables {
  activity?: Row[];
  flows?: Row[];
  links?: Row[];
}

export interface PlaceExtras {
  streets?: Shapes | null;
  buildings?: Shapes | null;
  targets?: Shapes | null;
}

/** The first column of `keys` that matches one of `names` (case-insensitive). */
function findColumn(keys: Iterable<string>, names: readonly string[]): string | null {
  const list = [...keys];
  for (const name of names) {
    const hit = list.find((k) => k.toLowerCase() === name);
    if (hit) return hit;
  }
  return null;
}

const NAME_COLUMNS = ['name', 'place', 'title', 'label', 'id'];
const WEIGHT_COLUMNS = ['weight', 'mass', 'importance', 'size', 'value', 'visitors'];
const CATEGORY_COLUMNS = ['category', 'kind', 'type', 'group', 'class'];

/** Guesses which columns of the places are the name, weight and category (#160: auto-detection). */
export function guessPlaceColumns(rows: readonly Row[]): { name: string | null; weight: string | null; category: string | null } {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 200)) for (const k of Object.keys(row ?? {})) keys.add(k);
  return { name: findColumn(keys, NAME_COLUMNS), weight: findColumn(keys, WEIGHT_COLUMNS), category: findColumn(keys, CATEGORY_COLUMNS) };
}

const numberOf = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/** Builds the places and their tables. `cycle_s` is how long activity.csv takes to play through once. */
export function placeData(
  spots: readonly Spot[],
  columns: PlaceColumns,
  tables: PlaceTables,
  extras: PlaceExtras,
  palette: ResolvedPalette,
  frame: { width: number; height: number },
  cycle_s = 24,
): PlaceData {
  const problems: string[] = [];
  const rows = spots.map((s) => (s.properties ?? {}) as Row);
  const guess = guessPlaceColumns(rows);
  const nameCol = columns.name === undefined ? guess.name : columns.name;
  const weightCol = columns.weight === undefined ? guess.weight : columns.weight;
  const categoryCol = columns.category === undefined ? guess.category : columns.category;

  // Weights: any range, rescaled to 0..1 (a floor keeps the lightest place visible).
  const raw = rows.map((r) => (weightCol ? numberOf(r[weightCol]) : NaN));
  if (weightCol && raw.some((v, i) => !Number.isFinite(v) && rows[i]![weightCol] !== undefined && rows[i]![weightCol] !== '')) problems.push(`Some '${weightCol}' values are not numbers; those places get a middle weight.`);
  const finite = raw.filter(Number.isFinite);
  const lo = finite.length ? Math.min(...finite) : 0;
  const hi = finite.length ? Math.max(...finite) : 1;
  const weight = (v: number) => (!Number.isFinite(v) ? 0.6 : hi > lo ? 0.2 + 0.8 * ((v - lo) / (hi - lo)) : 0.8);

  const categories: string[] = [];
  const slots = categorySlots(palette);
  const mode = columns.colours ?? (categoryCol ? 'category' : 'each');
  const places: Place[] = spots.map((spot, i) => {
    const category = categoryCol && rows[i]![categoryCol] != null ? String(rows[i]![categoryCol]) : null;
    if (category !== null && !categories.includes(category)) categories.push(category);
    const c =
      mode === 'each'
        ? colour(slots[i % slots.length]!)
        : mode === 'category'
          ? colour(slots[(category === null ? 0 : categories.indexOf(category)) % slots.length]!)
          : paletteColour(mode, palette, 'accent');
    return {
      index: i,
      name: nameCol && rows[i]![nameCol] != null ? String(rows[i]![nameCol]) : `Place ${i + 1}`,
      point: spot.point,
      weight: weight(raw[i]!),
      category,
      colour: c,
    };
  });
  const byName = new Map(places.map((p) => [p.name.toLowerCase(), p.index]));
  const placeOf = (v: unknown, file: string): number => {
    const i = byName.get(String(v ?? '').toLowerCase());
    if (i === undefined && v !== undefined && v !== '' && problems.length < 8) problems.push(`${file} names '${String(v)}', which is not one of the places.`);
    return i ?? -1;
  };

  // Activity: a value per place per time, played through in `cycle_s` seconds.
  let activity: PlaceData['activity'] = (i, t) => Math.pow(Math.max(0, Math.sin(t * 0.55 + i * 1.37)), 3);
  let hasActivity = false;
  if (tables.activity?.length) {
    const keys = Object.keys(tables.activity[0] ?? {});
    const placeCol = findColumn(keys, ['place', 'name', 'id']);
    const timeCol = findColumn(keys, ['time', 'date', 'datetime', 'hour', 'year', 'when']);
    const valueCol = findColumn(keys, ['activity', 'value', 'level', 'count', 'visitors']);
    if (placeCol && timeCol && valueCol) {
      const series = places.map(() => [] as [number, number][]);
      let vmin = Infinity;
      let vmax = -Infinity;
      let tmin = Infinity;
      let tmax = -Infinity;
      for (const row of tables.activity) {
        const i = placeOf(row[placeCol], 'activity.csv');
        const t = timeValue(row[timeCol]);
        const v = numberOf(row[valueCol]);
        if (i < 0 || !Number.isFinite(t) || !Number.isFinite(v)) continue;
        series[i]!.push([t, v]);
        [vmin, vmax, tmin, tmax] = [Math.min(vmin, v), Math.max(vmax, v), Math.min(tmin, t), Math.max(tmax, t)];
      }
      if (Number.isFinite(tmin)) {
        for (const s of series) s.sort((a, b) => a[0] - b[0]);
        const span = tmax - tmin || 1;
        const range = vmax - vmin || 1;
        hasActivity = true;
        activity = (i, t) => {
          const s = series[i];
          if (!s || s.length === 0) return 0.5;
          const at = tmin + ((((t % cycle_s) + cycle_s) % cycle_s) / cycle_s) * span;
          if (at <= s[0]![0]) return (s[0]![1] - vmin) / range;
          for (let k = 1; k < s.length; k++) {
            if (s[k]![0] >= at) {
              const [t0, v0] = s[k - 1]!;
              const [t1, v1] = s[k]!;
              const f = t1 > t0 ? (at - t0) / (t1 - t0) : 0;
              return (v0 + (v1 - v0) * f - vmin) / range;
            }
          }
          return (s[s.length - 1]![1] - vmin) / range;
        };
      }
    } else problems.push('activity.csv needs place, time and activity columns.');
  }

  const flows: PlaceData['flows'] = [];
  if (tables.flows?.length) {
    const keys = Object.keys(tables.flows[0] ?? {});
    const from = findColumn(keys, ['from', 'origin', 'source']);
    const to = findColumn(keys, ['to', 'destination', 'target']);
    const vol = findColumn(keys, ['volume', 'count', 'trips', 'value', 'weight']);
    if (from && to) {
      const list = tables.flows.map((row) => ({ from: placeOf(row[from], 'flows.csv'), to: placeOf(row[to], 'flows.csv'), volume: vol ? numberOf(row[vol]) : 1 }));
      const most = Math.max(1e-9, ...list.map((f) => (Number.isFinite(f.volume) ? f.volume : 0)));
      for (const f of list) if (f.from >= 0 && f.to >= 0 && f.from !== f.to) flows.push({ ...f, volume: Number.isFinite(f.volume) ? f.volume / most : 0.5 });
    } else problems.push('flows.csv needs from and to columns.');
  }

  const links: PlaceData['links'] = [];
  const seen = new Set<string>();
  const link = (a: number, b: number) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a >= 0 && b >= 0 && a !== b && !seen.has(key)) {
      seen.add(key);
      links.push({ a, b });
    }
  };
  if (tables.links?.length) {
    const keys = Object.keys(tables.links[0] ?? {});
    const from = findColumn(keys, ['from', 'a', 'source']);
    const to = findColumn(keys, ['to', 'b', 'target']);
    if (from && to) for (const row of tables.links) link(placeOf(row[from], 'links.csv'), placeOf(row[to], 'links.csv'));
  } else if (categoryCol) {
    for (const a of places) for (const b of places) if (a.index < b.index && a.category !== null && a.category === b.category) link(a.index, b.index);
  }

  const streets = extras.streets?.paths.length ? new StreetNetwork(extras.streets.paths.map((p) => p.points), 2) : null;
  const buildings = (extras.buildings?.areas ?? []).map((area) => {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of area.polygons) for (const [x, y] of polygon[0] ?? []) [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
    return { point: area.centre, w: maxX - minX, h: maxY - minY };
  }).filter((b) => Number.isFinite(b.w));
  const targets = (extras.targets?.spots ?? []).map((s) => s.point);
  return { places, activity, hasActivity, flows, links, targets, streets, buildings, frame, problems };
}

// ---- Help: how to set up data for each motion (the ? panel) ---------------------------

/** The data shapes a motion can read, with an example an author can copy. */
export const PLACE_DATA_HELP = {
  places: { file: 'places.geojson', what: 'Points, one per place. Any GeoJSON, or a CSV with lon and lat columns.', example: '{"type":"Feature",\n "geometry":{"type":"Point","coordinates":[11.9746,57.6896]},\n "properties":{"name":"Library","weight":0.85}}' },
  activity: { file: 'places.geojson + activity.csv', what: 'The same points, plus a value per place over time. Long format: one row per place per time step.', example: 'place,time,activity\nLibrary,2026-11-23T08:00,0.2\nLibrary,2026-11-23T09:00,0.7\nStation,2026-11-23T08:00,1.0' },
  flows: { file: 'places.geojson + flows.csv', what: 'The places, plus one row per trip or flow between two of them.', example: 'from,to,volume\nStation,Library,420\nMarket,Station,180' },
  links: { file: 'places.geojson + links.csv', what: 'The places, plus one row per relation. Or skip the file and link places that share a category column.', example: 'from,to\nLibrary,School\nLibrary,Station' },
  targets: { file: 'places.geojson + targets.geojson', what: 'Hubs, plus the points to reach. The targets can be any point dataset already on the site (shops, stops, trees).', example: 'targets.geojson: points, no columns required' },
  audio: { file: 'places.geojson + audio files', what: 'The places, with a column naming a sound file (#150). Until audio lands, the bars move by weight and activity.', example: '{"properties":{"name":"Park","sound":"blackbird.mp3"}}' },
  raster: { file: 'places.geojson (density)', what: 'Points turned into a density surface. The places and any targets count, each by its weight.', example: 'places.geojson + targets.geojson' },
} as const;
export type PlaceDataKind = keyof typeof PLACE_DATA_HELP;

/** What each column a motion reads means. */
export const PLACE_COLUMN_HELP: Record<string, string> = {
  weight: 'weight · number. Size and strength. Any range, rescaled to 0–1.',
  name: 'name · text. Joins rows in the CSV files to points.',
  activity: 'activity · number over time (activity.csv). Speed or liveliness; without it places breathe slowly on their own.',
  category: 'category · text. Optional. Colours places by group, and links them when there is no links.csv.',
  volume: 'volume · number (flows.csv). Comet size and how often comets fly.',
  heading: 'heading · degrees. Optional. Where the bulge points.',
  sound: 'sound · file name. Optional (#150).',
  level: 'level · number over time (activity.csv). How hard the ring wobbles.',
};
