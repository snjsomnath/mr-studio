import type { Position, SiteInfo } from './types.ts';

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
