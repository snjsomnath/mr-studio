import type { ModelPoint, SiteInfo, TwinMesh } from '@mrstudio/sdk';

import type { Footprint } from './sun-shadows.ts';

/** A corner of the physical model that a person can find and point a marker at. */
export interface Landmark {
  point: ModelPoint;
  label: string;
  /** The twin's number for the building the corner is on, when it is on one. */
  building?: number;
}

const CORNERS: { name: string; right: number; up: number }[] = [
  { name: 'top left', right: -1, up: 1 },
  { name: 'top right', right: 1, up: 1 },
  { name: 'bottom right', right: 1, up: -1 },
  { name: 'bottom left', right: -1, up: -1 },
];

/** Table axes for a local point: metres to the right and up, as the table image is drawn. */
export function tableAxes(site: SiteInfo): (east: number, north: number) => [right: number, up: number] {
  const r = (site.grid.rotation_deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(r), Math.sin(r)];
  return (east, north) => [east * cos - north * sin, east * sin + north * cos];
}

/**
 * Proposes corners to calibrate against: the four corners of the model's base, and roof
 * corners of buildings chosen to be far apart and at different heights. A camera can only
 * be found from points that do not share one plane, which this mix guarantees.
 *
 * With the site's building footprints (#595) the roof corners are real corners of the
 * footprints, raised to the building's roof: the corners a person can find on the physical
 * model. Without them they come from the twin, whose roofs are steps of the height raster.
 */
export function proposeLandmarks(
  twin: TwinMesh,
  site: SiteInfo,
  roofCorners = 6,
  footprints: readonly Footprint[] | null = null,
  crossings = 6,
): Landmark[] {
  const axes = tableAxes(site);
  const at = (i: number): ModelPoint => [twin.positions[i * 3]!, twin.positions[i * 3 + 1]!, twin.positions[i * 3 + 2]!];
  const extreme = (vertices: number[], right: number, up: number): number => {
    let best = vertices[0]!;
    let bestScore = -Infinity;
    for (const i of vertices) {
      const [r, u] = axes(twin.positions[i * 3]!, twin.positions[i * 3 + 1]!);
      const score = r * right + u * up;
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    return best;
  };

  const ground: number[] = [];
  const roofs = new Map<number, number[]>();
  for (let i = 0; i < twin.kinds.length; i++) {
    if (twin.kinds[i] === 0) ground.push(i);
    else if (twin.kinds[i] === 1) {
      // Without footprints every roof piece (four vertices) stands for itself.
      const key = twin.buildings[i] || -(Math.floor(i / 4) + 1);
      let list = roofs.get(key);
      if (!list) roofs.set(key, (list = []));
      list.push(i);
    }
  }

  const landmarks: Landmark[] = [];
  if (ground.length > 0) {
    for (const corner of CORNERS) {
      landmarks.push({ point: at(extreme(ground, corner.right, corner.up)), label: `The ${corner.name} corner of the model's base` });
    }
  }
  const base = landmarks.length > 0 ? Math.min(...landmarks.map((l) => l.point[2])) : twin.minZ;

  let candidates = footprints && footprints.length > 0 ? footprintCorners(twin, site, footprints, roofs, base) : [];
  if (candidates.length < roofCorners) {
    // Each building offers the corners of its highest roof.
    candidates = [];
    for (const [building, vertices] of roofs) {
      const top = vertices.reduce((max, i) => Math.max(max, twin.positions[i * 3 + 2]!), -Infinity);
      const highest = vertices.filter((i) => twin.positions[i * 3 + 2]! > top - 0.1);
      for (const corner of CORNERS) {
        const point = at(extreme(highest, corner.right, corner.up));
        candidates.push({ building, point, label: `The ${corner.name} roof corner of the building ${Math.round(point[2] - base)} m tall, marked on the plan` });
      }
    }
  }

  // Farthest point first, with height counted three times over so the corners spread vertically too.
  const distance = (a: ModelPoint, b: ModelPoint) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] - b[2]) * 3);
  const chosen: Landmark[] = [...landmarks];
  for (let n = 0; n < roofCorners && candidates.length > 0; n++) {
    let best = 0;
    let bestScore = -Infinity;
    candidates.forEach((candidate, index) => {
      let score = chosen.length === 0 ? candidate.point[2] : Math.min(...chosen.map((c) => distance(c.point, candidate.point)));
      if (chosen.some((c) => c.building === candidate.building)) score *= 0.4;
      if (score > bestScore) [best, bestScore] = [index, score];
    });
    chosen.push(candidates.splice(best, 1)[0]!);
  }
  // Where the model's tiles meet (#651): exact on the physical table and spread over all of it.
  // The ones farthest from the corners already chosen come first.
  const seams = tileCrossings(twin, site, ground, roofs, footprints);
  const flat = (a: ModelPoint, b: ModelPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (let n = 0; n < crossings && seams.length > 0; n++) {
    let best = 0;
    let bestScore = -Infinity;
    seams.forEach((candidate, index) => {
      const score = Math.min(...chosen.map((c) => flat(c.point, candidate.point)));
      if (score > bestScore) [best, bestScore] = [index, score];
    });
    chosen.push(seams.splice(best, 1)[0]!);
  }
  return chosen;
}

