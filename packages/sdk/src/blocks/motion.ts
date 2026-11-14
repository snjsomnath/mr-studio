// Things that move: lights travelling along lines, and free particles pulled by
// attractors or pushed by a field. Positions are table metres and time is seconds,
// so motion looks the same on any table and at any frame rate. These are ambient
// animations for the table surface, not solvers: anything physical is a kernel.

import { pointAlong } from './geo.ts';
import type { MeasuredPath, Point } from './geo.ts';
import { clamp01 } from './scale.ts';

/** A source of random numbers in [0, 1). Pass a seeded one for repeatable motion. */
export type Random = () => number;

/** A small seeded generator (mulberry32), for tests and for tables that must agree. */
export function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Along paths ------------------------------------------------------------

export interface Head {
  point: [number, number];
  /** Direction of travel in radians. */
  heading: number;
  /** 0..1: fades up as it leaves and out as it lands. */
  alpha: number;
  /** 0..1 over the last tenth of the run, for a burst where it arrives. */
  landing: number;
  /** Index of the path it travels on. */
  path: number;
}

export interface HeadOptions<T extends MeasuredPath> {
  /** Seconds for one run from end to end. Default 4.2, slow enough to follow across a table. */
  period?: number;
  /** Or a speed in metres per second, so long routes take longer. Overrides `period`. */
  speed?: number;
  /** Lights in flight per path. Default 1. Drive it by flow to show volume as traffic. */
  count?: number | ((path: T, index: number) => number);
  /** Travel from the end to the start for paths where this is true. */
  reverse?: (path: T, index: number) => boolean;
  /** Paths for which this is false carry no light: an idle line is still a wire. */
  active?: (path: T, index: number) => boolean;
}

/**
 * Where the travelling lights are at `time`. A pure function of time: there is no
 * state to keep, scrubbing backwards works, and two surfaces given the same clock
 * draw the same picture. Starts are staggered so lines do not all set off together.
 */
export function pathHeads<T extends MeasuredPath>(paths: readonly T[], time: number, options: HeadOptions<T> = {}): Head[] {
  const heads: Head[] = [];
  paths.forEach((path, index) => {
    if (path.points.length < 2 || path.length <= 0) return;
    if (options.active && !options.active(path, index)) return;
    const period = options.speed ? path.length / options.speed : (options.period ?? 4.2);
    const count = Math.max(0, Math.round(typeof options.count === 'function' ? options.count(path, index) : (options.count ?? 1)));
    const reverse = options.reverse?.(path, index) ?? false;
    for (let k = 0; k < count; k++) {
      const phase = (((time / period + ((index * 0.37) % 1) + k / count) % 1) + 1) % 1;
      const landing = phase > 0.9 ? (phase - 0.9) / 0.1 : 0;
      const at = pointAlong(path, reverse ? 1 - phase : phase);
      heads.push({
        point: at.point,
        heading: reverse ? at.heading + Math.PI : at.heading,
        alpha: Math.min(1, phase / 0.06) * (1 - landing),
        landing,
        path: index,
      });
    }
  });
  return heads;
}

// ---- Free particles ---------------------------------------------------------

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  lifetime: number;
  /** Whatever the spawner attached: a colour, a target, a kind. */
  tag: unknown;
}

/** What moves a particle: returns the velocity it should steer towards, in metres per second. */
export type Steering = (particle: Particle, index: number) => readonly [vx: number, vy: number] | null;

export interface SwarmOptions {
  /** Most particles alive at once. */
  max: number;
  /** New particles per second at full intensity. */
  spawnRate: number;
  /** Creates a particle, or null to skip this one. */
  spawn: (random: Random) => Pick<Particle, 'x' | 'y' | 'lifetime' | 'tag'> | null;
  steer: Steering;
  /** How quickly velocity follows the steering, per second. Higher is snappier. Default 9. */
  response?: number;
  random?: Random;
}

/** A pool of particles that are spawned, steered and retired. */
export class Swarm {
  readonly particles: Particle[] = [];
  private options: SwarmOptions;
  private random: Random;
  private debt = 0;

  constructor(options: SwarmOptions) {
    this.options = options;
    this.random = options.random ?? Math.random;
  }

  /**
   * Advances by `dt` seconds. `intensity` (0..1) scales both how many particles
   * may be alive and how fast they appear, for ramping a crowd in and out.
   */
  step(dt: number, intensity = 1): void {
    const { max, spawnRate, spawn, steer } = this.options;
    const allowed = Math.floor(max * clamp01(intensity));
    this.debt = Math.min(this.debt + spawnRate * clamp01(intensity) * dt, max);
    while (this.debt >= 1 && this.particles.length < allowed) {
      this.debt -= 1;
      const made = spawn(this.random);
      if (made) this.particles.push({ vx: 0, vy: 0, age: 0, ...made });
    }
    if (this.particles.length >= allowed) this.debt = Math.min(this.debt, 1);

    const follow = 1 - Math.exp(-(this.options.response ?? 9) * dt);
    let kept = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]!;
      p.age += dt;
      const want = p.age <= p.lifetime ? steer(p, i) : null;
      if (!want) continue;
      p.vx += (want[0] - p.vx) * follow;
      p.vy += (want[1] - p.vy) * follow;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      this.particles[kept++] = p;
    }
    this.particles.length = kept;
  }

  clear(): void {
    this.particles.length = 0;
    this.debt = 0;
  }
}

/** How visible a particle is over its life: quick fade in, slow fade out. */
export function particleAlpha(p: Particle): number {
  return clamp01(Math.min(p.age / 0.3, 1 - p.age / p.lifetime));
}

