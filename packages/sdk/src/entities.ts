// Entities (#279): things on the table a visitor picks and changes one by one. The shapes are in
// types.ts (`EntitySet`); these helpers read a set's values from params, list a dataset's
// entities and find the one under a point. The runtime uses them for the table's picking and the
// controller's inspector; a layer uses `entityValues` to read what was set.

import { formatDecimal, formatUnit } from './format.ts';
import type { EntityChange, EntityFact, EntityLog, EntitySet, Params, Position, ToolGeometry } from './types.ts';

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

/**
 * A feature property by name, or by a dotted path into nested properties (#373): `ecom.name`
 * reads `properties.ecom.name`. A property whose own name has a dot (`"ecom.name"`) wins.
 */
export function propertyAt(properties: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!properties) return undefined;
  if (path in properties || !path.includes('.')) return properties[path];
  let value: unknown = properties;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** The entities of a set in its dataset, in the dataset's order. Features without a key are left out. */
export function entityFeatures(collection: Collection, set: Pick<EntitySet, 'key' | 'label' | 'group' | 'facts'>): EntityFeature[] {
  const out: EntityFeature[] = [];
  const seen = new Set<string>();
  for (const [index, feature] of (collection.features ?? []).entries()) {
    const key = set.key === '#' ? index + 1 : propertyAt(feature.properties, set.key);
    if ((typeof key !== 'string' && typeof key !== 'number') || !feature.geometry) continue;
    const id = String(key);
    if (seen.has(id)) continue;
    seen.add(id);
    const label = set.label === '#' ? undefined : propertyAt(feature.properties, set.label ?? set.key);
    const group = set.group ? propertyAt(feature.properties, set.group) : undefined;
    out.push({
      id,
      label: typeof label === 'string' || typeof label === 'number' ? String(label) : id,
      group: typeof group === 'string' || typeof group === 'number' ? String(group) : undefined,
      // The name is on show already, so it is not repeated among the facts.
      ...(set.facts?.length ? { facts: factsOf(feature.properties ?? {}, set.facts.filter((c) => factColumn(c) !== set.label)) } : {}),
      geometry: feature.geometry as EntityFeature['geometry'],
    });
  }
  return out;
}

/** The column a fact reads. */
export function factColumn(fact: string | EntityFact): string {
  return typeof fact === 'string' ? fact : fact.column;
}

/** A number as a person reads it, in the visitors' language (#397): thousands grouped, at most two decimals. */
function readable(value: unknown, fact?: EntityFact): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const v = value * (fact?.scale ?? 1);
    let decimals = fact?.decimals;
    if (decimals === undefined) {
      // Up to two decimals, and no trailing zeros: 0.5 reads "0.5".
      decimals = String(Number(v.toFixed(2))).split('.')[1]?.length ?? 0;
    }
    return fact?.unit ? formatUnit(v, fact.unit, decimals) : formatDecimal(v, decimals);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return null;
  return String(value);
}

/**
 * The facts of one feature, in the set's order; empty values are left out. A fact given as a
 * column has its name tidied (`floor_area` reads "Floor area"); one given as an object reads its
 * own label and unit (#410).
 */
export function factsOf(properties: Record<string, unknown>, facts: readonly (string | EntityFact)[]): [string, string][] {
  const out: [string, string][] = [];
  for (const fact of facts) {
    const column = factColumn(fact);
    if (!column || column === '#') continue;
    const detail = typeof fact === 'string' ? undefined : fact;
    const value = readable(propertyAt(properties, column), detail);
    const label = detail?.label?.trim() || (column.split('.').pop() ?? column).replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    if (value !== null) out.push([label, value]);
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

/** One layer of a log (#602), from a depth to a depth. */
export interface LogLayer {
  from: number;
  to: number;
  material: string;
  note?: string;
}

/**
 * The layers of one entity's log, from the top down: the rows of `collection` whose key column is
 * `id`, with a material and a thickness. Rows sharing a top are kept once (the deepest wins).
 */
export function logLayers(collection: Collection, log: EntityLog, id: string): LogLayer[] {
  const out: LogLayer[] = [];
  for (const feature of collection.features ?? []) {
    const p = feature.properties ?? {};
    const key = propertyAt(p, log.key);
    if (key === undefined || key === null || String(key) !== id) continue;
    const from = Number(propertyAt(p, log.from));
    const to = Number(propertyAt(p, log.to));
    const material = String(propertyAt(p, log.material) ?? '').trim();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !material) continue;
    const note = log.note ? String(propertyAt(p, log.note) ?? '').trim() : '';
    out.push({ from, to, material, ...(note ? { note } : {}) });
  }
  out.sort((a, b) => a.from - b.from || b.to - a.to);
  return out.filter((layer, i) => i === 0 || layer.from !== out[i - 1]!.from);
}

/** Earth colours for the materials a log names, in Swedish or English; anything else gets a steady colour of its own. */
const MATERIALS: [RegExp, string][] = [
  [/berg|rock|granit|gnejs|gneiss|bedrock/i, '#8a8f99'],
  [/fyll|fill|made/i, '#b59a7a'],
  [/lera|clay|silt|gyttja/i, '#7f9bb0'],
  [/sand|grus|gravel/i, '#d9bf73'],
  [/mor[äa]n|till/i, '#9c9c5e'],
  [/torv|peat|mull|humus|organic/i, '#6b5440'],
  [/sten|block|stone|boulder/i, '#a88f6a'],
  [/jord|soil/i, '#a07850'],
  [/vatten|water/i, '#5aa0d0'],
];
const OTHERS = ['#c08a5a', '#8fa26a', '#b07090', '#6f8fb0', '#c0a050', '#7a9a8a'];

/** The colour a log draws a material in. */
export function materialColour(material: string): string {
  for (const [pattern, colour] of MATERIALS) if (pattern.test(material)) return colour;
  let hash = 0;
  for (const c of material) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return OTHERS[hash % OTHERS.length]!;
}