/**
 * The points inside the table where four of the physical model's tiles meet (#651), from the
 * table's size and its tile size (`table.tile_cm`), at the ground's height there. A crossing
 * under a building is left out: its seams are hidden.
 */
export function tileCrossings(
  twin: TwinMesh,
  site: SiteInfo,
  ground: readonly number[],
  roofs: Map<number, number[]>,
  footprints: readonly Footprint[] | null = null,
): Landmark[] {
  const table = site.table;
  if (!table?.tile_cm || !table.width_cm || !table.height_cm || ground.length === 0) return [];
  const across = Math.round(table.width_cm / table.tile_cm);
  const down = Math.round(table.height_cm / table.tile_cm);
  // Only a table made of whole tiles has seams that line up with its edges.
  if (Math.abs(across * table.tile_cm - table.width_cm) > 0.5 || Math.abs(down * table.tile_cm - table.height_cm) > 0.5) return [];
  const { width_m, height_m } = site.extent;
  const r = (site.grid.rotation_deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(r), Math.sin(r)];
  // The inverse of tableAxes: metres right and up on the table to east and north.
  const local = (right: number, up: number): [number, number] => [right * cos + up * sin, -right * sin + up * cos];
  const clear = Math.max(3, 1.5 * (site.grid.cell_m || 0));
  const roofVertices = [...roofs.values()].flat();
  const out: Landmark[] = [];
  for (let i = 1; i < across; i++) {
    for (let j = 1; j < down; j++) {
      const [east, north] = local(-width_m / 2 + (i * width_m) / across, -height_m / 2 + (j * height_m) / down);
      const covered =
        roofVertices.some((v) => Math.hypot(twin.positions[v * 3]! - east, twin.positions[v * 3 + 1]! - north) < clear) ||
        (footprints ?? []).some((f) => f.rings.some((ring) => near(ring, east, north, clear)));
      if (covered) continue;
      let z = twin.minZ;
      let nearest = Infinity;
      for (const v of ground) {
        const d = Math.hypot(twin.positions[v * 3]! - east, twin.positions[v * 3 + 1]! - north);
        if (d < nearest) [nearest, z] = [d, twin.positions[v * 3 + 2]!];
      }
      out.push({
        point: [east, north, z],
        label: `Where the tiles meet, ${i} ${i === 1 ? 'tile' : 'tiles'} from the left and ${down - j} from the top, marked on the plan`,
      });
    }
  }
  return out;
}

/** The smallest turn (degrees) that counts as a corner, and the largest: a spike is no easier to find. */
const MIN_TURN_DEG = 35;
const MAX_TURN_DEG = 145;

/**
 * Corners of the footprints a person can find on the model: outward corners (a sharp tip, not
 * a notch) between two walls long enough to see, of buildings wholly on the table, at the
 * height of the building's roof in the twin. Buildings with no roof in the twin are left out.
 */
