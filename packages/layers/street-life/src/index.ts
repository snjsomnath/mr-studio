import { StreetGraph, byHighway, defineLayer, readStreetGraph, pointsAlong, seededRandom, streetLines, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest, Placed, XY } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  walkers: number;
  bikes: number;
  pace: number;
  streetlights: boolean;
  sideStreets: boolean;
  lightSpacing: number;
  lightRadius: number;
  lightColor: string;
  size: number;
  opacity: number;
}

interface Mover {
  edge: number;
  s: number;
  /** Speed relative to the kind's own, so people do not move in step. */
  pace: number;
  /** Where across the way, 0..1: on a footway somewhere across it, on a street for cars on the pavement. */
  side: number;
  paint: string;
  /** Walking sway or pedalling, radians. */
  phase: number;
  age: number;
  leaving: number | null;
}

/**
 * Street classes as the interactive map's street life used them. Walkers keep to footways and
 * paths, and to the pavements of quieter streets; cyclists to cycleways, paths and the streets
 * they share with cars.
 */
const WALK = ['footway', 'path', 'pedestrian', 'steps', 'corridor', 'track', 'cycleway', 'living_street', 'residential', 'service', 'tertiary', 'secondary'];
const PATHS = new Set(['footway', 'path', 'pedestrian', 'steps', 'corridor', 'track']);
const CYCLE = ['cycleway', 'path', 'living_street', 'residential', 'unclassified', 'tertiary', 'secondary'];
const LIT_MAIN = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link'];
const LIT_SIDE = [...LIT_MAIN, 'unclassified', 'residential', 'living_street'];

/** Real walking and cycling speeds, metres per second, before the pace control. */
const WALK_MS = 1.35;
const BIKE_MS = 4.5;
const FADE_S = 0.8;
const MAX_WALKERS = 1500;
const MAX_BIKES = 400;

/**
 * Ghostly walkers with the odd cyan accent, and cyclists in accent colours, from the interactive map.
 * The walkers' blue-greys are a step lighter than the map's, which drew them above everything at full
 * strength; here they sit among the street glow and would vanish on the dark base.
 */
