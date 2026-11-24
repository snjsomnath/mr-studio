import type { Placed, XY } from './table-space.ts';

/** One direction of travel along a street segment, in table metres. */
export interface StreetEdge {
  from: number;
  to: number;
  length: number;
  /** Heading in radians, 0 along +x. */
  angle: number;
  /** A main street, where most of the traffic starts. */
  major: boolean;
}

export interface StreetGraphOptions {
  /** Whether a line is part of this network, from its properties. Default: every line. */
  include?: (properties: Record<string, unknown>) => boolean;
  /** Whether a line is a main street, where most journeys start. Default: none. */
  major?: (properties: Record<string, unknown>) => boolean;
  /** How often a journey starts on a main street, where there are any. Default 0.7. */
  majorShare?: number;
  /** Pieces of network shorter than this in all are left out: anything there could only turn round and round. */
  shortestPieceM?: number;
}

/** The OpenStreetMap `highway` class of a street, or undefined when the data has none. */
export function highwayClass(properties: Record<string, unknown>): string | undefined {
  const highway = properties.highway;
  return typeof highway === 'string' ? highway : undefined;
}

/** A filter by OpenStreetMap `highway` class. Lines without a class pass when `unclassed` is true. */
export function byHighway(classes: Iterable<string>, unclassed = true): (properties: Record<string, unknown>) => boolean {
  const set = new Set(classes);
  return (properties) => {
    const highway = highwayClass(properties);
    return highway === undefined ? unclassed : set.has(highway);
  };
}

/**
 * Streets as a graph that things can travel along: cars, walkers, bicycles. Lines that share a
 * vertex are joined there, so data with a vertex at each crossing (as OpenStreetMap exports
 * have) gives junctions to turn at. Nothing turns round: at a dead end, `next` says so and
 * the traveller leaves (#201).
 */
export class StreetGraph {
  readonly nodes: XY[] = [];
  readonly edges: StreetEdge[] = [];
  /** Edge indices leaving each node. */
  readonly out: number[][] = [];
  /** Total street length in metres, counting each segment once. */
  length = 0;
  private index = new Map<string, number>();
  private starts: { edges: number[]; sums: number[] }[] = [];
  private majorShare: number;

  constructor(lines: Placed<XY[]>[], options: StreetGraphOptions = {}) {
    const include = options.include ?? (() => true);
    const isMajor = options.major ?? (() => false);
    this.majorShare = options.majorShare ?? 0.7;
    const shortest = options.shortestPieceM ?? 250;
    const segments: [number, number, boolean][] = [];
    for (const { geometry: line, properties } of lines) {
      if (!include(properties)) continue;
      const major = isMajor(properties);
      for (let i = 1; i < line.length; i++) {
        const a = this.node(line[i - 1]!);
        const b = this.node(line[i]!);
        if (a !== b) segments.push([a, b, major]);
      }
    }
    const piece = this.pieces(segments);
    const pieceLength = new Map<number, number>();
    const span = ([a, b]: [number, number, boolean]) => Math.hypot(this.nodes[b]![0] - this.nodes[a]![0], this.nodes[b]![1] - this.nodes[a]![1]);
    for (const s of segments) pieceLength.set(piece[s[0]]!, (pieceLength.get(piece[s[0]]!) ?? 0) + span(s));
    for (const s of segments) {
      if ((pieceLength.get(piece[s[0]]!) ?? 0) < shortest) continue;
      const [a, b, major] = s;
      const [ax, ay] = this.nodes[a]!;
      const [bx, by] = this.nodes[b]!;
      const length = span(s);
      this.length += length;
      this.edge(a, b, length, Math.atan2(by - ay, bx - ax), major);
      this.edge(b, a, length, Math.atan2(ay - by, ax - bx), major);
    }
    for (const keep of [() => true, (e: StreetEdge) => e.major]) {
      const edges: number[] = [];
      const sums: number[] = [];
      let total = 0;
      this.edges.forEach((e, i) => {
        if (!keep(e)) return;
        total += e.length;
        edges.push(i);
        sums.push(total);
      });
      this.starts.push({ edges, sums });
    }
  }

