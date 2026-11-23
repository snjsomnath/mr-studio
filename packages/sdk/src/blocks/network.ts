// A street network you can route on (docs/blocks.md backlog: "network router"). Lines
// (streets, footpaths, cycle lanes) become a graph whose nodes are their vertices, joined
// where lines meet or nearly meet. People and vehicles then move along real routes, not
// across buildings (docs/visualisation.md M8): the crowd drawn to a place walks the streets.

import { distance, measurePath } from './geo.ts';
import type { MeasuredPath, Point } from './geo.ts';

interface Edge {
  to: number;
  length: number;
}

/** Shortest-path trees towards one place: from any node, the next node and the distance left. */
export interface RouteTree {
  /** The node the place was snapped to. */
  root: number;
  next: Int32Array;
  cost: Float64Array;
}

export class StreetNetwork {
  readonly nodes: Point[] = [];
  private readonly edges: Edge[][] = [];
  private readonly cell: number;
  private readonly grid = new Map<string, number[]>();

  /**
   * Builds the network from lines in table metres. Vertices closer than `snap_m` are one
   * node, so lines drawn to meet (or almost meet) are joined.
   */
  constructor(lines: readonly (readonly Point[])[], snap_m = 1.5) {
    this.cell = Math.max(snap_m, 0.01);
    for (const line of lines) {
      let previous = -1;
      for (const point of line) {
        const node = this.node(point, snap_m);
        if (previous >= 0 && previous !== node) this.link(previous, node);
        previous = node;
      }
    }
  }

  get size(): number {
    return this.nodes.length;
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }

  private node(point: Point, snap_m: number): number {
    const [x, y] = point;
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const n of this.grid.get(`${cx + dx},${cy + dy}`) ?? []) if (distance(this.nodes[n]!, point) <= snap_m) return n;
      }
    }
    const n = this.nodes.length;
    this.nodes.push([x, y]);
    this.edges.push([]);
    const key = this.key(x, y);
    const bucket = this.grid.get(key);
    if (bucket) bucket.push(n);
    else this.grid.set(key, [n]);
    return n;
  }

  private link(a: number, b: number): void {
    if (this.edges[a]!.some((e) => e.to === b)) return;
    const length = distance(this.nodes[a]!, this.nodes[b]!);
    this.edges[a]!.push({ to: b, length });
    this.edges[b]!.push({ to: a, length });
  }

  /** The streets that leave node `n`, with their lengths. */
  neighbours(n: number): readonly { to: number; length: number }[] {
    return this.edges[n] ?? [];
  }

  /** Every street once, as node pairs with their lengths. */
  links(): [number, number, number][] {
    const out: [number, number, number][] = [];
    this.edges.forEach((list, a) => {
      for (const edge of list) if (a < edge.to) out.push([a, edge.to, edge.length]);
    });
    return out;
  }

  /** The node nearest a point, or -1 for an empty network. */
  nearest(point: Point): number {
    let best = -1;
    let bestDistance = Infinity;
    // Look in growing rings of cells, then fall back to every node.
    const cx = Math.floor(point[0] / this.cell);
    const cy = Math.floor(point[1] / this.cell);
    for (let r = 0; r <= 8 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const n of this.grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            const d = distance(this.nodes[n]!, point);
            if (d < bestDistance) [best, bestDistance] = [n, d];
          }
        }
      }
    }
    if (best >= 0) return best;
    this.nodes.forEach((node, n) => {
      const d = distance(node, point);
      if (d < bestDistance) [best, bestDistance] = [n, d];
    });
    return best;
  }

  /** Shortest distances from every node to `to` along the network (Dijkstra), as a tree to follow. */
  treeTo(to: Point): RouteTree {
    const count = this.nodes.length;
    const cost = new Float64Array(count).fill(Infinity);
    const next = new Int32Array(count).fill(-1);
    const root = this.nearest(to);
    if (root < 0) return { root, next, cost };
    cost[root] = 0;
    const heap = new MinHeap();
    heap.push(0, root);
    while (heap.size > 0) {
      const [d, n] = heap.pop();
      if (d > cost[n]!) continue;
      for (const edge of this.edges[n]!) {
        const through = d + edge.length;
        if (through < cost[edge.to]!) {
          cost[edge.to] = through;
          next[edge.to] = n;
          heap.push(through, edge.to);
        }
      }
    }
    return { root, next, cost };
  }

  /** The route from node `from` down a tree to its place, or null if they are not connected. */
  follow(tree: RouteTree, from: number, end?: Point): MeasuredPath | null {
    if (from < 0 || !Number.isFinite(tree.cost[from]!)) return null;
    const points: Point[] = [];
    for (let n = from, guard = 0; n >= 0 && guard <= this.nodes.length; n = tree.next[n]!, guard++) points.push(this.nodes[n]!);
    if (end && distance(points[points.length - 1]!, end) > 0.01) points.push(end);
    return points.length >= 2 ? measurePath(points) : null;
  }

  /** The route between two points along the network, or null when none joins them. */
  route(from: Point, to: Point): MeasuredPath | null {
    const tree = this.treeTo(to);
    const path = this.follow(tree, this.nearest(from), to);
    if (!path) return null;
    return measurePath([from, ...path.points]);
  }

  /** Nodes reachable in a tree, for picking where a walk starts. */
  reachable(tree: RouteTree): number[] {
    const out: number[] = [];
    tree.cost.forEach((c, n) => Number.isFinite(c) && c > 0 && out.push(n));
    return out;
  }
}

/** A binary heap of [priority, value], smallest first. */
class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
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

  pop(): [number, number] {
    const { keys, values } = this;
    const top: [number, number] = [keys[0]!, values[0]!];
    const lastKey = keys.pop()!;
    const lastValue = values.pop()!;
    if (keys.length > 0) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= keys.length) break;
        const right = left + 1;
        const child = right < keys.length && keys[right]! < keys[left]! ? right : left;
        if (keys[child]! >= lastKey) break;
        keys[i] = keys[child]!;
        values[i] = values[child]!;
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}