const WALKER_PAINTS = ['#5d7186', '#6f8399', '#8195ab', '#64788c', '#7488a0', '#00c4c4', '#00c49e'];
const BIKE_PAINTS = ['#00f2ff', '#00cc88', '#ff6688'];

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const lights = ctx.map.addDrawing('streetlights', { opacity: ctx.params.opacity });
    const people = ctx.map.addDrawing('people', { opacity: ctx.params.opacity });
    const lines = await streetLines(ctx.site);
    const random = seededRandom(31);

    // Built in the data worker and kept per file (#484).
    const [walks, rides] = await Promise.all([
      readStreetGraph(ctx.site, { include: { highway: WALK }, major: { highway: [...PATHS], unclassed: false }, majorShare: 0.75, shortestPieceM: 40 }),
      readStreetGraph(ctx.site, { include: { highway: CYCLE }, major: { highway: ['cycleway'], unclassed: false }, majorShare: 0.5, shortestPieceM: 80 }),
    ]).then((graphs) => graphs.map((g) => g ?? new StreetGraph([])) as [StreetGraph, StreetGraph]);
    const walkers: Mover[] = [];
    const bikes: Mover[] = [];
    function spawnWalker(): Mover {
      const edge = walks.start(random);
      return {
        edge,
        s: random() * walks.edges[edge]!.length,
        pace: 0.6 + random() * 0.8,
        side: random(),
        paint: WALKER_PAINTS[Math.floor(random() * WALKER_PAINTS.length)]!,
        phase: random() * Math.PI * 2,
        age: 0,
        leaving: null,
      };
    }
    function spawnBike(): Mover {
      const edge = rides.start(random);
      return {
        edge,
        s: random() * rides.edges[edge]!.length,
        pace: 0.7 + random() * 0.6,
        side: 1.2 + random() * 0.6,
        paint: BIKE_PAINTS[Math.floor(random() * BIKE_PAINTS.length)]!,
        phase: random() * Math.PI * 2,
        age: 0,
        leaving: null,
      };
    }
    function resize() {
      const w = walks.edges.length === 0 ? 0 : Math.min(MAX_WALKERS, Math.round((walks.length / 1000) * ctx.params.walkers));
      while (walkers.length < w) walkers.push(spawnWalker());
      walkers.length = w;
      const b = rides.edges.length === 0 ? 0 : Math.min(MAX_BIKES, Math.round((rides.length / 1000) * ctx.params.bikes));
      while (bikes.length < b) bikes.push(spawnBike());
      bikes.length = b;
    }
    resize();

    /** Warm pools of light along the main streets, drawn once: they do not move. */
    function drawLights() {
      lights.clear();
      const { streetlights, sideStreets, lightSpacing, lightRadius, lightColor } = ctx.params;
      if (streetlights) {
        const lit = byHighway(sideStreets ? LIT_SIDE : LIT_MAIN, false);
        const classed = lines.some((l) => typeof l.properties.highway === 'string');
        const litLines = lines.filter((l: Placed<XY[]>) => (classed ? lit(l.properties) : true)).map((l) => l.geometry);
        const g = lights.ctx;
        g.save();
        g.globalCompositeOperation = 'lighter';
        for (const [x, y] of pointsAlong(litLines, lightSpacing)) {
          if (x < -lightRadius || y < -lightRadius || x > lights.width + lightRadius || y > lights.height + lightRadius) continue;
          const pool = g.createRadialGradient(x, y, 0, x, y, lightRadius);
          pool.addColorStop(0, withAlpha(lightColor, 0.6));
          pool.addColorStop(0.3, withAlpha(lightColor, 0.12));
          pool.addColorStop(0.7, withAlpha(lightColor, 0.05));
          pool.addColorStop(1, withAlpha(lightColor, 0));
          g.fillStyle = pool;
          g.beginPath();
          g.arc(x, y, lightRadius, 0, Math.PI * 2);
          g.fill();
          // The lamp itself, a small bright point.
          g.fillStyle = withAlpha('#fff4dc', 0.9);
          g.beginPath();
          g.arc(x, y, 0.9, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }
      lights.commit();
    }
    drawLights();

    /** Moves someone on; false when they have gone and should start again elsewhere. */
    function move(m: Mover, network: StreetGraph, metresPerSecond: number, dt: number): boolean {
      m.age += dt;
      if (m.leaving !== null && (m.leaving -= dt) <= 0) return false;
      m.s += metresPerSecond * m.pace * dt;
      m.phase += dt * m.pace * 6;
      let edge = network.edges[m.edge]!;
      for (let hops = 0; m.s >= edge.length && hops < 8; hops++) {
        const next = network.next(m.edge, random, 0.55);
        if (next === null) {
          m.s = edge.length;
          m.leaving ??= FADE_S;
          break;
        }
        m.s -= edge.length;
        m.edge = next;
        edge = network.edges[m.edge]!;
      }
      return true;
    }
    const alphaOf = (m: Mover) => Math.min(1, m.age / FADE_S, m.leaving === null ? 1 : Math.max(0, m.leaving / FADE_S));
    const offscreen = (x: number, y: number) => x < -20 || y < -20 || x > people.width + 20 || y > people.height + 20;

    ctx.onFrame((dt) => {
      const { pace, size } = ctx.params;
      for (let i = 0; i < walkers.length; i++) if (!move(walkers[i]!, walks, WALK_MS * pace, dt)) walkers[i] = spawnWalker();
      for (let i = 0; i < bikes.length; i++) if (!move(bikes[i]!, rides, BIKE_MS * pace, dt)) bikes[i] = spawnBike();

      const g = people.ctx;
      people.clear();
      // Walkers: soft dots that sway a little across their way, batched by colour.
      const r = 0.75 * size;
      for (const paint of WALKER_PAINTS) {
        g.fillStyle = paint;
        for (const m of walkers) {
          if (m.paint !== paint) continue;
          // Footways and paths are the network's main lines (`major`); on other streets, keep to the pavement.
          const across = walks.edges[m.edge]!.major ? (m.side - 0.5) * 2 : 4 + m.side * 1.5;
          const [x, y] = walks.at(m.edge, m.s, across + Math.sin(m.phase) * 0.4);
          if (offscreen(x, y)) continue;
          g.globalAlpha = alphaOf(m);
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fill();
        }
      }
      // Cyclists: a bright core in their colour, a short lamp beam ahead and a red rear light.
      for (const m of bikes) {
        const [x, y] = rides.at(m.edge, m.s, m.side);
        if (offscreen(x, y)) continue;
        const angle = rides.edges[m.edge]!.angle;
        g.save();
        g.globalAlpha = alphaOf(m);
        g.translate(x, y);
        g.rotate(angle);
        g.scale(size, size);
        g.globalCompositeOperation = 'lighter';
        const beam = g.createLinearGradient(0.6, 0, 5, 0);
        beam.addColorStop(0, 'rgb(255 255 220 / 0.5)');
        beam.addColorStop(1, 'rgb(255 255 200 / 0)');
        g.fillStyle = beam;
        g.beginPath();
        g.moveTo(0.6, 0);
        g.lineTo(5, -1.1);
        g.lineTo(5, 1.1);
        g.closePath();
        g.fill();
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = m.paint;
        g.beginPath();
        g.ellipse(0, 0, 1, 0.55, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(0.15, 0, 0.3, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#ff4444';
        g.beginPath();
        g.arc(-1, 0, 0.25, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      g.globalAlpha = 1;
      people.commit();
      ctx.publish({ walkers: walkers.length, bikes: bikes.length });
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) {
          lights.setOpacity(ctx.params.opacity);
          people.setOpacity(ctx.params.opacity);
        }
        if (changed.includes('walkers') || changed.includes('bikes')) resize();
        if (changed.some((c) => ['streetlights', 'sideStreets', 'lightSpacing', 'lightRadius', 'lightColor'].includes(c))) drawLights();
      },
    };
  },
});
