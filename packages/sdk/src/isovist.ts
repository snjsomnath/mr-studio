// Isovist (#190): what a person standing at one point can see, cast as rays against the
// building footprints and the tree crowns of a site, in table metres. A port of the Chalmers
// demo's isovist-core.js (180 rays, 200 m, a 120° human field of view or all round, trees
// optional), as a block any layer can use: the isovist layer draws it, and its share of
// trees (the green view factor) mixes the soundscape and feeds the controller.

import type { Point } from './blocks/geo.ts';
import type { XY } from './table-space.ts';

/** A building footprint: rings in table metres, outer first. */
export interface ViewBuilding {
  rings: XY[][];
  /** What kind of building it is (the demo's `objekttyp`), for the view's breakdown. */
  type: string;
}

/** A tree crown: a circle in table metres. */
export interface ViewTree {
  x: number;
  y: number;
  r: number;
}

export interface ViewScene {
  readonly buildings: readonly ViewBuilding[];
  readonly trees: readonly ViewTree[];
  /** Indices of the buildings and trees whose boxes touch a grid cell. */
  readonly cell: number;
  readonly buildingCells: Map<string, number[]>;
  readonly treeCells: Map<string, number[]>;
  /** Each building's box: min x, min y, max x, max y. */
  readonly boxes: Float64Array;
}

export interface ViewOptions {
  /** How far the eye reaches, in metres. Default 200. */
  radius_m?: number;
  /** The field of view in degrees; 360 for all round. Default 120. */
  fov_deg?: number;
  /** The direction the person faces, in radians in table space (0 = right, π/2 = down). */
  heading?: number;
  /** Rays cast across the field of view. Default 180. */
  rays?: number;
  /** Whether tree crowns block the view. Default true. */
  trees?: boolean;
}

export type RayHit = 'open' | 'building' | 'tree';

export interface Ray {
  angle: number;
  dist: number;
  hit: RayHit;
  /** The building or tree it stopped at, else -1. */
  index: number;
}

export interface ViewStats {
  /** Rays cast. */
  rays: number;
  open: number;
  trees: number;
  buildings: number;
  /** Building rays by building type. */
  byType: Record<string, number>;
  /** Share of rays that end in a tree crown: the green view factor, 0 to 1. */
  gvf: number;
  /** Share of rays that reach the edge of sight. */
  openShare: number;
  /** How many different buildings and trees are seen. */
  seenBuildings: number;
  seenTrees: number;
}

export interface Isovist {
  origin: XY;
  /** The edge of what is seen, in table metres. Starts and ends at the origin for a cone. */
  polygon: XY[];
  rays: Ray[];
  seenBuildings: number[];
  seenTrees: number[];
  stats: ViewStats;
}

const key = (x: number, y: number) => `${x},${y}`;

function visit(cell: number, minX: number, minY: number, maxX: number, maxY: number, fn: (k: string) => void): void {
  for (let x = Math.floor(minX / cell); x <= Math.floor(maxX / cell); x++) {
    for (let y = Math.floor(minY / cell); y <= Math.floor(maxY / cell); y++) fn(key(x, y));
  }
}

function add(cells: Map<string, number[]>, k: string, i: number): void {
  const list = cells.get(k);
  if (list) list.push(i);
  else cells.set(k, [i]);
}

/** Indexes buildings and trees once, so each view only looks at what is near. */
export function viewScene(buildings: readonly ViewBuilding[], trees: readonly ViewTree[], cell = 40): ViewScene {
  const buildingCells = new Map<string, number[]>();
  const treeCells = new Map<string, number[]>();
  const boxes = new Float64Array(buildings.length * 4);
  buildings.forEach((b, i) => {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of b.rings) {
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    boxes.set([minX, minY, maxX, maxY], i * 4);
    if (Number.isFinite(minX)) visit(cell, minX, minY, maxX, maxY, (k) => add(buildingCells, k, i));
  });
  trees.forEach((t, i) => visit(cell, t.x - t.r, t.y - t.r, t.x + t.r, t.y + t.r, (k) => add(treeCells, k, i)));
  return { buildings, trees, cell, buildingCells, treeCells, boxes };
}

