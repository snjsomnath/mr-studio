import type { Point } from '@mrstudio/sdk';

/** One direction of travel along a street segment. */
export interface Edge {
  from: number;
  to: number;
  length: number;
  /** Heading in radians, 0 along +x. */
  angle: number;
}

/**
 * The street network as a graph. Lines that share a vertex are joined there, so data
 * with a vertex at each crossing (as OpenStreetMap exports have) gives cars junctions to turn at.
 */
export class Network {
  readonly nodes: Point[] = [];
  readonly edges: Edge[] = [];
  /** Edge indices leaving each node. */
  readonly out: number[][] = [];
  /** Total street length in metres, counting each segment once. */
  length = 0;
  private index = new Map<string, number>();

  constructor(lines: Point[][]) {
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const a = this.node(line[i - 1]!);
        const b = this.node(line[i]!);
        if (a === b) continue;
        const [ax, ay] = this.nodes[a]!;
        const [bx, by] = this.nodes[b]!;
        const length = Math.hypot(bx - ax, by - ay);
        this.length += length;
        this.edge(a, b, length, Math.atan2(by - ay, bx - ax));
        this.edge(b, a, length, Math.atan2(ay - by, ax - bx));
      }
    }
  }

  /** Where a car arriving along `edge` goes next: straight on if it can, never back unless it must. */
  next(edge: number, random: () => number): number {
    const current = this.edges[edge]!;
    const options = this.out[current.to]!.filter((e) => this.edges[e]!.to !== current.from);
    if (options.length === 0) return this.out[current.to]!.find((e) => this.edges[e]!.to === current.from) ?? edge;
    const turn = (e: number) => Math.abs(Math.atan2(Math.sin(this.edges[e]!.angle - current.angle), Math.cos(this.edges[e]!.angle - current.angle)));
    const straight = options.reduce((best, e) => (turn(e) < turn(best) ? e : best));
    return random() < 0.65 ? straight : options[Math.floor(random() * options.length)]!;
  }

  private node(point: Point): number {
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

  private edge(from: number, to: number, length: number, angle: number): void {
    this.out[from]!.push(this.edges.length);
    this.edges.push({ from, to, length, angle });
  }
}