// ---- Attractors -------------------------------------------------------------

/** Something that pulls: a venue, a stop, a destination. */
export interface Attractor {
  point: Point;
  /** Relative pull. Also how often it is chosen as a destination. */
  weight: number;
}

/** Picks an item with probability proportional to its weight. */
export function pickWeighted<T extends { weight: number }>(items: readonly T[], random: Random): T | undefined {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (total <= 0) return items[0];
  let r = random() * total;
  for (const item of items) {
    r -= Math.max(0, item.weight);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/** A point on a ring around a centre, with the distance varied so arrivals do not form a perfect circle. */
export function aroundRing(centre: Point, radius_m: number, random: Random, spread = 0.3): [number, number] {
  const angle = random() * Math.PI * 2;
  const distance = radius_m * (1 - spread + random() * spread * 2);
  return [centre[0] + Math.cos(angle) * distance, centre[1] + Math.sin(angle) * distance];
}

export interface PullOptions {
  /** Drift speed far from the target, metres per second. */
  speed: number;
  /** Inside this distance the pull strengthens, up to three times the speed at the centre. */
  radius_m: number;
  /** Sideways wander as a share of the speed, so a crowd meanders instead of marching. Default 0.4. */
  wander?: number;
  /** A particle this close has arrived and is retired. Default 4 m. */
  arrive_m?: number;
}

/**
 * Steering towards one target per particle: the motion of a crowd drawn to a place.
 * `target` reads the destination from the particle, usually from its tag.
 */
export function pullTowards(target: (particle: Particle) => Point, options: PullOptions): Steering {
  const wander = options.wander ?? 0.4;
  const arrive = options.arrive_m ?? 4;
  return (p, index) => {
    const [tx, ty] = target(p);
    const dx = tx - p.x;
    const dy = ty - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist < arrive) return null;
    const ux = dx / dist;
    const uy = dy / dist;
    const pull = options.speed * (1 + Math.max(0, (options.radius_m - dist) / options.radius_m) * 2);
    const side = Math.sin(p.age * 9 + index) * wander * options.speed;
    return [ux * pull - uy * side, uy * pull + ux * side];
  };
}

/**
 * Steering by the combined pull of every attractor, falling off with distance: a
 * particle between two venues curves towards the heavier one. Retired on arrival.
 */
export function gravity(attractors: readonly Attractor[], options: PullOptions): Steering {
  const arrive = options.arrive_m ?? 4;
  return (p) => {
    let fx = 0;
    let fy = 0;
    for (const a of attractors) {
      const dx = a.point[0] - p.x;
      const dy = a.point[1] - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < arrive) return null;
      const strength = a.weight / (1 + (dist / options.radius_m) ** 2);
      fx += (dx / dist) * strength;
      fy += (dy / dist) * strength;
    }
    const size = Math.hypot(fx, fy);
    if (size <= 0) return [0, 0];
    const speed = options.speed * Math.min(3, 1 + size);
    return [(fx / size) * speed, (fy / size) * speed];
  };
}

// ---- Clusters ---------------------------------------------------------------

export interface Cluster<T> {
  point: [number, number];
  members: T[];
  /** Sum of the members' weights (1 each when unweighted). */
  weight: number;
}

/**
 * Groups points that are closer than `radius_m` into one marker at their weighted
 * centre, so a dense dataset reads as a few sized markers instead of a smear.
 */
export function clusterPoints<T extends { point: Point }>(items: readonly T[], radius_m: number, weight: (item: T) => number = () => 1): Cluster<T>[] {
  const cells = new Map<string, Cluster<T> & { sx: number; sy: number }>();
  for (const item of items) {
    const key = `${Math.floor(item.point[0] / radius_m)}:${Math.floor(item.point[1] / radius_m)}`;
    const w = weight(item);
    const cell = cells.get(key);
    if (cell) {
      cell.members.push(item);
      cell.weight += w;
      cell.sx += item.point[0] * w;
      cell.sy += item.point[1] * w;
    } else cells.set(key, { point: [0, 0], members: [item], weight: w, sx: item.point[0] * w, sy: item.point[1] * w });
  }
  return [...cells.values()].map(({ sx, sy, ...cluster }) => ({
    ...cluster,
    point: cluster.weight > 0 ? [sx / cluster.weight, sy / cluster.weight] : [cluster.members[0]!.point[0], cluster.members[0]!.point[1]],
  }));
}

// ---- Flow networks ----------------------------------------------------------

/** A directed link between two named nodes with a value per time step. */
export interface Link {
  source: string;
  target: string;
  values: readonly number[];
}

/**
 * What leaves a node less what arrives at it, at one step. Positive is the node
 * giving (a grid supplying, a battery discharging), negative is it taking.
 */
export function nodeBalance(links: readonly Link[], node: string, step: number): number {
  let net = 0;
  for (const link of links) {
    const value = link.values[step] ?? 0;
    if (link.source === node) net += value;
    else if (link.target === node) net -= value;
  }
  return net;
}

/** A node's balance at a step against its own busiest step: a direction and a 0..1 level, for pulse rings. */
export function nodePulse(links: readonly Link[], node: string, step: number): { direction: 1 | -1; level: number } {
  const steps = links.reduce((max, link) => Math.max(max, link.values.length), 0);
  let peak = 0;
  for (let s = 0; s < steps; s++) peak = Math.max(peak, Math.abs(nodeBalance(links, node, s)));
  const net = nodeBalance(links, node, step);
  return { direction: net < 0 ? -1 : 1, level: peak > 0 ? Math.abs(net) / peak : 0 };
}
