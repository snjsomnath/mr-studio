// Entities (#279): things on the table a visitor picks and changes one by one. The shapes are in
// types.ts (`EntitySet`); these helpers read a set's values from params, list a dataset's
// entities and find the one under a point. The runtime uses them for the table's picking and the
// controller's inspector; a layer uses `entityValues` to read what was set.

import type { EntityChange, EntitySet, Params, Position, ToolGeometry } from './types.ts';

/** `params.entities` as the host keeps it: set, then entity, then control. Only changed values are there. */
export type EntityOverrides = Record<string, Record<string, Record<string, unknown>>>;

/** The overrides kept for every entity of one set. */
export function entityOverrides(params: Params | undefined, set: string): Record<string, Record<string, unknown>> {
  const all = (params?.entities ?? {}) as EntityOverrides;
  const of = all[set];
  return of && typeof of === 'object' ? of : {};
}

/** One entity's values: each control's default, with what was set for it on top. */
export function entityValues(set: EntitySet, params: Params | undefined, id: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const control of set.controls) values[control.id] = control.default;
  return Object.assign(values, entityOverrides(params, set.id)[id] ?? {});
}

/** Which entities' values differ between two params, by set. Empty when none did. */
export function entityChanges(before: Params | undefined, after: Params | undefined): EntityChange[] {
  const a = (before?.entities ?? {}) as EntityOverrides;
  const b = (after?.entities ?? {}) as EntityOverrides;
  const changes: EntityChange[] = [];
  for (const set of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[set] ?? {};
    const y = b[set] ?? {};
    const ids = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((id) => JSON.stringify(x[id] ?? {}) !== JSON.stringify(y[id] ?? {}));
    if (ids.length > 0) changes.push({ set, ids });
  }
  return changes;
}

/** One entity of a dataset: its id, what it is called, its group and its shape. */
export interface EntityFeature {
  id: string;
  label: string;
  group?: string;
  /** The set's facts for this entity, as name and value, when the set has `facts`. */
  facts?: [string, string][];
  geometry: ToolGeometry | { type: 'MultiPolygon'; coordinates: Position[][][] } | { type: 'MultiLineString'; coordinates: Position[][] };
}

interface Collection {
  features?: { properties?: Record<string, unknown> | null; geometry?: { type: string; coordinates: unknown } | null }[];
}

/** The entities of a set in its dataset, in the dataset's order. Features without a key are left out. */
export function entityFeatures(collection: Collection, set: Pick<EntitySet, 'key' | 'label' | 'group' | 'facts'>): EntityFeature[] {
  const out: EntityFeature[] = [];
  const seen = new Set<string>();
  for (const [index, feature] of (collection.features ?? []).entries()) {
    const key = set.key === '#' ? index + 1 : feature.properties?.[set.key];
    if ((typeof key !== 'string' && typeof key !== 'number') || !feature.geometry) continue;
    const id = String(key);
    if (seen.has(id)) continue;
    seen.add(id);
    const label = set.label === '#' ? undefined : feature.properties?.[set.label ?? set.key];
    const group = set.group ? feature.properties?.[set.group] : undefined;
    out.push({
      id,
      label: typeof label === 'string' || typeof label === 'number' ? String(label) : id,
      group: typeof group === 'string' || typeof group === 'number' ? String(group) : undefined,
      // The name is on show already, so it is not repeated among the facts.
      ...(set.facts?.length ? { facts: factsOf(feature.properties ?? {}, set.facts.filter((c) => c !== set.label)) } : {}),
      geometry: feature.geometry as EntityFeature['geometry'],
    });
  }
  return out;
}

/** A number as a person reads it: thousands grouped, at most two decimals. */
function readable(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString('en-GB') : value.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return null;
  return String(value);
}

/** The facts of one feature, in the set's order; empty values are left out. Names are tidied: `floor_area` reads "Floor area". */
export function factsOf(properties: Record<string, unknown>, columns: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const column of columns) {
    if (column === '#') continue;
    const value = readable(properties[column]);
    if (value !== null) out.push([column.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()), value]);
  }
  return out;
}

const METRES_PER_DEGREE = 111_320;

/** Distance in metres from `p` to the segment a-b, on a local flat projection. */
function segmentDistance(p: Position, a: Position, b: Position): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) * METRES_PER_DEGREE;
}

function inRing(p: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(p: Position, rings: Position[][]): boolean {
  return rings.length > 0 && inRing(p, rings[0]!) && !rings.slice(1).some((hole) => inRing(p, hole));
}

/** How far `p` is from a feature in metres: 0 inside an area. */
export function entityDistance(feature: Pick<EntityFeature, 'geometry'>, p: Position): number {
  const g = feature.geometry;
  const lines = (paths: Position[][]) => {
    let best = Infinity;
    for (const path of paths) {
      if (path.length === 1) best = Math.min(best, segmentDistance(p, path[0]!, path[0]!));
      for (let i = 1; i < path.length; i++) best = Math.min(best, segmentDistance(p, path[i - 1]!, path[i]!));
    }
    return best;
  };
  switch (g.type) {
    case 'Point':
      return segmentDistance(p, g.coordinates, g.coordinates);
    case 'LineString':
      return lines([g.coordinates]);
    case 'MultiLineString':
      return lines(g.coordinates);
    case 'Polygon':
      return inPolygon(p, g.coordinates) ? 0 : lines(g.coordinates);
    case 'MultiPolygon':
      return g.coordinates.some((polygon) => inPolygon(p, polygon)) ? 0 : lines(g.coordinates.flat());
  }
}

/**
 * The entity under a point in WGS84: the area it is in, or else the nearest point or line
 * within `tolerance_m` (default 12 m, about a fingertip on a 1:1000 table). Null when none is.
 */
export function pickEntity(features: readonly EntityFeature[], at: Position, tolerance_m = 12): EntityFeature | null {
  let best: EntityFeature | null = null;
  let distance = tolerance_m;
  for (const feature of features) {
    const d = entityDistance(feature, at);
    if (d === 0) return feature;
    if (d <= distance) {
      distance = d;
      best = feature;
    }
  }
  return best;
}
