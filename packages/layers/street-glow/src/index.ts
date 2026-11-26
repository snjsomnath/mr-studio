import { StreetGraph, defineLayer, highwayClass, readStreetGraph, seededRandom, streetLines } from '@mrstudio/sdk';
import type { DrawingOverlay, LayerManifest, XY } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  brightness: number;
  pulse: number;
  particles: number;
  width: number;
  glow: number;
  reveal: boolean;
  opacity: number;
}

/** Colours by OpenStreetMap `highway` class, as the interactive map's Street Glow had them. */
const COLOURS: Record<string, string> = {
  motorway: '255 50 50',
  trunk: '255 120 50',
  primary: '255 200 50',
  secondary: '50 255 150',
  tertiary: '50 180 255',
  unclassified: '180 150 255',
  residential: '50 255 100',
  living_street: '200 255 50',
  service: '220 220 220',
  pedestrian: '255 100 255',
  footway: '255 80 255',
  cycleway: '100 255 255',
  path: '150 255 150',
  track: '200 200 120',
};
const OTHER = '180 180 180';
/** `motorway_link` glows as its road does. */
const colourOf = (kind: string) => COLOURS[kind.replace(/_link$/, '')] ?? OTHER;

/** Seconds between one kind of street and the next lighting up, as in the interactive map. */
const REVEAL_S = 0.5;
const MAX_PARTICLES = 1500;
const FRAME_S = 1 / 30;

interface Kind {
  name: string;
  rgb: string;
  path: Path2D;
  network: StreetGraph;
  /** Which group of streets this kind is drawn with: see `GROUPS`. */
  group: number;
  /** A light in this kind's colour with a white-hot centre, stamped for every particle (#596). */
  sprite: HTMLCanvasElement;
}

/** A group's streets, drawn once at full strength; its pulse and reveal are the canvas's opacity (#596). */
interface Group {
  streets: DrawingOverlay;
  kinds: Kind[];
  /** The opacity last given to `streets`, so an unchanged one is not set again. */
  shown: number;
}

interface Particle {
  kind: number;
  edge: number;
  s: number;
  speed: number;
  phase: number;
}

/**
 * The longest kinds of street each pulse and reveal on their own; the rest go together in the last
 * group. Each group is one picture on the map, so a few of them keep the table's drawing cheap.
 */
const GROUPS = 4;

/** Sprite size in pixels; the light is drawn scaled to its radius. */
const SPRITE_PX = 32;

