// Geometry shared by every block. Blocks work in *table metres*: x to the right and
// y down from the top left corner of the site's extent, the same frame as a field's
// columns and rows. One unit is one metre on the ground.

import type { SiteInfo } from '../types.ts';

/** A position in table metres. */
export type Point = readonly [x: number, y: number];
/** A position in WGS84. */
export type LonLat = readonly [lon: number, lat: number];

export interface TableFrame {
  readonly width: number;
  readonly height: number;
  /** WGS84 to table metres. */
  toTable(lonLat: LonLat): [number, number];
  /** Table metres to WGS84. */
  toLonLat(point: Point): [number, number];
  /** Whether a point is on the table, with an optional margin in metres. */
  contains(point: Point, margin?: number): boolean;
}

const A = 6_378_137.0;
const E2 = 0.006_694_379_990_14;

/**
 * The table frame of a site. Uses the same tangent-plane projection and grid
 * rotation as the engine (`mrs-site` projection, `mrs-engine` grid), so a point
 * drawn by a block lands on the cell a kernel computed for it.
 */
export function tableFrame(site: Pick<SiteInfo, 'origin' | 'extent'>): TableFrame {
  const phi = (site.origin.lat * Math.PI) / 180;
  const s = 1 - E2 * Math.sin(phi) ** 2;
  const mPerDegLat = ((A * (1 - E2)) / s ** 1.5) * (Math.PI / 180);
  const mPerDegLon = (A / Math.sqrt(s)) * Math.cos(phi) * (Math.PI / 180);
  const r = (site.extent.rotation_deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const width = site.extent.width_m;
  const height = site.extent.height_m;
  return {
    width,
    height,
    toTable([lon, lat]) {
      const east = (lon - site.origin.lon) * mPerDegLon;
      const north = (lat - site.origin.lat) * mPerDegLat;
      return [east * cos - north * sin + width / 2, height / 2 - (east * sin + north * cos)];
    },
    toLonLat([x, y]) {
      const right = x - width / 2;
      const up = height / 2 - y;
      const east = right * cos + up * sin;
      const north = -right * sin + up * cos;
      return [site.origin.lon + east / mPerDegLon, site.origin.lat + north / mPerDegLat];
    },
    contains([x, y], margin = 0) {
      return x >= -margin && y >= -margin && x <= width + margin && y <= height + margin;
    },
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

// ---- Paths ----------------------------------------------------------------

/** A polyline with its running length, so a position along it is a binary search. */
export interface MeasuredPath {
  readonly points: readonly Point[];
  /** Distance from the start to each point, in metres. */
  readonly stations: readonly number[];
  readonly length: number;
}

export function measurePath(points: readonly Point[]): MeasuredPath {
  const stations = [0];
  for (let i = 1; i < points.length; i++) stations.push(stations[i - 1]! + distance(points[i - 1]!, points[i]!));
  return { points, stations, length: stations[stations.length - 1] ?? 0 };
}

/** The point at a fraction (0..1) of a path's length, and the heading there in radians. */
export function pointAlong(path: MeasuredPath, fraction: number): { point: [number, number]; heading: number } {
  const { points, stations } = path;
  if (points.length === 0) return { point: [0, 0], heading: 0 };
  if (points.length === 1) return { point: [points[0]![0], points[0]![1]], heading: 0 };
  const want = Math.min(1, Math.max(0, fraction)) * path.length;
  let lo = 0;
  let hi = stations.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (stations[mid]! <= want) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  const span = stations[hi]! - stations[lo]!;
  const t = span > 0 ? (want - stations[lo]!) / span : 0;
  return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

/** A curved line between two points, for flows that have no street route. `bend` is the sag as a share of the distance. */
export function arc(from: Point, to: Point, bend = 0.2, segments = 24): [number, number][] {
  const mx = (from[0] + to[0]) / 2 - (to[1] - from[1]) * bend;
  const my = (from[1] + to[1]) / 2 + (to[0] - from[0]) * bend;
  const out: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    out.push([u * u * from[0] + 2 * u * t * mx + t * t * to[0], u * u * from[1] + 2 * u * t * my + t * t * to[1]]);
  }
  return out;
}

// ---- Polygons -------------------------------------------------------------

/** Rings of one polygon: the outer ring first, then holes. */
export type Polygon = readonly (readonly Point[])[];

export function pointInRing(point: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(point: Point, polygon: Polygon): boolean {
  if (!polygon[0] || !pointInRing(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(point, polygon[i]!)) return false;
  return true;
}

/** Area-weighted centre of a polygon's outer ring. Falls back to the mean of its points. */
export function centroid(polygon: Polygon): [number, number] {
  const ring = polygon[0] ?? [];
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    const cross = a[0] * b[1] - b[0] * a[1];
    area += cross;
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    const n = Math.max(1, ring.length);
    return [ring.reduce((sum, p) => sum + p[0], 0) / n, ring.reduce((sum, p) => sum + p[1], 0) / n];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

/** Distance from a point to the nearest segment of a line. */
export function distanceToLine(point: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t)));
  }
  return line.length === 1 ? distance(point, line[0]!) : best;
}
