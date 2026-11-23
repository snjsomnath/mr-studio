import type { Placed, XY } from '@mrstudio/sdk';

/** One direction of travel along a street segment. */
export interface Edge {
  from: number;
  to: number;
  length: number;
  /** Heading in radians, 0 along +x. */
  angle: number;
  /** A main road, where most traffic is. */
  major: boolean;
}

/**
 * OpenStreetMap classes cars drive on, as the interactive_map traffic did, without `service`:
 * parking aisles and driveways are short stubs that cars would only bounce along (#201).
 */
export const MOTOR_ROADS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
]);
const MAJOR_ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link']);

/** Pieces of street network shorter than this in all are left out: a car there could only turn round and round. */
export const SHORTEST_PIECE_M = 250;

/** Whether cars drive on a street: any street, unless its OpenStreetMap class says it is not for cars. */
export function forCars(properties: Record<string, unknown>): boolean {
  const highway = properties.highway;
  return typeof highway !== 'string' || MOTOR_ROADS.has(highway);
}

/**
 * The street network as a graph. Lines that share a vertex are joined there, so data
 * with a vertex at each crossing (as OpenStreetMap exports have) gives cars junctions to turn at.
 */
export class Network {
  readonly nodes: XY[] = [];
  readonly edges: Edge[] = [];
  /** Edge indices leaving each node. */
  readonly out: number[][] = [];
  /** Total street length in metres, counting each segment once. */
  length = 0;
  private index = new Map<string, number>();
  /** Cumulative lengths for picking a place to start, by length: all edges, then the main roads. */
  private starts: { edges: number[]; sums: number[] }[] = [];

  constructor(lines: Placed<XY[]>[]) {
    const segments: [number, number, boolean][] = [];
    for (const { geometry: line, properties } of lines) {
      if (!forCars(properties)) continue;
      const major = typeof properties.highway === 'string' && MAJOR_ROADS.has(properties.highway);
      for (let i = 1; i < line.length; i++) {
        const a = this.node(line[i - 1]!);
        const b = this.node(line[i]!);
        if (a !== b) segments.push([a, b, major]);
      }
    }
    // Pieces of network that touch nothing else and are short in all are left out.
    const piece = this.pieces(segments);
    const pieceLength = new Map<number, number>();
    const span = ([a, b]: [number, number, boolean]) => Math.hypot(this.nodes[b]![0] - this.nodes[a]![0], this.nodes[b]![1] - this.nodes[a]![1]);
    for (const s of segments) pieceLength.set(piece[s[0]]!, (pieceLength.get(piece[s[0]]!) ?? 0) + span(s));
    for (const s of segments) {
      if ((pieceLength.get(piece[s[0]]!) ?? 0) < SHORTEST_PIECE_M) continue;
      const [a, b, major] = s;
      const [ax, ay] = this.nodes[a]!;
      const [bx, by] = this.nodes[b]!;
      const length = span(s);
      this.length += length;
      this.edge(a, b, length, Math.atan2(by - ay, bx - ax), major);
      this.edge(b, a, length, Math.atan2(ay - by, ax - bx), major);
    }
    for (const keep of [() => true, (e: Edge) => e.major]) {
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

  /** An edge to start a car on: by length, so short segments get few cars, and mostly on main roads where there are any. */
  start(random: () => number): number {
    const [all, major] = this.starts as [{ edges: number[]; sums: number[] }, { edges: number[]; sums: number[] }];
    const pool = major.edges.length && random() < 0.7 ? major : all;
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
   * Where a car arriving along `edge` goes next: straight on if it can, sometimes turning; null at a
   * dead end, where the car leaves the street rather than turning round and back (#201).
   */
  next(edge: number, random: () => number): number | null {
    const current = this.edges[edge]!;
    const options = this.out[current.to]!.filter((e) => this.edges[e]!.to !== current.from);
    if (options.length === 0) return null;
    const turn = (e: number) => Math.abs(Math.atan2(Math.sin(this.edges[e]!.angle - current.angle), Math.cos(this.edges[e]!.angle - current.angle)));
    // No hairpins: a turn sharper than this is taken only when it is the only way on.
    const ahead = options.filter((e) => turn(e) < (Math.PI * 3) / 4);
    const choices = ahead.length ? ahead : options;
    const straight = choices.reduce((best, e) => (turn(e) < turn(best) ? e : best));
    return random() < 0.65 ? straight : choices[Math.floor(random() * choices.length)]!;
  }

  /** The connected piece each node belongs to. */
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
