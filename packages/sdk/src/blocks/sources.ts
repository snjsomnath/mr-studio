// Data sources. Every source has the same two methods, so a layer does not care
// whether its numbers come from a file in the site package, a CSV export or a
// live service: `load()` for one value, `watch()` to be told when it changes.

import { centroid, measurePath } from './geo.ts';
import type { MeasuredPath, Point, Polygon, TableFrame } from './geo.ts';

export interface Source<T> {
  /** Reads the value once. */
  load(): Promise<T>;
  /** Calls back with the value now and whenever it changes. Returns a function that stops watching. */
  watch(onValue: (value: T) => void, onError?: (error: Error) => void): () => void;
}

/** The part of `fetch` the sources use, so tests and the host gateway can stand in for it. */
export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface SourceOptions {
  fetch?: Fetcher;
}

const defaultFetch: Fetcher = (url) => fetch(url, { cache: 'no-store' });

/** A source over a fixed value or a one-off read. */
export function staticSource<T>(read: () => Promise<T> | T): Source<T> {
  let cached: Promise<T> | null = null;
  const load = () => (cached ??= Promise.resolve().then(read));
  return {
    load,
    watch(onValue, onError) {
      let stopped = false;
      load().then(
        (value) => !stopped && onValue(value),
        (error) => !stopped && onError?.(error as Error),
      );
      return () => {
        stopped = true;
      };
    },
  };
}

/** Derives a source from another, for reshaping a service's reply into what a block wants. */
export function mapSource<T, U>(source: Source<T>, map: (value: T) => U): Source<U> {
  return {
    load: () => source.load().then(map),
    watch: (onValue, onError) => source.watch((value) => onValue(map(value)), onError),
  };
}

// ---- GeoJSON --------------------------------------------------------------

export interface GeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  geometry: { type: string; coordinates: any } | null;
  properties: Record<string, any> | null;
}
export interface GeoJsonCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
  [key: string]: unknown;
}

/** A GeoJSON FeatureCollection in WGS84, from a URL or an object already in hand. */
export function geojsonSource(input: string | GeoJsonCollection, options: SourceOptions = {}): Source<GeoJsonCollection> {
  return staticSource(async () => {
    if (typeof input !== 'string') return input;
    const response = await (options.fetch ?? defaultFetch)(input);
    if (!response.ok) throw new Error(`${input}: ${response.status}`);
    const parsed = (await response.json()) as GeoJsonCollection;
    if (parsed?.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) throw new Error(`${input} is not a GeoJSON FeatureCollection`);
    return parsed;
  });
}

type Properties = Record<string, any>;

/** A filled shape: a building, a district, a grid cell. */
export interface Area<P = Properties> {
  id: string | number;
  polygons: Polygon[];
  centre: [number, number];
  properties: P;
}
/** A line: a street, a route, a flow between two nodes. */
export interface Path<P = Properties> extends MeasuredPath {
  id: string | number;
  properties: P;
}
/** A point: a node, a stop, a point of interest. */
export interface Spot<P = Properties> {
  id: string | number;
  point: [number, number];
  properties: P;
}
export interface Shapes<P = Properties> {
  areas: Area<P>[];
  paths: Path<P>[];
  spots: Spot<P>[];
}

/**
 * Turns GeoJSON into shapes in table metres, sorted by geometry type. `idProperty`
 * names the property that identifies a feature; without it the feature's own id or
 * its index is used. Multi-part lines and points become one shape per part.
 */
export function readShapes<P = Properties>(collection: GeoJsonCollection, frame: TableFrame, idProperty?: string): Shapes<P> {
  const shapes: Shapes<P> = { areas: [], paths: [], spots: [] };
  const ring = (coords: [number, number][]): Point[] => coords.map((c) => frame.toTable(c));
  collection.features.forEach((feature, index) => {
    const geometry = feature.geometry;
    if (!geometry) return;
    const properties = (feature.properties ?? {}) as P;
    const id = (idProperty !== undefined ? (properties as Properties)[idProperty] : undefined) ?? feature.id ?? index;
    const c = geometry.coordinates;
    switch (geometry.type) {
      case 'Polygon':
      case 'MultiPolygon': {
        const polygons: Polygon[] = (geometry.type === 'Polygon' ? [c] : c).map((rings: [number, number][][]) => rings.map(ring));
        const largest = polygons.reduce((best, p) => ((p[0]?.length ?? 0) > (best[0]?.length ?? 0) ? p : best), polygons[0] ?? []);
        shapes.areas.push({ id, polygons, centre: centroid(largest), properties });
        break;
      }
      case 'LineString':
        shapes.paths.push({ id, properties, ...measurePath(ring(c)) });
        break;
      case 'MultiLineString':
        c.forEach((line: [number, number][], part: number) => shapes.paths.push({ id: part === 0 ? id : `${id}:${part}`, properties, ...measurePath(ring(line)) }));
        break;
      case 'Point':
        shapes.spots.push({ id, point: frame.toTable(c), properties });
        break;
      case 'MultiPoint':
        c.forEach((p: [number, number], part: number) => shapes.spots.push({ id: part === 0 ? id : `${id}:${part}`, point: frame.toTable(p), properties }));
        break;
    }
  });
  return shapes;
}