export function footprintCorners(
  twin: TwinMesh,
  site: SiteInfo,
  footprints: readonly Footprint[],
  roofs: Map<number, number[]>,
  base: number,
): Required<Landmark>[] {
  const axes = tableAxes(site);
  const { width_m, height_m } = site.extent;
  const margin = 0.02 * Math.min(width_m, height_m);
  const onTable = ([east, north]: [number, number]) => {
    const [right, up] = axes(east, north);
    return Math.abs(right) <= width_m / 2 - margin && Math.abs(up) <= height_m / 2 - margin;
  };
  // A wall shorter than this is too small to put a cross on reliably.
  const minWall = Math.max(3, 0.012 * Math.max(width_m, height_m));
  const tops = new Map<number, number>();
  for (const [building, vertices] of roofs) {
    if (building > 0) tops.set(building, vertices.reduce((max, i) => Math.max(max, twin.positions[i * 3 + 2]!), -Infinity));
  }

  const out: Required<Landmark>[] = [];
  for (const footprint of footprints) {
    const top = tops.get(footprint.number);
    const ring = simplify(footprint.rings[0] ?? [], minWall / 4);
    if (top === undefined || ring.length < 3 || !ring.every(onTable)) continue;
    // Counter-clockwise rings turn left at their outward corners.
    const turning = Math.sign(signedArea(ring));
    const centre = ring.reduce(([x, y], [e, n]) => [x + e / ring.length, y + n / ring.length], [0, 0]);
    const [cr, cu] = axes(centre[0], centre[1]);
    ring.forEach((point, i) => {
      const before = ring[(i - 1 + ring.length) % ring.length]!;
      const after = ring[(i + 1) % ring.length]!;
      const a: [number, number] = [point[0] - before[0], point[1] - before[1]];
      const b: [number, number] = [after[0] - point[0], after[1] - point[1]];
      const [la, lb] = [Math.hypot(...a), Math.hypot(...b)];
      if (la < minWall || lb < minWall) return;
      const cross = a[0] * b[1] - a[1] * b[0];
      if (Math.sign(cross) !== turning) return;
      const turn = (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)))) * 180) / Math.PI;
      if (turn < MIN_TURN_DEG || turn > MAX_TURN_DEG) return;
      const [r, u] = axes(point[0], point[1]);
      // The roof's height at the corner (the eaves of a pitched roof, not its ridge), from the
      // building's roof in the twin a few metres around it.
      const near = Math.max(3, minWall);
      let z = -Infinity;
      for (const i of roofs.get(footprint.number) ?? []) {
        if (Math.hypot(twin.positions[i * 3]! - point[0], twin.positions[i * 3 + 1]! - point[1]) <= near) z = Math.max(z, twin.positions[i * 3 + 2]!);
      }
      if (!Number.isFinite(z)) z = top;
      out.push({
        building: footprint.number,
        point: [point[0], point[1], z],
        label: `The ${side(r - cr, u - cu)} corner of the roof of the building ${Math.round(z - base)} m tall, outlined on the plan`,
      });
    });
  }
  return out;
}

/** Whether a point is inside a ring or within `clear` metres of its edge. */
function near(ring: readonly [number, number][], x: number, y: number, clear: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    const [dx, dy] = [xi - xj, yi - yj];
    const t = Math.max(0, Math.min(1, ((x - xj) * dx + (y - yj) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(x - xj - t * dx, y - yj - t * dy) < clear) return true;
  }
  return inside;
}

/** Which corner of a building a point is, from the building's middle, as the table is seen. */
function side(right: number, up: number): string {
  const vertical = up >= 0 ? 'top' : 'bottom';
  const horizontal = right >= 0 ? 'right' : 'left';
  if (Math.abs(up) < 0.4 * Math.abs(right)) return horizontal;
  if (Math.abs(right) < 0.4 * Math.abs(up)) return vertical;
  return `${vertical} ${horizontal}`;
}

/** Twice the ring's area, positive when it runs counter-clockwise. */
function signedArea(ring: readonly [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/**
 * The ring without its closing repeat, near-duplicate points and points that hardly bend it,
 * so a wall drawn in several pieces counts as one.
 */
function simplify(ring: readonly [number, number][], tolerance: number): [number, number][] {
  let points = ring.slice();
  if (points.length > 1 && points[0]![0] === points.at(-1)![0] && points[0]![1] === points.at(-1)![1]) points.pop();
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let i = 0; i < points.length && points.length > 3; i++) {
      const before = points[(i - 1 + points.length) % points.length]!;
      const point = points[i]!;
      const after = points[(i + 1) % points.length]!;
      const [dx, dy] = [after[0] - before[0], after[1] - before[1]];
      const length = Math.hypot(dx, dy);
      // How far the point is off the line from its neighbours, or from the one before when they meet.
      const off = length < 1e-9 ? Math.hypot(point[0] - before[0], point[1] - before[1]) : Math.abs(dx * (point[1] - before[1]) - dy * (point[0] - before[0])) / length;
      if (off < tolerance || Math.hypot(point[0] - before[0], point[1] - before[1]) < tolerance) {
        points = [...points.slice(0, i), ...points.slice(i + 1)];
        changed = true;
        i--;
      }
    }
  }
  return points;
}
