// The walking network and the two routes across it. No DOM and no SDK runtime, so it runs in tests.
//
// "Sun" is the cost a cool path avoids: metres walked in direct sun. Each edge has an
// exposure from 0 (shade) to 1 (sun), and the coolest route has the least sunlit metres
// among routes no more than `detour` longer than the shortest one.

export type LonLat = [lon: number, lat: number];

export interface Edge {
  u: number;
  v: number;
  length: number;
  coordinates: LonLat[];
  /** Share of the edge in direct sun, 0..1. */
  exposure: number;
}

export interface Network {
  nodes: LonLat[];
  edges: Edge[];
  /** Edge indices at each node. */
  adjacency: number[][];
}

export interface Route {
  coordinates: LonLat[];
  length: number;
  /** Metres of the route in direct sun. */
  sun: number;
}

export interface RoutePair {
  shortest: Route;
  coolest: Route;
}

type Distance = (a: readonly number[], b: readonly number[]) => number;

interface LineFeature {
  geometry?: { type?: string; coordinates?: unknown } | null;
}

/**
 * Builds the network from GeoJSON lines. Lines meet where they share a vertex,
 * which is how street data is drawn; a node is made at every line end and every
 * shared vertex, so a long street becomes one edge per block.
 */
export function buildNetwork(geojson: { features?: LineFeature[] }, distance: Distance): Network {
  const lines: LonLat[][] = [];
  for (const feature of geojson.features ?? []) {
    const geometry = feature.geometry;
    const parts = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? (geometry.coordinates as unknown[]) : [];
    for (const part of parts) {
      const line = (part as number[][]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p): LonLat => [p[0]!, p[1]!]);
      if (line.length >= 2) lines.push(line);
    }
  }
  // About 0.1 m: vertices closer than that are the same place.
  const key = (p: LonLat) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const uses = new Map<string, number>();
  for (const line of lines) {
    line.forEach((p, i) => uses.set(key(p), (uses.get(key(p)) ?? 0) + (i === 0 || i === line.length - 1 ? 2 : 1)));
  }
  const network: Network = { nodes: [], edges: [], adjacency: [] };
  const ids = new Map<string, number>();
  const node = (p: LonLat) => {
    let id = ids.get(key(p));
    if (id === undefined) {
      id = network.nodes.push(p) - 1;
      ids.set(key(p), id);
      network.adjacency.push([]);
    }
    return id;
  };
  for (const line of lines) {
    let start = 0;
    for (let i = 1; i < line.length; i++) {
      if (uses.get(key(line[i]!))! < 2) continue;
      const coordinates = line.slice(start, i + 1);
      start = i;
      let length = 0;
      for (let k = 1; k < coordinates.length; k++) length += distance(coordinates[k - 1]!, coordinates[k]!);
      const [u, v] = [node(coordinates[0]!), node(coordinates[coordinates.length - 1]!)];
      if (u === v || !(length > 0)) continue;
      const edge = network.edges.push({ u, v, length, coordinates, exposure: 0 }) - 1;
      network.adjacency[u]!.push(edge);
      network.adjacency[v]!.push(edge);
    }
  }
  return network;
}

/**
 * Sets every edge's exposure by sampling `lit` (1 in sun, 0 in shade) along it,
 * about every `spacing` metres.
 */