  /** An edge to start on: by length, so short segments get few travellers, and mostly on main streets where there are any. */
  start(random: () => number): number {
    const [all, major] = this.starts as [{ edges: number[]; sums: number[] }, { edges: number[]; sums: number[] }];
    const pool = major.edges.length && random() < this.majorShare ? major : all;
    const at = random() * (pool.sums.at(-1) ?? 0);
    let [lo, hi] = [0, pool.sums.length - 1];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pool.sums[mid]! < at) lo = mid + 1;
      else hi = mid;
    }
    return pool.edges[lo] ?? 0;
  }

  /**
   * Where a traveller arriving along `edge` goes next: straight on if it can, sometimes turning;
   * null at a dead end. A turn sharper than 135 degrees is taken only when it is the only way on.
   */
  next(edge: number, random: () => number, straightOn = 0.65): number | null {
    const current = this.edges[edge]!;
    const options = this.out[current.to]!.filter((e) => this.edges[e]!.to !== current.from);
    if (options.length === 0) return null;
    const turn = (e: number) => Math.abs(Math.atan2(Math.sin(this.edges[e]!.angle - current.angle), Math.cos(this.edges[e]!.angle - current.angle)));
    const ahead = options.filter((e) => turn(e) < (Math.PI * 3) / 4);
    const choices = ahead.length ? ahead : options;
    const straight = choices.reduce((best, e) => (turn(e) < turn(best) ? e : best));
    return random() < straightOn ? straight : choices[Math.floor(random() * choices.length)]!;
  }

  /** The junction or bend nearest a point, or -1 when the network is empty. */
  nearest(point: XY): number {
    let best = -1;
    let distance = Infinity;
    this.nodes.forEach(([x, y], i) => {
      if (this.out[i]!.length === 0) return;
      const d = Math.hypot(x - point[0], y - point[1]);
      if (d < distance) [best, distance] = [i, d];
    });
    return best;
  }

  /**
   * The shortest way along the streets between two points (#283): from the street point nearest
   * `from` to the one nearest `to`, as a line in table metres. Null when they are not connected.
   */
  route(from: XY, to: XY): XY[] | null {
    const start = this.nearest(from);
    const end = this.nearest(to);
    if (start < 0 || end < 0) return null;
    const distance = new Float64Array(this.nodes.length).fill(Infinity);
    const via = new Int32Array(this.nodes.length).fill(-1);
    distance[start] = 0;
    // A binary heap of [distance, node].
    const heap: [number, number][] = [[0, start]];
    const push = (item: [number, number]) => {
      heap.push(item);
      for (let i = heap.length - 1; i > 0; ) {
        const up = (i - 1) >> 1;
        if (heap[up]![0] <= heap[i]![0]) break;
        [heap[up], heap[i]] = [heap[i]!, heap[up]!];
        i = up;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const [l, r] = [2 * i + 1, 2 * i + 2];
          let m = i;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i]!, heap[m]!];
          i = m;
        }
      }
      return top;
    };
    while (heap.length > 0) {
      const [d, node] = pop();
      if (node === end) break;
      if (d > distance[node]!) continue;
      for (const e of this.out[node]!) {
        const edge = this.edges[e]!;
        const next = d + edge.length;
        if (next < distance[edge.to]!) {
          distance[edge.to] = next;
          via[edge.to] = node;
          push([next, edge.to]);
        }
      }
    }
    if (distance[end] === Infinity) return null;
    const path: XY[] = [];
    for (let node = end; node !== -1; node = via[node]!) path.push(this.nodes[node]!);
    return path.reverse();
  }

  /** The point `s` metres along an edge, `offset` metres to its right (y grows down the table). */
  at(edge: number, s: number, offset = 0): XY {
    const e = this.edges[edge]!;
    const [x0, y0] = this.nodes[e.from]!;
    return [x0 + Math.cos(e.angle) * s - Math.sin(e.angle) * offset, y0 + Math.sin(e.angle) * s + Math.cos(e.angle) * offset];
  }

  private pieces(segments: [number, number, boolean][]): number[] {
    const parent = this.nodes.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
      return i;
    };
    for (const [a, b] of segments) parent[find(a)] = find(b);
    return parent.map((_, i) => find(i));
  }

  private node(point: XY): number {
    // Vertices within half a metre are the same junction.
    const key = `${Math.round(point[0] * 2)},${Math.round(point[1] * 2)}`;
    let id = this.index.get(key);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push(point);
      this.out.push([]);
      this.index.set(key, id);
    }
    return id;
  }

  private edge(from: number, to: number, length: number, angle: number, major: boolean): void {
    this.out[from]!.push(this.edges.length);
    this.edges.push({ from, to, length, angle, major });
  }
}

/** Evenly spaced points along lines, `spacing` metres apart, skipping lines shorter than two spacings. */
export function pointsAlong(lines: XY[][], spacing: number): XY[] {
  const points: XY[] = [];
  for (const line of lines) {
    let total = 0;
    for (let i = 1; i < line.length; i++) total += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
    if (total < spacing * 2) continue;
    const count = Math.floor(total / spacing);
    const step = total / (count + 1);
    let next = step;
    let walked = 0;
    for (let i = 1; i < line.length && points.length < 1e6; i++) {
      const [ax, ay] = line[i - 1]!;
      const [bx, by] = line[i]!;
      const length = Math.hypot(bx - ax, by - ay);
      while (next <= walked + length && next < total) {
        const f = length > 0 ? (next - walked) / length : 0;
        points.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
        next += step;
      }
      walked += length;
    }
  }
  return points;
}
