import { StreetGraph, defineLayer, highwayClass, seededRandom, streetLines } from '@mrstudio/sdk';
import type { LayerManifest, XY } from '@mrstudio/sdk';

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
}

interface Particle {
  kind: number;
  edge: number;
  s: number;
  speed: number;
  phase: number;
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('street-glow', { opacity: ctx.params.opacity });
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
    const kinds: Kind[] = [...byKind.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, polylines]) => {
        const path = new Path2D();
        for (const line of polylines) {
          line.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
        }
        return { name, rgb: colourOf(name), path, network: new StreetGraph(forKind.get(name)!, { shortestPieceM: 0 }) };
      });
    const total = kinds.reduce((sum, k) => sum + k.network.length, 0);

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
    ctx.onFrame((dt) => {
      clock += dt;
      // A soft glow does not need every frame.
      if ((wait -= dt) > 0) return;
      wait = FRAME_S;
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
      canvas.clear();
      paint(canvas.ctx);
      canvas.commit();
    });

    /** Draws the streets and their lights as they are now into `g`, in table metres: the table, and a magnifier's sharp picture (#413). */
    function paint(g: CanvasRenderingContext2D) {
      const { brightness, pulse, width, glow, reveal } = ctx.params;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      // The whole network breathes slowly, and each kind of street pulses a little out of step.
      const breathe = 1 - pulse * 0.5 + Math.sin(clock) * pulse * 0.5;
      kinds.forEach((kind, i) => {
        const shown = reveal ? Math.max(0, Math.min(1, clock / REVEAL_S - i)) : 1;
        if (shown <= 0) return;
        const beat = 1 - pulse + pulse * (0.6 + Math.sin(clock * 3 + i) * 0.4);
        const alpha = Math.min(1, brightness * breathe * beat * shown * 1.3);
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
      });

      // Lights flowing along the streets, each in its street's colour with a white-hot centre.
      g.globalCompositeOperation = 'lighter';
      for (const particle of particles) {
        const kind = kinds[particle.kind]!;
        const network = kind.network;
        if (network.edges.length === 0 || particle.s >= network.edges[particle.edge]!.length) continue;
        const shown = reveal ? Math.max(0, Math.min(1, clock / REVEAL_S - particle.kind)) : 1;
        if (shown <= 0) continue;
        const [x, y] = network.at(particle.edge, particle.s);
        const twinkle = 0.6 + 0.4 * Math.sin(clock * 4 + particle.phase);
        const r = Math.max(2.5, width * 2.2);
        const dot = g.createRadialGradient(x, y, 0, x, y, r);
        dot.addColorStop(0, `rgb(255 255 255 / ${0.9 * twinkle * shown})`);
        dot.addColorStop(0.3, `rgb(${kind.rgb} / ${0.7 * twinkle * shown})`);
        dot.addColorStop(1, `rgb(${kind.rgb} / 0)`);
        g.fillStyle = dot;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
    }
    ctx.map.addDetail((g) => {
      g.globalAlpha = ctx.params.opacity;
      paint(g);
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('particles')) resize();
      },
    };
  },
});
