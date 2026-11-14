import type { Position, SiteInfo } from './types.ts';

const A = 6_378_137;
const E2 = 0.006_694_379_990_14;

/** Conversions between WGS84, the site's local metres and its grid. */
export interface SiteProjection {
  /** `[lon, lat]` to metres east and north of the site origin. */
  toLocal(lonLat: readonly number[]): [east: number, north: number];
  toLonLat(east: number, north: number): [lon: number, lat: number];
  /** `[lon, lat]` to fractional grid `[col, row]`. Cell `(c, r)` spans `c..c+1`, `r..r+1`; row 0 is the top. */
  toGrid(lonLat: readonly number[]): [col: number, row: number];
  /** Ground distance in metres between two `[lon, lat]` points. */
  distance(a: readonly number[], b: readonly number[]): number;
}

/**
 * The site's tangent-plane projection, the same one the host bakes the scene with
 * (docs/contracts/engine.md, "Coordinates and the grid").
 */
export function siteProjection(site: Pick<SiteInfo, 'origin' | 'grid'>): SiteProjection {
  const phi = (site.origin.lat * Math.PI) / 180;
  const s = 1 - E2 * Math.sin(phi) ** 2;
  const perLon = ((A / Math.sqrt(s)) * Math.cos(phi) * Math.PI) / 180;
  const perLat = (((A * (1 - E2)) / s ** 1.5) * Math.PI) / 180;
  const { width, height, cell_m, rotation_deg } = site.grid;
  const r = (rotation_deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(r), Math.sin(r)];
  const toLocal = (p: readonly number[]): [number, number] => [(p[0]! - site.origin.lon) * perLon, (p[1]! - site.origin.lat) * perLat];
  return {
    toLocal,
    toLonLat: (east, north) => [site.origin.lon + east / perLon, site.origin.lat + north / perLat],
    toGrid(p) {
      const [east, north] = toLocal(p);
      const right = east * cos - north * sin;
      const up = east * sin + north * cos;
      return [right / cell_m + width / 2, height / 2 - up / cell_m];
    },
    distance(a, b) {
      const [ax, ay] = toLocal(a);
      const [bx, by] = toLocal(b);
      return Math.hypot(bx - ax, by - ay);
    },
  };
}

// The table is a rectangle on a tangent plane, so across a site longitude and latitude
// are linear in table coordinates. These two functions are the whole mapping, for every
// input that points at the table: a phone's map, touch.

/** Table coordinates (0..1 from the top left corner, u to the right, v down) to WGS84. */
export function tableToLonLat(site: Pick<SiteInfo, 'corners'>, u: number, v: number): Position {
  const [topLeft, topRight, , bottomLeft] = site.corners;
  return [
    topLeft[0] + u * (topRight[0] - topLeft[0]) + v * (bottomLeft[0] - topLeft[0]),
    topLeft[1] + u * (topRight[1] - topLeft[1]) + v * (bottomLeft[1] - topLeft[1]),
  ];
}

/** WGS84 to table coordinates. Outside the table the result is outside 0..1. */
export function lonLatToTable(site: Pick<SiteInfo, 'corners'>, lon: number, lat: number): [number, number] {
  const [topLeft, topRight, , bottomLeft] = site.corners;
  const ax = topRight[0] - topLeft[0];
  const ay = topRight[1] - topLeft[1];
  const bx = bottomLeft[0] - topLeft[0];
  const by = bottomLeft[1] - topLeft[1];
  const x = lon - topLeft[0];
  const y = lat - topLeft[1];
  const det = ax * by - bx * ay;
  return [(x * by - bx * y) / det, (ax * y - x * ay) / det];
}