// ---- CSV ------------------------------------------------------------------

export type Row = Record<string, string | number>;

/**
 * Parses CSV text with a header row. Handles quoted fields, doubled quotes and
 * both line endings. Cells that look like numbers become numbers; the separator
 * is detected from the header (comma, semicolon or tab).
 */
export function parseCsv(text: string): Row[] {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.slice(0, body.search(/\r?\n|$/));
  const separator = [',', ';', '\t'].reduce((best, s) => (firstLine.split(s).length > firstLine.split(best).length ? s : best), ',');
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      record.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      record.push(cell);
      cell = '';
      if (record.some((value) => value !== '')) records.push(record);
      record = [];
    } else cell += ch;
  }
  record.push(cell);
  if (record.some((value) => value !== '')) records.push(record);

  const header = (records.shift() ?? []).map((name) => name.trim());
  return records.map((values) => {
    const row: Row = {};
    header.forEach((name, i) => {
      const raw = (values[i] ?? '').trim();
      row[name] = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    });
    return row;
  });
}

/** Rows of a CSV file, from a URL. */
export function csvSource(url: string, options: SourceOptions = {}): Source<Row[]> {
  return staticSource(async () => {
    const response = await (options.fetch ?? defaultFetch)(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return parseCsv(await response.text());
  });
}

/** Columns of a table as arrays, e.g. one hourly series per column. */
export function columns(rows: Row[], names: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const name of names) out[name] = rows.map((row) => Number(row[name]) || 0);
  return out;
}

// ---- Live -----------------------------------------------------------------

export interface LiveOptions<T> extends SourceOptions {
  /** Seconds between reads. */
  every: number;
  /** Turns the reply into the value. Default: the JSON body. */
  parse?: (body: unknown) => T;
  /** Longest wait after repeated failures, in seconds. Default: ten times `every`. */
  maxBackoff?: number;
  /** For tests. */
  timer?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/**
 * A JSON endpoint read on an interval. Watchers share one poll loop, which runs
 * only while someone is watching. A failed read keeps the last good value, reports
 * the error and backs off, so a service that is down does not blank the table.
 */
export function liveSource<T = unknown>(url: string, options: LiveOptions<T>): Source<T> {
  const fetcher = options.fetch ?? defaultFetch;
  const timer = options.timer ?? { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as number) };
  const watchers = new Set<{ onValue: (value: T) => void; onError?: (error: Error) => void }>();
  let last: { value: T } | null = null;
  let lastJson = '';
  let handle: unknown = null;
  let failures = 0;
  let running = false;

  async function read(): Promise<T> {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const body = await response.json();
    return options.parse ? options.parse(body) : (body as T);
  }

  async function poll(): Promise<void> {
    try {
      const value = await read();
      failures = 0;
      const json = JSON.stringify(value);
      if (!last || json !== lastJson) {
        last = { value };
        lastJson = json;
        for (const w of watchers) w.onValue(value);
      }
    } catch (error) {
      failures++;
      for (const w of watchers) w.onError?.(error as Error);
    }
    if (!running) return;
    const wait = Math.min(options.every * 2 ** Math.min(failures, 10), options.maxBackoff ?? options.every * 10);
    handle = timer.set(() => void poll(), wait * 1000);
  }

  return {
    load: read,
    watch(onValue, onError) {
      const watcher = { onValue, onError };
      watchers.add(watcher);
      if (last) onValue(last.value);
      if (!running) {
        running = true;
        void poll();
      }
      return () => {
        watchers.delete(watcher);
        if (watchers.size === 0) {
          running = false;
          if (handle !== null) timer.clear(handle);
          handle = null;
        }
      };
    },
  };
}

// ---- Joins ----------------------------------------------------------------

/** Lower-cases and strips accents and punctuation, so 'Kårhus' and 'karhus' are the same key. */
export function foldKey(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Attaches table rows to shapes by a shared key, e.g. a CSV of energy classes onto
 * building footprints. Returns how many shapes found a row, so a layer can say when
 * its data does not match its geometry instead of drawing nothing.
 */
export function joinRows<S extends { properties: Record<string, any> }>(
  shapes: S[],
  rows: Row[],
  keys: { shape: string; row: string; fold?: boolean },
): { matched: number; unmatched: S[] } {
  const norm = keys.fold === false ? (v: unknown) => String(v ?? '') : foldKey;
  const index = new Map<string, Row>();
  for (const row of rows) index.set(norm(row[keys.row]), row);
  const unmatched: S[] = [];
  for (const shape of shapes) {
    const row = index.get(norm(shape.properties[keys.shape]));
    if (row) Object.assign(shape.properties, row);
    else unmatched.push(shape);
  }
  return { matched: shapes.length - unmatched.length, unmatched };
}
