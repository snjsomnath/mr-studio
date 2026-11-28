import type { SiteInfo } from '@mrstudio/sdk';


/**
 * The signature opening (#697): the place builds itself on a dark table. Streets trace in as
 * light lines from the middle of the site outwards, then the buildings fill in, then the trees,
 * and the dark lifts as the layers at rest fade in. It is drawn from the table's own streets,
 * buildings and trees, so every table has one without authoring. 2D, top down.
 */

type Position = [number, number];

export interface Opening {
  /** Each street as a line, with the part of the build (0 to 1) at which it starts tracing. */
  streets: { line: Position[]; at: number }[];
  buildings: { ring: Position[]; at: number }[];
  trees: { point: Position; at: number }[];
}

/** The build's phases, as parts of its length. The dark lifts over the last part. */
export const PHASES = {
  streets: [0, 0.45],
  buildings: [0.3, 0.7],
  trees: [0.55, 0.8],
  lift: [0.72, 1],
} as const;

/** How long the build lasts. */
export const DEFAULT_LENGTH_MS = 6000;

/** Features drawn at most of each kind, so a city stays smooth on the studio projector. */
const MOST = 6000;

type Geometry = { type: string; coordinates: unknown } | null | undefined;

function linesOf(geometry: Geometry): Position[][] {
  if (!geometry) return [];
  const c = geometry.coordinates as never;
  switch (geometry.type) {
    case 'LineString':
      return [c];
    case 'MultiLineString':
    case 'Polygon':
      return c;
    case 'MultiPolygon':
      return (c as Position[][][]).map((polygon) => polygon[0]!).filter(Boolean);
    default:
      return [];
  }
}

function pointsOf(geometry: Geometry): Position[] {
  if (!geometry) return [];
  if (geometry.type === 'Point') return [geometry.coordinates as Position];
  if (geometry.type === 'MultiPoint') return geometry.coordinates as Position[];
  return [];
}

/**
 * Orders the site's features by how far they are from the middle, as a part of the phase they
 * belong to: the nearest starts first. Distances are in degrees scaled by latitude, which is
 * plenty for an order.
 */
export function planOpening(
  centre: Position,
  data: { streets: Geometry[]; buildings: Geometry[]; trees: Geometry[] },
): Opening {
  const k = Math.cos((centre[1] * Math.PI) / 180);
  const away = (p: Position) => Math.hypot((p[0] - centre[0]) * k, p[1] - centre[1]);
  const nearest = (line: Position[]) => Math.min(...line.map(away));
  const middle = (ring: Position[]) => away([ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length]);
  // A street traces outwards from its point nearest the middle: a long one is two halves.
  const outwards = (line: Position[]): Position[][] => {
    let i = 0;
    line.forEach((p, j) => (away(p) < away(line[i]!) ? (i = j) : 0));
    return [line.slice(0, i + 1).reverse(), line.slice(i)].filter((half) => half.length > 1);
  };
  const streets = data.streets
    .flatMap(linesOf)
    .filter((l) => l.length > 1)
    .slice(0, MOST)
    .flatMap(outwards)
    .map((line) => ({ line, d: nearest(line) }));
  const buildings = data.buildings
    .flatMap((g) => (g?.type === 'Polygon' ? [linesOf(g)[0]!] : g?.type === 'MultiPolygon' ? linesOf(g) : []))
    .filter((r) => r && r.length > 2)
    .slice(0, MOST)
    .map((ring) => ({ ring, d: middle(ring) }));
  const trees = data.trees.flatMap(pointsOf).slice(0, MOST).map((point) => ({ point, d: away(point) }));
  const far = Math.max(1e-9, ...streets.map((s) => s.d), ...buildings.map((b) => b.d), ...trees.map((t) => t.d));
  return {
    streets: streets.map(({ line, d }) => ({ line, at: d / far })),
    buildings: buildings.map(({ ring, d }) => ({ ring, at: d / far })),
    trees: trees.map(({ point, d }) => ({ point, at: d / far })),
  };
}