function near(cells: Map<string, number[]>, cell: number, minX: number, minY: number, maxX: number, maxY: number): number[] {
  const found = new Set<number>();
  visit(cell, minX, minY, maxX, maxY, (k) => {
    for (const i of cells.get(k) ?? []) found.add(i);
  });
  return [...found];
}

/** Distance along a ray (unit direction dx, dy) to a segment, or Infinity. */
function raySegment(ox: number, oy: number, dx: number, dy: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const t = ((ax - ox) * ey - (ay - oy) * ex) / denom;
  const u = ((ax - ox) * dy - (ay - oy) * dx) / denom;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}

/** Distance along a ray to the near side of a circle, or Infinity. */
function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number {
  const fx = ox - cx;
  const fy = oy - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t1 = -b - s;
  if (t1 >= 0) return t1;
  // Standing under a crown, every ray meets its far side: the view is all leaves, as in the demo.
  const t2 = -b + s;
  return t2 >= 0 ? t2 : Infinity;
}

/** Whether a point is inside a building (outside its holes). */
export function insideBuilding(scene: ViewScene, [x, y]: Point): boolean {
  for (const i of near(scene.buildingCells, scene.cell, x, y, x, y)) {
    const b = i * 4;
    if (x < scene.boxes[b]! || y < scene.boxes[b + 1]! || x > scene.boxes[b + 2]! || y > scene.boxes[b + 3]!) continue;
    const rings = scene.buildings[i]!.rings;
    if (inRing(rings[0]!, x, y) && !rings.slice(1).some((hole) => inRing(hole, x, y))) return true;
  }
  return false;
}

function inRing(ring: XY[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The point itself when it is outside every building, else the nearest one outside (5 m rings, 16 directions). */
export function outsideBuildings(scene: ViewScene, point: Point, reach = 200): XY {
  if (!insideBuilding(scene, point)) return [point[0], point[1]];
  for (let r = 5; r <= reach; r += 5) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const p: XY = [point[0] + Math.cos(a) * r, point[1] + Math.sin(a) * r];
      if (!insideBuilding(scene, p)) return p;
    }
  }
  return [point[0], point[1]];
}

