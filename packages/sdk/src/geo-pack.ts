// GeoJSON read into table metres as flat typed arrays (#263). The work that used to stall the
// table, parsing a large file and moving every corner into table metres, happens here, in the
// data worker (geo-worker.ts) when the page has one. What comes back is a few typed arrays,
// which cross to the page without being copied, and one list of properties per feature.

import type { SiteInfo } from './types.ts';
import type { Placed, XY } from './table-space.ts';

/** Shapes of one kind: corners as x, y pairs in table metres, and where each part ends. */
export interface PackedShapes {
  /** x0, y0, x1, y1, ... in table metres. */
  coords: Float64Array;
  /** Polygons: the corner index each ring ends at. Lines: the corner index each line ends at. Points: unused (empty). */
  ends: Uint32Array;
  /** Polygons only: the ring index each polygon ends at. */
  parts: Uint32Array;
  /** Which feature (an index into `properties`) each polygon, line or point came from. */
  feature: Uint32Array;
}

export interface PackedGeometry {
  polygons: PackedShapes;
  lines: PackedShapes;
  points: PackedShapes;
  /** One per feature that had a shape, in file order. */
  properties: Record<string, any>[];
}

/** The part of a site the packing needs: where the table is in the world. */
export type SitePlacement = Pick<SiteInfo, 'corners' | 'extent'>;

class Grow<T extends Float64Array | Uint32Array> {
  data: T;
  length = 0;
  private readonly make: (n: number) => T;
  constructor(make: (n: number) => T) {
    this.make = make;
    this.data = make(1024);
  }
  push(value: number): void {
    if (this.length === this.data.length) {
      const bigger = this.make(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = value;
  }
  done(): T {
    return this.data.slice(0, this.length) as T;
  }
}

const floats = () => new Grow((n) => new Float64Array(n));
const counts = () => new Grow((n) => new Uint32Array(n));

/** Reads a GeoJSON document (text, bytes or already parsed) into table metres. */
export function packGeojson(source: string | ArrayBuffer | unknown, place: SitePlacement): PackedGeometry {
  const document = typeof source === 'string' ? JSON.parse(source) : source instanceof ArrayBuffer ? JSON.parse(new TextDecoder().decode(source)) : source;
  const { width_m: width, height_m: height } = place.extent;
  const [tl, tr, , bl] = place.corners;
  const [ax, ay, bx, by] = [tr[0] - tl[0], tr[1] - tl[1], bl[0] - tl[0], bl[1] - tl[1]];
  const det = ax * by - ay * bx;
  const sx = width / det;
  const sy = height / det;

  const shapes = () => ({ coords: floats(), ends: counts(), parts: counts(), feature: counts() });
  const [polygons, lines, points] = [shapes(), shapes(), shapes()];
  const properties: Record<string, any>[] = [];
  const corner = (into: ReturnType<typeof shapes>, c: number[]) => {
    const dx = c[0]! - tl[0];
    const dy = c[1]! - tl[1];
    into.coords.push((dx * by - dy * bx) * sx);
    into.coords.push((ax * dy - ay * dx) * sy);
  };

  const list = !document ? [] : document.type === 'FeatureCollection' ? (document.features ?? []) : document.type === 'Feature' ? [document] : [];
  for (const feature of list) {
    const geometry = feature?.geometry;
    const type = geometry?.type;
    const coordinates = geometry?.coordinates;
    if (!Array.isArray(coordinates)) continue;
    const index = properties.length;
    let used = false;
    if (type === 'Polygon' || type === 'MultiPolygon') {
      for (const rings of type === 'Polygon' ? [coordinates] : coordinates) {
        for (const ring of rings) {
          for (const c of ring) corner(polygons, c);
          polygons.ends.push(polygons.coords.length / 2);
        }
        polygons.parts.push(polygons.ends.length);
        polygons.feature.push(index);
        used = true;
      }
    } else if (type === 'LineString' || type === 'MultiLineString') {
      for (const line of type === 'LineString' ? [coordinates] : coordinates) {
        if (line.length < 2) continue;
        for (const c of line) corner(lines, c);
        lines.ends.push(lines.coords.length / 2);
        lines.feature.push(index);
        used = true;
      }
    } else if (type === 'Point' || type === 'MultiPoint') {
      for (const c of type === 'Point' ? [coordinates] : coordinates) {
        corner(points, c);
        points.feature.push(index);
        used = true;
      }
    }
    if (used) properties.push(feature.properties ?? {});
  }
  const finish = (s: ReturnType<typeof shapes>): PackedShapes => ({ coords: s.coords.done(), ends: s.ends.done(), parts: s.parts.done(), feature: s.feature.done() });
  return { polygons: finish(polygons), lines: finish(lines), points: finish(points), properties };
}

/** The typed arrays in a packed result, to hand to `postMessage` so they move instead of being copied. */
export function packedBuffers(packed: PackedGeometry): ArrayBuffer[] {
  return [packed.polygons, packed.lines, packed.points].flatMap((s) => [s.coords.buffer, s.ends.buffer, s.parts.buffer, s.feature.buffer]) as ArrayBuffer[];
}

/** Placed shapes, in the form `geojsonPolygons`, `geojsonLines` and `geojsonPoints` give. */
export interface SiteGeometry {
  polygons: Placed<XY[][]>[];
  lines: Placed<XY[]>[];
  points: Placed<XY>[];
}

/** Unpacks into fresh arrays of corners, so a layer can change them without touching another layer's copy. Properties are shared: read them, don't change them. */
export function unpackGeometry(packed: PackedGeometry): SiteGeometry {
  const { polygons: pg, lines: ln, points: pt, properties } = packed;
  const run = (coords: Float64Array, from: number, to: number): XY[] => {
    const out: XY[] = new Array(to - from);
    for (let i = from; i < to; i++) out[i - from] = [coords[i * 2]!, coords[i * 2 + 1]!];
    return out;
  };
  const polygons: Placed<XY[][]>[] = [];
  let ring = 0;
  for (let p = 0; p < pg.parts.length; p++) {
    const rings: XY[][] = [];
    for (; ring < pg.parts[p]!; ring++) rings.push(run(pg.coords, ring === 0 ? 0 : pg.ends[ring - 1]!, pg.ends[ring]!));
    polygons.push({ geometry: rings, properties: properties[pg.feature[p]!]! });
  }
  const lines: Placed<XY[]>[] = [];
  for (let l = 0; l < ln.ends.length; l++) lines.push({ geometry: run(ln.coords, l === 0 ? 0 : ln.ends[l - 1]!, ln.ends[l]!), properties: properties[ln.feature[l]!]! });
  const points: Placed<XY>[] = [];
  for (let i = 0; i < pt.feature.length; i++) points.push({ geometry: [pt.coords[i * 2]!, pt.coords[i * 2 + 1]!], properties: properties[pt.feature[i]!]! });
  return { polygons, lines, points };
}
