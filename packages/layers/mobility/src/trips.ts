// The mobility datasets and the maths of playing them. No DOM and no SDK runtime, so it runs in tests.
// The formats are described in ../README.md.

export type LonLat = [lon: number, lat: number];
type Distance = (a: readonly number[], b: readonly number[]) => number;

export interface Group {
  id: string;
  label: string;
  color: string;
}

export interface Leg {
  /** Seconds after the start of the dataset at which the leg begins. */
  start: number;
  duration: number;
  coordinates: LonLat[];
  /** How far along the leg each coordinate is, 0..1 by distance. */
  stations: number[];
}

export interface Trip {
  group: number;
  legs: Leg[];
}

export interface Trips {
  title: string | null;
  /** Seconds the dataset spans. */
  duration: number;
  groups: Group[];
  destination: { label: string | null; coordinates: LonLat } | null;
  trips: Trip[];
}

/** Colours for groups that do not bring their own: the table palette's categories (#93), resolved when drawn. */
const GROUP_COLOURS = ['@cat1', '@cat2', '@cat3', '@cat4', '@cat5', '@cat6', '@cat7', '@cat8'];

const isPoint = (p: unknown): p is number[] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * Checks a trips dataset and prepares it for playback. Legs that cannot be
 * drawn are dropped rather than failing the whole dataset.
 */
export function prepareTrips(raw: any, distance: Distance): Trips {
  if (!raw || !Array.isArray(raw.trips)) throw new Error('a trips dataset needs a "trips" list');
  const groups: Group[] = [];
  const declared: any[] = Array.isArray(raw.groups) ? raw.groups : [];
  const groupIndex = (id: string) => {
    let index = groups.findIndex((g) => g.id === id);
    if (index < 0) {
      const spec = declared.find((g) => String(g?.id) === id);
      index = groups.push({ id, label: String(spec?.label ?? id), color: String(spec?.color ?? GROUP_COLOURS[groups.length % GROUP_COLOURS.length]) }) - 1;
    }
    return index;
  };
  // Declared groups come first and keep their order, so legends are stable.
  for (const g of declared) if (g?.id !== undefined) groupIndex(String(g.id));

  const trips: Trip[] = [];
  let end = 0;
  for (const item of raw.trips) {
    const legs: Leg[] = [];
    for (const leg of Array.isArray(item?.legs) ? item.legs : []) {
      const coordinates: LonLat[] = (Array.isArray(leg?.coordinates) ? leg.coordinates : []).filter(isPoint).map((p: number[]): LonLat => [p[0]!, p[1]!]);
      const [start, duration] = [Number(leg?.start), Number(leg?.duration)];
      if (coordinates.length < 2 || !Number.isFinite(start) || !(duration > 0)) continue;
      const along = [0];
      for (let i = 1; i < coordinates.length; i++) along.push(along[i - 1]! + distance(coordinates[i - 1]!, coordinates[i]!));
      const total = along[along.length - 1]!;
      legs.push({ start, duration, coordinates, stations: along.map((d, i) => (total > 0 ? d / total : i / (along.length - 1))) });
      end = Math.max(end, start + duration);
    }
    if (legs.length === 0) continue;
    legs.sort((a, b) => a.start - b.start);
    trips.push({ group: groupIndex(String(item.group ?? 'all')), legs });
  }
  const destination = isPoint(raw.destination?.coordinates)
    ? { label: raw.destination.label ? String(raw.destination.label) : null, coordinates: [raw.destination.coordinates[0], raw.destination.coordinates[1]] as LonLat }
    : null;
  const duration = Number(raw.duration) > 0 ? Number(raw.duration) : end;
  return { title: raw.title ? String(raw.title) : null, duration, groups, destination, trips };
}

export type TripState = 'home' | 'moving' | 'waiting' | 'arrived';

/**
 * Where a traveller is `time` seconds in. Before the first leg they are at home,
 * between legs they wait where the last one ended, and after the last they have arrived.
 */
export function positionAt(trip: Trip, time: number): { point: LonLat; state: TripState } {
  const first = trip.legs[0]!;
  if (time < first.start) return { point: first.coordinates[0]!, state: 'home' };
  let previous = first.coordinates[0]!;
  for (const leg of trip.legs) {
    if (time < leg.start) return { point: previous, state: 'waiting' };
    const { coordinates: c, stations: s } = leg;
    if (time < leg.start + leg.duration) {
      const fraction = (time - leg.start) / leg.duration;
      let lo = 0;
      let hi = s.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (s[mid]! <= fraction) lo = mid;
        else hi = mid;
      }
      const span = s[hi]! - s[lo]!;
      const u = span > 0 ? (fraction - s[lo]!) / span : 0;
      return { point: [c[lo]![0] + (c[hi]![0] - c[lo]![0]) * u, c[lo]![1] + (c[hi]![1] - c[lo]![1]) * u], state: 'moving' };
    }
    previous = c[c.length - 1]!;
  }
  return { point: previous, state: 'arrived' };
}

/** How many travellers of each group have arrived by `time`. */
export function arrivals(trips: Trips, time: number): number[] {
  const counts = trips.groups.map(() => 0);
  for (const trip of trips.trips) {
    const last = trip.legs[trip.legs.length - 1]!;
    if (time >= last.start + last.duration) counts[trip.group]!++;
  }
  return counts;
}

export interface Cell {
  /** Outer ring and holes. */
  rings: LonLat[][];
  /** One value per step; null where there is nothing to show. */
  values: (number | null)[];
}

export interface Cells {
  label: string | null;
  unit: string;
  /** Names of the steps, such as departure times. One step when the data does not change over time. */
  steps: string[];
  min: number;
  max: number;
  cells: Cell[];
}

/** Checks a cells dataset: GeoJSON polygons with `properties.values`, or a single `properties.value`. */
export function prepareCells(raw: any): Cells {
  if (!raw || !Array.isArray(raw.features)) throw new Error('a cells dataset needs GeoJSON features');
  const cells: Cell[] = [];
  let count = 0;
  let [low, high] = [Infinity, -Infinity];
  for (const feature of raw.features) {
    const g = feature?.geometry;
    const polygons: unknown[] = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    const properties = feature?.properties ?? {};
    const list: unknown[] = Array.isArray(properties.values) ? properties.values : [properties.value];
    const values = list.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    for (const v of values) {
      if (v === null) continue;
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
    count = Math.max(count, values.length);
    for (const polygon of polygons) {
      const rings = (polygon as number[][][]).map((ring) => ring.filter(isPoint).map((p): LonLat => [p[0]!, p[1]!])).filter((ring) => ring.length >= 3);
      if (rings.length > 0) cells.push({ rings, values });
    }
  }
  const meta = raw.metadata ?? {};
  const named: string[] = Array.isArray(meta.steps) ? meta.steps.map(String) : [];
  const steps = Array.from({ length: Math.max(1, count) }, (_, i) => named[i] ?? (count > 1 ? String(i + 1) : ''));
  const min = Number.isFinite(meta.min) ? Number(meta.min) : Number.isFinite(low) ? low : 0;
  const max = Number.isFinite(meta.max) ? Number(meta.max) : Number.isFinite(high) ? high : 1;
  return { label: meta.label ? String(meta.label) : null, unit: meta.unit ? String(meta.unit) : '', steps, min, max: max > min ? max : min + 1, cells };
}

/** The step shown at a position 0..1 through the dataset: the steps share the time evenly. */
export function stepAt(fraction: number, steps: number): number {
  return Math.min(steps - 1, Math.max(0, Math.floor(fraction * steps)));
}
