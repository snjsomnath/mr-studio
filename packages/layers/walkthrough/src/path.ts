// The walk a video was filmed along (#194): a GeoJSON line, or points in the order they were
// walked, turned into a path in table metres that says where the walker was at any second.

export type XY = [number, number];

type Data = { data?: Record<string, string> };

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const PATH_NAME = /path|route|walk|movement|track|trail/i;

/** The video's dataset: the one named, or the table's first video. */
export function videoDataset(site: Data, named: string): string | null {
  if (named) return named;
  return Object.entries(site.data ?? {}).find(([, path]) => VIDEO_EXT.test(String(path)))?.[0] ?? null;
}

/** The walk's dataset: the one named, or the table's first GeoJSON named like a path or a route. */
export function pathDataset(site: Data, named: string): string | null {
  if (named) return named;
  return Object.entries(site.data ?? {}).find(([name, path]) => PATH_NAME.test(name) && /\.(geo)?json$/i.test(String(path)))?.[0] ?? null;
}

/** A walk in table metres, with the second of the video at each point. */
export interface Walk {
  points: XY[];
  /** Seconds into the video at each point; rising. */
  times: number[];
  /** Metres along the walk at each point. */
  along: number[];
  /** Whether the file gave the times, or they are spread by distance over the video. */
  timed: boolean;
}

/** The second of a point from its properties: `t`, `time`, `seconds` or `timestamp` (seconds or ISO). */
function timeOf(properties: Record<string, unknown> | undefined): number | null {
  for (const key of ['t', 'time', 'seconds', 'second', 'timestamp']) {
    const v = properties?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
      const date = Date.parse(v);
      if (Number.isFinite(date)) return date / 1000;
    }
  }
  return null;
}

function featuresOf(geojson: any): any[] {
  if (!geojson) return [];
  if (geojson.type === 'FeatureCollection') return geojson.features ?? [];
  if (geojson.type === 'Feature') return [geojson];
  if (geojson.type) return [{ type: 'Feature', geometry: geojson, properties: {} }];
  return [];
}

/**
 * The walk's lon/lat points and their times, if the file has them. A line's times come from
 * `properties.times` (or `timestamps`), one per vertex; points carry their own time, or are walked
 * in file order. Several lines are walked one after another.
 */
export function walkOf(geojson: unknown): { lonLat: XY[]; times: number[] | null } {
  const lonLat: XY[] = [];
  const times: (number | null)[] = [];
  for (const feature of featuresOf(geojson)) {
    const g = feature?.geometry;
    const props = feature?.properties ?? {};
    const lines: number[][][] = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      const given = props.times ?? props.timestamps;
      line.forEach((c, k) => {
        if (!Array.isArray(c) || c.length < 2) return;
        lonLat.push([c[0]!, c[1]!]);
        const t = Array.isArray(given) ? timeOf({ t: given[k] }) : null;
        times.push(t);
      });
    }
    if (g?.type === 'Point' && Array.isArray(g.coordinates)) {
      lonLat.push([g.coordinates[0], g.coordinates[1]]);
      times.push(timeOf(props));
    }
  }
  const allTimed = times.length > 1 && times.every((t) => t !== null);
  if (!allTimed) return { lonLat, times: null };
  // Points with times are walked in time order, from the first.
  const order = lonLat.map((_, k) => k).sort((a, b) => times[a]! - times[b]!);
  const start = times[order[0]!]!;
  return { lonLat: order.map((k) => lonLat[k]!), times: order.map((k) => times[k]! - start) };
}

/** A walk in table metres; without times the walker keeps an even pace over `duration` seconds. */
export function makeWalk(points: XY[], times: number[] | null, duration: number): Walk {
  const along = [0];
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1]!;
    const [bx, by] = points[k]!;
    along.push(along[k - 1]! + Math.hypot(bx - ax, by - ay));
  }
  const total = along.at(-1) ?? 0;
  if (times && times.length === points.length) return { points, times, along, timed: true };
  const span = duration > 0 ? duration : 1;
  return { points, times: along.map((d) => (total > 0 ? (d / total) * span : 0)), along, timed: false };
}

/** Where the walker is at second `t`, and how far along the walk that is. */
export function walkAt(walk: Walk, t: number): { at: XY; along: number } {
  const { points, times, along } = walk;
  if (points.length === 0) return { at: [0, 0], along: 0 };
  if (t <= times[0]! || points.length === 1) return { at: points[0]!, along: 0 };
  const last = points.length - 1;
  if (t >= times[last]!) return { at: points[last]!, along: along[last]! };
  // Binary search for the stretch holding t.
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi]! - times[lo]!;
  const f = span > 0 ? (t - times[lo]!) / span : 0;
  const [ax, ay] = points[lo]!;
  const [bx, by] = points[hi]!;
  return { at: [ax + (bx - ax) * f, ay + (by - ay) * f], along: along[lo]! + (along[hi]! - along[lo]!) * f };
}

/** The way the walker faces at second `t`: towards where they will be a moment later. */
export function headingAt(walk: Walk, t: number): number | null {
  const ahead = walkAt(walk, t + 1.5).at;
  const behind = walkAt(walk, t - 0.5).at;
  const dx = ahead[0] - behind[0];
  const dy = ahead[1] - behind[1];
  return Math.hypot(dx, dy) > 0.2 ? Math.atan2(dy, dx) : null;
}

/**
 * The second the video is at, from the shared play state. A playing video has moved on
 * since `at` by the time passed since `since`; a looping one starts again at its end.
 */
export function videoTime(state: { playing: boolean; at: number; since: number }, now: number, duration: number, loop: boolean): number {
  let t = state.at + (state.playing ? Math.max(0, now - state.since) / 1000 : 0);
  if (duration > 0) t = loop ? ((t % duration) + duration) % duration : Math.min(t, duration);
  return Math.max(0, t);
}

/** "1:05", "12:30". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