/** How far along a feature starting at `at` of its phase is at time `t` (0 to 1 of the build). */
export function progress(t: number, phase: readonly [number, number], at: number, own = 0.35): number {
  const [from, to] = phase;
  const start = from + (to - from - own * (to - from)) * at;
  return Math.min(1, Math.max(0, (t - start) / (own * (to - from))));
}

/** How dark the table is under the drawing at time `t`: full until the lift, then gone. */
export function darkness(t: number): number {
  const [from, to] = PHASES.lift;
  return 1 - Math.min(1, Math.max(0, (t - from) / (to - from)));
}

/** Whether the opening has anything to build: a table without streets or buildings fades instead. */
export const hasShape = (opening: Opening): boolean => opening.streets.length + opening.buildings.length > 0;

/** Loads the table's streets, buildings and trees. A missing file is just left out. */
export async function loadOpening(site: SiteInfo): Promise<Opening> {
  const load = async (names: string[]): Promise<Geometry[]> => {
    const all = await Promise.all(
      names.map((name) => {
        const path = site.data?.[name];
        if (typeof path !== 'string') return Promise.resolve([]);
        return fetch(`/site/${path}`)
          .then((r) => (r.ok ? (r.json() as Promise<{ features?: { geometry: Geometry }[] }>) : { features: [] }))
          .then((c) => (Array.isArray(c.features) ? c.features.map((f) => f.geometry) : []))
          .catch(() => []);
      }),
    );
    return all.flat();
  };
  const [streets, buildings, trees] = await Promise.all([load(['roads', 'walkways']), load(['buildings']), load(['trees'])]);
  const [a, , b] = site.corners;
  const centre: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return planOpening(centre, { streets, buildings, trees });
}

const STREET = 'rgb(214 228 255)';
const BUILDING = 'rgb(201 211 230)';
const TREE = 'rgb(140 214 150)';

/** Draws the build at time `t` (0 to 1) on `context`, `project` turning a position into pixels. */
export function drawOpening(
  context: CanvasRenderingContext2D,
  size: { width: number; height: number },
  opening: Opening,
  project: (p: Position) => Position,
  t: number,
  pixelsPerMetre: number,
): void {
  context.clearRect(0, 0, size.width, size.height);
  const lift = darkness(t);
  context.fillStyle = `rgb(4 6 12 / ${lift})`;
  context.fillRect(0, 0, size.width, size.height);
  context.globalAlpha = Math.min(1, lift * 1.4);
  // Streets trace in: a line's drawn length grows with its progress.
  context.strokeStyle = STREET;
  context.lineWidth = Math.max(1, pixelsPerMetre * 1.5);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const street of opening.streets) {
    const p = progress(t, PHASES.streets, street.at);
    if (p <= 0) continue;
    const pts = street.line.map(project);
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    context.setLineDash(p >= 1 ? [] : [length * p, length + 1]);
    context.beginPath();
    pts.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.stroke();
  }
  context.setLineDash([]);
  // Buildings fill in.
  context.fillStyle = BUILDING;
  for (const building of opening.buildings) {
    const p = progress(t, PHASES.buildings, building.at);
    if (p <= 0) continue;
    context.globalAlpha = Math.min(1, lift * 1.4) * 0.6 * p;
    context.beginPath();
    building.ring.map(project).forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.closePath();
    context.fill();
  }
  // Trees pop in as dots.
  context.fillStyle = TREE;
  const r = Math.max(1.5, pixelsPerMetre * 2.5);
  for (const tree of opening.trees) {
    const p = progress(t, PHASES.trees, tree.at);
    if (p <= 0) continue;
    context.globalAlpha = Math.min(1, lift * 1.4) * p;
    const [x, y] = project(tree.point);
    context.beginPath();
    context.arc(x, y, r * (0.6 + 0.4 * p), 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
}
