// Geometry helpers for layers that draw on a canvas overlay: WGS84 to table metres,
// site datasets, polylines and a seeded random generator.

import type { SiteInfo } from './types.ts';

export type Point = [x: number, y: number];

/** The table as a rectangle in metres: x right, y down, origin at the top left corner. */
export interface TableSpace {
  readonly width: number;
  readonly height: number;
  /** WGS84 to table metres. Points outside the extent give coordinates outside the rectangle. */
  toTable(lon: number, lat: number): Point;
}

export function tableSpace(site: SiteInfo): TableSpace {
  const { width_m: width, height_m: height } = site.extent;
  // Over a site, table metres are an affine function of lon/lat, fixed by three corners.
  const [tl, tr, , bl] = site.corners;
  const ax = tr[0] - tl[0];
  const ay = tr[1] - tl[1];
  const bx = bl[0] - tl[0];
  const by = bl[1] - tl[1];
  const det = ax * by - ay * bx;
  return {
    width,
    height,
    toTable(lon, lat) {
      const dx = lon - tl[0];
      const dy = lat - tl[1];
      return [((dx * by - dy * bx) / det) * width, ((ax * dy - ay * dx) / det) * height];
    },
  };
}

/** The URL of a named site dataset, or null when the site does not have it. */
export function siteDataUrl(site: SiteInfo, name: string): string | null {
  const path = site.data?.[name];
  return path ? `/site/${path}` : null;
}

/** Fetches a named site dataset as JSON. Null when the site does not have it or it fails to load. */
export async function loadSiteData<T = any>(site: SiteInfo, name: string): Promise<T | null> {
  const url = siteDataUrl(site, name);
  if (!url) return null;
  try {
    const response = await fetch(url);
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

// ---- GeoJSON --------------------------------------------------------------

export interface Shape<G> {
  geometry: G;
  properties: Record<string, any>;
}

function features(geojson: any): any[] {
  if (!geojson) return [];
  if (geojson.type === 'FeatureCollection') return geojson.features ?? [];
  return geojson.type === 'Feature' ? [geojson] : [];
}

/** Every line in a GeoJSON document, in table metres. */
export function geojsonLines(geojson: unknown, space: TableSpace): Shape<Point[]>[] {
  const out: Shape<Point[]>[] = [];
  for (const feature of features(geojson)) {
    const geometry = feature.geometry;
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    for (const line of lines) {
      if (line.length >= 2) out.push({ geometry: line.map((c: number[]) => space.toTable(c[0]!, c[1]!)), properties: feature.properties ?? {} });
    }
  }
  return out;
}

/** Every polygon in a GeoJSON document as rings (outer first, then holes), in table metres. */
export function geojsonPolygons(geojson: unknown, space: TableSpace): Shape<Point[][]>[] {
  const out: Shape<Point[][]>[] = [];
  for (const feature of features(geojson)) {
    const geometry = feature.geometry;
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
    for (const rings of polygons) {
      out.push({ geometry: rings.map((ring: number[][]) => ring.map((c) => space.toTable(c[0]!, c[1]!))), properties: feature.properties ?? {} });
    }
  }
  return out;
}

/** Every point in a GeoJSON document, in table metres. */
export function geojsonPoints(geojson: unknown, space: TableSpace): Shape<Point>[] {
  const out: Shape<Point>[] = [];
  for (const feature of features(geojson)) {
    const geometry = feature.geometry;
    const points = geometry?.type === 'Point' ? [geometry.coordinates] : geometry?.type === 'MultiPoint' ? geometry.coordinates : [];
    for (const c of points) out.push({ geometry: space.toTable(c[0], c[1]), properties: feature.properties ?? {} });
  }
  return out;
}

/** Adds polygon rings to the current path. Fill with the 'evenodd' rule so holes stay open. */
export function tracePolygon(ctx: CanvasRenderingContext2D, rings: Point[][]): void {
  for (const ring of rings) {
    ring.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }
}

/** Adds a polyline to the current path. */
export function traceLine(ctx: CanvasRenderingContext2D, line: Point[]): void {
  line.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
}

/** Whether a point is inside a polygon given as rings (even-odd, so holes are outside). */
export function insidePolygon(rings: Point[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// ---- Polylines ------------------------------------------------------------

/** A polyline with its running length, for moving things along it. */
export interface Track {
  points: Point[];
  /** Distance from the start to each point. */
  at: number[];
  length: number;
}

export function track(points: Point[]): Track {
  const at = [0];
  for (let i = 1; i < points.length; i++) {
    at.push(at[i - 1]! + Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]));
  }
  return { points, at, length: at[at.length - 1] ?? 0 };
}

/** The position and heading (radians, 0 along +x) at a distance along a track. */
export function along(t: Track, distance: number): { x: number; y: number; angle: number } {
  const d = Math.min(t.length, Math.max(0, distance));
  let lo = 0;
  let hi = t.at.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t.at[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const a = t.points[lo]!;
  const b = t.points[hi] ?? a;
  const span = (t.at[hi] ?? 0) - t.at[lo]!;
  const f = span > 0 ? (d - t.at[lo]!) / span : 0;
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

/** The distance along a track of the point on it nearest to (x, y). */
export function nearestAlong(t: Track, x: number, y: number): number {
  let best = Infinity;
  let bestAt = 0;
  for (let i = 1; i < t.points.length; i++) {
    const [ax, ay] = t.points[i - 1]!;
    const [bx, by] = t.points[i]!;
    const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
    const f = lengthSquared > 0 ? Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / lengthSquared)) : 0;
    const distance = Math.hypot(ax + (bx - ax) * f - x, ay + (by - ay) * f - y);
    if (distance < best) {
      best = distance;
      bestAt = t.at[i - 1]! + Math.sqrt(lengthSquared) * f;
    }
  }
  return bestAt;
}

/**
 * The site's streets as lines in table metres: the `roads` dataset when the site has
 * one, otherwise a generated grid so ambient layers still have somewhere to run.
 */
export async function streetLines(site: SiteInfo): Promise<{ lines: Shape<Point[]>[]; generated: boolean }> {
  const space = tableSpace(site);
  const lines = geojsonLines(await loadSiteData(site, 'roads'), space);
  if (lines.length > 0) return { lines, generated: false };
  // Lines share a vertex at every crossing, which is what lets traffic turn there.
  const pitch = 90;
  const stops = (size: number) => Array.from({ length: Math.ceil(size / pitch) + 2 }, (_, i) => (i - 0.5) * pitch);
  const xs = stops(space.width);
  const ys = stops(space.height);
  const out: Shape<Point[]>[] = [];
  for (const x of xs) out.push({ geometry: ys.map((y): Point => [x, y]), properties: { kind: 'street' } });
  for (const y of ys) out.push({ geometry: xs.map((x): Point => [x, y]), properties: { kind: 'street' } });
  return { lines: out, generated: true };
}

// ---- Random ---------------------------------------------------------------

/** A small seeded generator (mulberry32), so every table shows the same "random" scene. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `#rrggbb` to an `rgb(r g b / a)` string. */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}