/** Casts the view from `origin`. */
export function isovist(scene: ViewScene, origin: Point, options: ViewOptions = {}): Isovist {
  const radius = Math.max(1, options.radius_m ?? 200);
  const fov = Math.min(360, Math.max(1, options.fov_deg ?? 120));
  const count = Math.max(8, Math.round(options.rays ?? 180));
  const all = fov >= 360 || options.heading === undefined;
  const span = all ? Math.PI * 2 : (fov * Math.PI) / 180;
  const start = all ? 0 : options.heading! - span / 2;
  const step = span / count;
  const [ox, oy] = origin;
  const withTrees = options.trees !== false;

  const buildings = near(scene.buildingCells, scene.cell, ox - radius, oy - radius, ox + radius, oy + radius);
  const trees = withTrees ? near(scene.treeCells, scene.cell, ox - radius, oy - radius, ox + radius, oy + radius) : [];

  const rays: Ray[] = [];
  // A full circle needs no ray at 2π: it is the ray at 0.
  const last = all ? count - 1 : count;
  for (let i = 0; i <= last; i++) {
    const angle = start + i * step;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let dist = radius;
    let hit: RayHit = 'open';
    let index = -1;
    for (const b of buildings) {
      for (const ring of scene.buildings[b]!.rings) {
        for (let j = 0; j < ring.length - 1; j++) {
          const t = raySegment(ox, oy, dx, dy, ring[j]![0], ring[j]![1], ring[j + 1]![0], ring[j + 1]![1]);
          if (t < dist) {
            dist = t;
            hit = 'building';
            index = b;
          }
        }
      }
    }
    for (const k of trees) {
      const tree = scene.trees[k]!;
      const t = rayCircle(ox, oy, dx, dy, tree.x, tree.y, tree.r);
      if (t < dist) {
        dist = t;
        hit = 'tree';
        index = k;
      }
    }
    rays.push({ angle, dist, hit, index });
  }

  const polygon: XY[] = rays.map((r) => [ox + Math.cos(r.angle) * r.dist, oy + Math.sin(r.angle) * r.dist]);
  if (all) polygon.push(polygon[0]!);
  else {
    polygon.unshift([ox, oy]);
    polygon.push([ox, oy]);
  }

  const seenBuildings = new Set<number>();
  const seenTrees = new Set<number>();
  const byType: Record<string, number> = {};
  let open = 0;
  let treeRays = 0;
  let buildingRays = 0;
  for (const r of rays) {
    if (r.hit === 'open') open++;
    else if (r.hit === 'tree') {
      treeRays++;
      seenTrees.add(r.index);
    } else {
      buildingRays++;
      seenBuildings.add(r.index);
      const type = scene.buildings[r.index]!.type || 'Unknown';
      byType[type] = (byType[type] ?? 0) + 1;
    }
  }
  const n = Math.max(1, rays.length);
  return {
    origin: [ox, oy],
    polygon,
    rays,
    seenBuildings: [...seenBuildings],
    seenTrees: [...seenTrees],
    stats: {
      rays: rays.length,
      open,
      trees: treeRays,
      buildings: buildingRays,
      byType,
      gvf: treeRays / n,
      openShare: open / n,
      seenBuildings: seenBuildings.size,
      seenTrees: seenTrees.size,
    },
  };
}

/** The crown radius of a tree the demo's way: a given crown, else 2 m plus 0.3 m per metre of height. */
export function crownRadius(properties: Record<string, unknown>, fallback_m?: number): number {
  const crown = Number(properties.crown_radius ?? properties.crown_radius_m);
  if (crown > 0) return crown;
  const height = Number(properties.height);
  if (height > 0) return Math.max(1, 2 + height * 0.3);
  return fallback_m ?? 3.5;
}

/**
 * One step of the demo's follow: a placed viewer stays put until the cursor is `threshold`
 * metres away, then closes `speed` of the gap per step (60 steps a second).
 */
export function follow(viewer: Point, cursor: Point, dt: number, threshold = 50, speed = 0.15): XY {
  const d = Math.hypot(cursor[0] - viewer[0], cursor[1] - viewer[1]);
  if (d <= threshold) return [viewer[0], viewer[1]];
  const k = 1 - (1 - speed) ** Math.max(0, dt * 60);
  return [viewer[0] + (cursor[0] - viewer[0]) * k, viewer[1] + (cursor[1] - viewer[1]) * k];
}

/** The compass bearing (degrees, 0 = north) of a direction in table space, for a table turned by `rotation_deg`. */
export function compassBearing(heading: number, rotation_deg: number): number {
  // Table x is right and y is down; turn that into east and north on the ground.
  const right = Math.cos(heading);
  const up = -Math.sin(heading);
  const r = (rotation_deg * Math.PI) / 180;
  const east = right * Math.cos(r) + up * Math.sin(r);
  const north = -right * Math.sin(r) + up * Math.cos(r);
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

/**
 * Whether a view has moved enough to be worth sending on: the demo sends Street View a new
 * place after 3 m or 15° of turning.
 */
export function viewMoved(last: { point: Point; bearing: number } | null, point: Point, bearing: number, metres = 3, degrees = 15): boolean {
  if (!last) return true;
  const turned = Math.abs(((bearing - last.bearing + 540) % 360) - 180);
  return Math.hypot(point[0] - last.point[0], point[1] - last.point[1]) >= metres || turned >= degrees;
}