function lightSprite(rgb: string): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = SPRITE_PX;
  const g = sprite.getContext('2d')!;
  const half = SPRITE_PX / 2;
  const dot = g.createRadialGradient(half, half, 0, half, half, half);
  dot.addColorStop(0, 'rgb(255 255 255 / 0.9)');
  dot.addColorStop(0.3, `rgb(${rgb} / 0.7)`);
  dot.addColorStop(1, `rgb(${rgb} / 0)`);
  g.fillStyle = dot;
  g.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return sprite;
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const lines = await streetLines(ctx.site);
    const random = seededRandom(17);

    // One stroke path per kind of street, longest kinds first so the reveal starts with the bulk.
    const byKind = new Map<string, XY[][]>();
    const forKind = new Map<string, typeof lines>();
    for (const line of lines) {
      const name = highwayClass(line.properties) ?? 'street';
      if (!byKind.has(name)) {
        byKind.set(name, []);
        forKind.set(name, []);
      }
      byKind.get(name)!.push(line.geometry);
      forKind.get(name)!.push(line);
    }
    // Each kind's graph is built in the data worker and kept per file (#484); lines with no class are 'street'.
    const kinds: Kind[] = await Promise.all(
      [...byKind.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(async ([name, polylines]) => {
          const path = new Path2D();
          for (const line of polylines) {
            line.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
          }
          const network =
            (await readStreetGraph(ctx.site, { include: { highway: [name], unclassed: name === 'street' }, shortestPieceM: 0 })) ?? new StreetGraph(forKind.get(name)!, { shortestPieceM: 0 });
          const rgb = colourOf(name);
          return { name, rgb, path, network, group: 0, sprite: lightSprite(rgb) };
        }),
    );
    const total = kinds.reduce((sum, k) => sum + k.network.length, 0);

    // Redrawing every street many times a second is what made the table crawl in WebKit, where a
    // 2D canvas is drawn on the processor (#596). The streets are drawn once, a group of kinds to a
    // canvas, and only the flowing lights are drawn again.
    const groups: Group[] = [];
    kinds.forEach((kind, i) => {
      kind.group = Math.min(i, GROUPS - 1);
      groups[kind.group] ??= { streets: ctx.map.addDrawing(`streets-${kind.group}`, { opacity: 0 }), kinds: [], shown: -1 };
      groups[kind.group]!.kinds.push(kind);
    });
    const lights = ctx.map.addDrawing('street-glow', { opacity: ctx.params.opacity });
    function drawStreets() {
      for (const group of groups) {
        group.streets.clear();
        for (const kind of group.kinds) strokeKind(group.streets.ctx, kind, 1);
        group.streets.commit();
      }
    }
    /** One kind's glow and line at strength `alpha`. */
    function strokeKind(g: CanvasRenderingContext2D, kind: Kind, alpha: number) {
      const { width, glow } = ctx.params;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      if (glow > 0) {
        g.strokeStyle = `rgb(${kind.rgb} / ${alpha * 0.18})`;
        g.lineWidth = glow;
        g.stroke(kind.path);
        g.strokeStyle = `rgb(${kind.rgb} / ${alpha * 0.25})`;
        g.lineWidth = glow * 0.45;
        g.stroke(kind.path);
      }
      g.strokeStyle = `rgb(${kind.rgb} / ${alpha})`;
      g.lineWidth = width;
      g.stroke(kind.path);
    }
    drawStreets();

    const particles: Particle[] = [];
    function spawn(): Particle {
      // By length, so each kind of street gets its share.
      let at = random() * total;
      let kind = 0;
      while (kind < kinds.length - 1 && at > kinds[kind]!.network.length) at -= kinds[kind++]!.network.length;
      const network = kinds[kind]!.network;
      const edge = network.edges.length ? network.start(random) : 0;
      return { kind, edge, s: random() * (network.edges[edge]?.length ?? 0), speed: 8 + random() * 14, phase: random() * Math.PI * 2 };
    }
    function resize() {
      const wanted = Math.min(MAX_PARTICLES, Math.round((total / 1000) * ctx.params.particles));
      while (particles.length < wanted) particles.push(spawn());
      particles.length = wanted;
    }
    resize();

    let clock = 0;
    let wait = 0;
    /** How strongly group `i` shows now: the slow breath of the network, its own pulse and the reveal. */
    function strength(i: number): number {
      const { brightness, pulse, reveal } = ctx.params;
      const shown = reveal ? Math.max(0, Math.min(1, clock / REVEAL_S - i)) : 1;
      if (shown <= 0) return 0;
      // The whole network breathes slowly, and each kind of street pulses a little out of step.
      const breathe = 1 - pulse * 0.5 + Math.sin(clock) * pulse * 0.5;
      const beat = 1 - pulse + pulse * (0.6 + Math.sin(clock * 3 + i) * 0.4);
      return Math.min(1, brightness * breathe * beat * shown * 1.3);
    }
    ctx.onFrame((dt) => {
      clock += dt;
      // A soft glow does not need every frame.
      if ((wait -= dt) > 0) return;
      wait = FRAME_S;
      groups.forEach((group, i) => {
        const opacity = Math.round(strength(i) * ctx.params.opacity * 200) / 200;
        if (opacity === group.shown) return;
        group.shown = opacity;
        group.streets.setOpacity(opacity);
      });
      if (particles.length === 0) return;
      // Lights flowing along the streets move on.
      for (let p = 0; p < particles.length; p++) {
        const particle = particles[p]!;
        const network = kinds[particle.kind]!.network;
        if (network.edges.length === 0) continue;
        particle.s += particle.speed * FRAME_S;
        if (particle.s >= network.edges[particle.edge]!.length) {
          const next = network.next(particle.edge, random, 0.7);
          if (next === null) {
            particles[p] = spawn();
            continue;
          }
          particle.s = 0;
          particle.edge = next;
        }
      }
      lights.clear();
      paintLights(lights.ctx);
      lights.commit();
    });

    /** The lights flowing along the streets, each in its street's colour with a white-hot centre. */
    function paintLights(g: CanvasRenderingContext2D) {
      const { width, reveal } = ctx.params;
      const r = Math.max(2.5, width * 2.2);
      const alpha = g.globalAlpha;
      g.globalCompositeOperation = 'lighter';
      for (const particle of particles) {
        const kind = kinds[particle.kind]!;
        const network = kind.network;
        if (network.edges.length === 0 || particle.s >= network.edges[particle.edge]!.length) continue;
        const shown = reveal ? Math.max(0, Math.min(1, clock / REVEAL_S - kind.group)) : 1;
        if (shown <= 0) continue;
        const [x, y] = network.at(particle.edge, particle.s);
        g.globalAlpha = alpha * (0.6 + 0.4 * Math.sin(clock * 4 + particle.phase)) * shown;
        g.drawImage(kind.sprite, x - r, y - r, r * 2, r * 2);
      }
      g.globalAlpha = alpha;
      g.globalCompositeOperation = 'source-over';
    }

    /** Draws the streets and their lights as they are now into `g`, in table metres: a magnifier's sharp picture (#413). */
    function paint(g: CanvasRenderingContext2D) {
      for (const kind of kinds) {
        const alpha = strength(kind.group);
        if (alpha > 0) strokeKind(g, kind, alpha);
      }
      paintLights(g);
    }
    ctx.map.addDetail((g) => {
      g.globalAlpha = ctx.params.opacity;
      paint(g);
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) lights.setOpacity(ctx.params.opacity);
        if (changed.includes('particles')) resize();
        if (changed.includes('width') || changed.includes('glow')) drawStreets();
      },
    };
  },
});