export function setExposure(network: Network, lit: (point: LonLat) => number, spacing: number, distance: Distance): void {
  for (const edge of network.edges) {
    let total = 0;
    let count = 0;
    for (let i = 1; i < edge.coordinates.length; i++) {
      const [a, b] = [edge.coordinates[i - 1]!, edge.coordinates[i]!];
      const samples = Math.max(1, Math.round(distance(a, b) / spacing));
      for (let k = 0; k < samples; k++) {
        const t = (k + 0.5) / samples;
        total += lit([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        count++;
      }
    }
    edge.exposure = count > 0 ? Math.min(1, Math.max(0, total / count)) : 0;
  }
}

/** The nearest node that has a path, or -1 when none is within `maxDistance` metres. */
export function snap(network: Network, point: readonly number[], distance: Distance, maxDistance = Infinity): number {
  let best = -1;
  let bestDistance = maxDistance;
  network.nodes.forEach((node, i) => {
    if (network.adjacency[i]!.length === 0) return;
    const d = distance(point, node);
    if (d <= bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

/** A binary min-heap of values with numeric priorities. */
class Heap<T> {
  private keys: number[] = [];
  private values: T[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, value: T): void {
    const { keys, values } = this;
    let i = keys.push(key) - 1;
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      keys[i] = keys[parent]!;
      values[i] = values[parent]!;
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }
  pop(): T {
    const { keys, values } = this;
    const top = values[0]!;
    const key = keys.pop()!;
    const value = values.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1]! < keys[child]!) child++;
        if (keys[child]! >= key) break;
        keys[i] = keys[child]!;
        values[i] = values[child]!;
        i = child;
      }
      keys[i] = key;
      values[i] = value;
    }
    return top;
  }
}

const other = (edge: Edge, node: number) => (edge.u === node ? edge.v : edge.u);

/** Walking distance from `source` to every node (Infinity where unreachable), and the edge each was reached by. */
export function distancesFrom(network: Network, source: number): { distance: Float64Array; via: Int32Array } {
  const distance = new Float64Array(network.nodes.length).fill(Infinity);
  const via = new Int32Array(network.nodes.length).fill(-1);
  const queue = new Heap<number>();
  distance[source] = 0;
  queue.push(0, source);
  while (queue.size > 0) {
    const node = queue.pop();
    const here = distance[node]!;
    for (const index of network.adjacency[node]!) {
      const edge = network.edges[index]!;
      const next = other(edge, node);
      if (here + edge.length < distance[next]!) {
        distance[next] = here + edge.length;
        via[next] = index;
        queue.push(distance[next]!, next);
      }
    }
  }
  return { distance, via };
}

interface Label {
  node: number;
  length: number;
  sun: number;
  previous: Label | null;
  edge: number;
  active: boolean;
}

/** Most labels a search may settle before giving up, which keeps a huge network from stalling the table. */
const MAX_LABELS = 400_000;

/**
 * The least-sun route from `origin` to `destination` no longer than `budget` metres:
 * a label-setting search over (length, sun) pairs, pruned by the distance still to walk.
 * Returns edge indices in walking order, or null if no route fits or the search is too large.
 */
function coolestEdges(network: Network, origin: number, destination: number, budget: number, remaining: Float64Array): number[] | null {
  const first: Label = { node: origin, length: 0, sun: 0, previous: null, edge: -1, active: true };
  const labels = new Map<number, Label[]>([[origin, [first]]]);
  const queue = new Heap<Label>();
  queue.push(0, first);
  let settled = 0;
  while (queue.size > 0) {
    let current = queue.pop();
    if (!current.active) continue;
    if (current.node === destination) {
      const path: number[] = [];
      while (current.previous) {
        path.push(current.edge);
        current = current.previous;
      }
      return path.reverse();
    }
    if (++settled > MAX_LABELS) return null;
    for (const index of network.adjacency[current.node]!) {
      const edge = network.edges[index]!;
      const next = other(edge, current.node);
      const length = current.length + edge.length;
      if (length + remaining[next]! > budget + 1e-7) continue;
      const sun = current.sun + edge.exposure * edge.length;
      let prior = labels.get(next);
      if (!prior) labels.set(next, (prior = []));
      if (prior.some((l) => l.length <= length + 1e-9 && l.sun <= sun + 1e-9)) continue;
      for (const old of prior) if (length <= old.length + 1e-9 && sun <= old.sun + 1e-9) old.active = false;
      const kept = prior.filter((l) => l.active);
      const label: Label = { node: next, length, sun, previous: current, edge: index, active: true };
      kept.push(label);
      labels.set(next, kept);
      queue.push(sun, label);
    }
  }
  return null;
}

function describe(network: Network, origin: number, path: number[]): Route {
  const coordinates: LonLat[] = [network.nodes[origin]!];
  let node = origin;
  let length = 0;
  let sun = 0;
  for (const index of path) {
    const edge = network.edges[index]!;
    const line = edge.u === node ? edge.coordinates : [...edge.coordinates].reverse();
    coordinates.push(...line.slice(1));
    node = other(edge, node);
    length += edge.length;
    sun += edge.exposure * edge.length;
  }
  return { coordinates, length, sun };
}

/**
 * The shortest route between two nodes and the coolest one within `detour`
 * (0.5 allows a walk half as long again). Null when the nodes are not connected.
 */
export function route(network: Network, origin: number, destination: number, detour: number): RoutePair | null {
  if (origin === destination || origin < 0 || destination < 0) return null;
  const { distance: remaining, via } = distancesFrom(network, destination);
  if (!Number.isFinite(remaining[origin]!)) return null;
  // `via` points towards the destination, so following it from the origin walks the shortest route.
  const direct: number[] = [];
  for (let node = origin; node !== destination; node = other(network.edges[via[node]!]!, node)) direct.push(via[node]!);
  const shortest = describe(network, origin, direct);
  const cooler = detour > 0 ? coolestEdges(network, origin, destination, shortest.length * (1 + detour), remaining) : null;
  const coolest = cooler ? describe(network, origin, cooler) : shortest;
  // Equal sun is no reason to walk further.
  return { shortest, coolest: coolest.sun < shortest.sun - 1e-6 ? coolest : shortest };
}

/** A small seeded generator, so example walks are the same on every table. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks a pair of nodes that makes a good demonstration: between `minLength` and
 * `maxLength` metres apart on foot, preferring the pair whose cool route saves the most sun.
 */
export function exampleWalk(
  network: Network,
  seed: number,
  minLength: number,
  maxLength: number,
  detour: number,
  /** Ends the example may use, such as the nodes on the table. All of them when left out or when fewer than two pass. */
  allowed?: (node: number) => boolean,
): [from: number, to: number] | null {
  const random = mulberry(seed * 7919 + 17);
  const linked = network.nodes.map((_, i) => i).filter((i) => network.adjacency[i]!.length > 0);
  const inside = allowed ? linked.filter(allowed) : linked;
  const walkable = inside.length >= 2 ? inside : linked;
  if (walkable.length < 2) return null;
  let best: [number, number] | null = null;
  let bestSaving = -1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const from = walkable[Math.floor(random() * walkable.length)]!;
    const { distance } = distancesFrom(network, from);
    const reachable = walkable.filter((i) => i !== from && Number.isFinite(distance[i]!));
    const fitting = reachable.filter((i) => distance[i]! >= minLength && distance[i]! <= maxLength);
    const pool = fitting.length > 0 ? fitting : reachable;
    if (pool.length === 0) continue;
    const to = pool[Math.floor(random() * pool.length)]!;
    const pair = route(network, from, to, detour);
    const saving = pair ? pair.shortest.sun - pair.coolest.sun : -1;
    if (saving > bestSaving) {
      bestSaving = saving;
      best = [from, to];
    }
  }
  return best;
}

/** The point `metres` along a route, clamped to its ends. */
export function pointAlongRoute(coordinates: LonLat[], metres: number, distance: Distance): LonLat {
  let left = Math.max(0, metres);
  for (let i = 1; i < coordinates.length; i++) {
    const [a, b] = [coordinates[i - 1]!, coordinates[i]!];
    const span = distance(a, b);
    if (left <= span && span > 0) return [a[0] + ((b[0] - a[0]) * left) / span, a[1] + ((b[1] - a[1]) * left) / span];
    left -= span;
  }
  return coordinates[coordinates.length - 1]!;
}
