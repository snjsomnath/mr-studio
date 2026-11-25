// Geometry helpers for layers that draw on a canvas overlay: WGS84 to table metres,
// site datasets, polylines and a seeded random generator.

import type { CanvasOverlay } from './layer.ts';
import type { SiteInfo } from './types.ts';
import { dataProblem, fetchFromHost } from './data.ts';

export type XY = [x: number, y: number];

/** The table as a rectangle in metres: x right, y down, origin at the top left corner. */
export interface TableSpace {
  readonly width: number;
  readonly height: number;
  /** WGS84 to table metres. Points outside the extent give coordinates outside the rectangle. */
  toTable(lon: number, lat: number): XY;
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

/** Below this share of the table reached, a dataset most likely belongs to another place (#180). */
export const STRAY_REACH = 0.25;

/**
 * How much of the table a dataset reaches: the share of an 8 × 5 grid of cells over the table that
 * its lines (or points, as lines of one) pass through. Data that runs past the table still reaches
 * all of it; data from another place that only clips one edge reaches a few cells.
 */
export function tableReach(lines: Iterable<XY[]>, space: Pick<TableSpace, 'width' | 'height'>): number {
  const [columns, rows] = [8, 5];
  const { width, height } = space;
  if (!(width > 0 && height > 0)) return 0;
  const hit = new Set<number>();
  const step = Math.min(width / columns, height / rows) / 2;
  const mark = (x: number, y: number) => {
    if (x < 0 || x > width || y < 0 || y > height) return;
    hit.add(Math.min(rows - 1, Math.floor((y / height) * rows)) * columns + Math.min(columns - 1, Math.floor((x / width) * columns)));
  };
  for (const line of lines) {
    if (line.length === 1) mark(line[0]![0], line[0]![1]);
    for (let i = 1; i < line.length; i++) {
      const [[x0, y0], [x1, y1]] = [line[i - 1]!, line[i]!];
      const n = Math.min(10_000, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let k = 0; k <= n; k++) mark(x0 + ((x1 - x0) * k) / Math.max(n, 1), y0 + ((y1 - y0) * k) / Math.max(n, 1));
    }
    if (hit.size === columns * rows) break;
  }
  return hit.size / (columns * rows);
}

/** The URL of a named site dataset, or null when the site does not have it. */
export function siteDataUrl(site: SiteInfo, name: string): string | null {
  const path = site.data?.[name];
  return path ? `/site/${path}` : null;
}

/**
 * Fetches a named site dataset as JSON. Null when the site does not have it or it cannot be loaded.
 * A failed connection or a server error is tried again a few times, since a host that is starting
 * (the desktop app switching tables) briefly answers nothing (#222). A dataset the site names but
 * that cannot be read is reported (#259): the runtime shows the layers that need it as in trouble
 * and starts them again until it can be read.
 */
export async function readSiteData<T = any>(site: SiteInfo, name: string): Promise<T | null> {
  const url = siteDataUrl(site, name);
  if (!url) return null;
  const file = url.split('/').pop() || url;
  let response: Response;
  try {
    response = await fetchFromHost(url);
  } catch (error) {
    console.warn(`site data '${name}' could not be loaded: ${(error as Error).message}`);
    dataProblem({ name, reason: `couldn't reach the table's server for ${file}` });
    return null;
  }
  if (!response.ok) {
    console.warn(`site data '${name}' could not be loaded: HTTP ${response.status}`);
    dataProblem({ name, reason: `couldn't read ${file} (HTTP ${response.status})` });
    return null;
  }
  try {
    return (await response.json()) as T;
  } catch {
    dataProblem({ name, reason: `${file} is not valid JSON` });
    return null;
  }
}

// ---- GeoJSON --------------------------------------------------------------

export interface Placed<G> {
  geometry: G;
  properties: Record<string, any>;
}

function features(geojson: any): any[] {
  if (!geojson) return [];
  if (geojson.type === 'FeatureCollection') return geojson.features ?? [];
  return geojson.type === 'Feature' ? [geojson] : [];
}

/** Every line in a GeoJSON document, in table metres. */
export function geojsonLines(geojson: unknown, space: TableSpace): Placed<XY[]>[] {
  const out: Placed<XY[]>[] = [];
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
export function geojsonPolygons(geojson: unknown, space: TableSpace): Placed<XY[][]>[] {
  const out: Placed<XY[][]>[] = [];
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
export function geojsonPoints(geojson: unknown, space: TableSpace): Placed<XY>[] {
  const out: Placed<XY>[] = [];
  for (const feature of features(geojson)) {
    const geometry = feature.geometry;
    const points = geometry?.type === 'Point' ? [geometry.coordinates] : geometry?.type === 'MultiPoint' ? geometry.coordinates : [];
    for (const c of points) out.push({ geometry: space.toTable(c[0], c[1]), properties: feature.properties ?? {} });
  }
  return out;
}

/** Adds polygon rings to the current path. Fill with the 'evenodd' rule so holes stay open. */
export function tracePolygon(ctx: CanvasRenderingContext2D, rings: XY[][]): void {
  for (const ring of rings) {
    ring.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }
}

/** Adds a polyline to the current path. */
export function traceLine(ctx: CanvasRenderingContext2D, line: XY[]): void {
  line.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
}

/** Whether a point is inside a polygon given as rings (even-odd, so holes are outside). */
export function insidePolygon(rings: XY[][], x: number, y: number): boolean {
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
  points: XY[];
  /** Distance from the start to each point. */
  at: number[];
  length: number;
}

export function track(points: XY[]): Track {
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

/**
 * Limits what a canvas overlay draws next to the table's extent, so lines from a dataset
 * larger than the table stop at its edge instead of running into the projector's blank
 * margin (#203). Wrap the drawing in `context.save()` and `context.restore()`.
 */
export function clipToTable(canvas: Pick<CanvasOverlay, 'context' | 'project'>, site: Pick<SiteInfo, 'corners'>): void {
  const g = canvas.context;
  g.beginPath();
  site.corners.forEach((corner, i) => {
    const [x, y] = canvas.project(corner);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.closePath();
  g.clip();
}
