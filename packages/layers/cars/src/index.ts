import { defineLayer, seededRandom, streetLines } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { Network } from './network.ts';

interface Params {
  density: number;
  speed: number;
  size: number;
  headlights: boolean;
  opacity: number;
}

interface Car {
  edge: number;
  /** Metres travelled along the edge. */
  s: number;
  /** This driver's speed relative to the control. */
  pace: number;
  /** Drawn heading, eased towards the edge's so turns are not instant. */
  angle: number;
  paint: string;
  /** Seconds since the car came onto the street, for fading in. */
  age: number;
  /** Seconds left before the car is gone, once it has reached a dead end. */
  leaving: number | null;
}

/** Seconds a car takes to fade in, or out at a dead end. */
const FADE_S = 0.8;

const MAX_CARS = 600;
/** Cars keep right of the centre line by this many metres. */
const LANE_M = 1.8;
const CAR_M = { length: 4.4, width: 1.9 };
const PAINTS = ['#d7dde8', '#9aa4b5', '#5c6a82', '#c9b458', '#b5513c', '#3f6fb5', '#e8e8e8'];

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('cars', { opacity: ctx.params.opacity });
    // No streets, no cars: the editor offers to bring streets in (requires.data).
    const lines = await streetLines(ctx.site);
    const network = new Network(lines);
    const random = seededRandom(5);
    const cars: Car[] = [];

    function spawn(): Car {
      const edge = network.start(random);
      return {
        edge,
        s: random() * network.edges[edge]!.length,
        pace: 0.7 + random() * 0.6,
        angle: network.edges[edge]!.angle,
        paint: PAINTS[Math.floor(random() * PAINTS.length)]!,
        age: 0,
        leaving: null,
      };
    }

    function resize() {
      const wanted = network.edges.length === 0 ? 0 : Math.min(MAX_CARS, Math.round((network.length / 1000) * ctx.params.density));
      while (cars.length < wanted) cars.push(spawn());
      cars.length = wanted;
    }
    resize();

    ctx.onFrame((dt) => {
      const { speed, size, headlights } = ctx.params;
      const g = canvas.ctx;
      const metresPerSecond = speed / 3.6;
      canvas.clear();
      for (let i = 0; i < cars.length; i++) {
        let car = cars[i]!;
        car.age += dt;
        if (car.leaving !== null) {
          car.leaving -= dt;
          // Gone: the car starts again somewhere else, as in the interactive map's traffic.
          if (car.leaving <= 0) car = cars[i] = spawn();
        }
        car.s += metresPerSecond * car.pace * dt;
        let edge = network.edges[car.edge]!;
        // A fast car on short segments may pass more than one junction in a frame.
        for (let hops = 0; car.s >= edge.length && hops < 8; hops++) {
          const next = network.next(car.edge, random);
          if (next === null) {
            // A dead end: the car stops at the end and fades, rather than turning round on the spot (#201).
            car.s = edge.length;
            car.leaving ??= FADE_S;
            break;
          }
          car.s -= edge.length;
          car.edge = next;
          edge = network.edges[car.edge]!;
        }
        const alpha = Math.min(1, car.age / FADE_S, car.leaving === null ? 1 : Math.max(0, car.leaving / FADE_S));
        const turn = Math.atan2(Math.sin(edge.angle - car.angle), Math.cos(edge.angle - car.angle));
        car.angle += turn * Math.min(1, dt * 6);
        const [x0, y0] = network.nodes[edge.from]!;
        const x = x0 + Math.cos(edge.angle) * car.s - Math.sin(edge.angle) * LANE_M;
        const y = y0 + Math.sin(edge.angle) * car.s + Math.cos(edge.angle) * LANE_M;
        if (x < -30 || y < -30 || x > canvas.width + 30 || y > canvas.height + 30) continue;

        g.save();
        g.globalAlpha = alpha;
        g.translate(x, y);
        g.rotate(car.angle);
        g.scale(size, size);
        const { length, width } = CAR_M;
        if (headlights) {
          // Two beams ahead, added to whatever is below so they read as light.
          g.globalCompositeOperation = 'lighter';
          const beam = g.createLinearGradient(length / 2, 0, length / 2 + 11, 0);
          beam.addColorStop(0, 'rgb(255 244 214 / 0.45)');
          beam.addColorStop(1, 'rgb(255 244 214 / 0)');
          g.fillStyle = beam;
          g.beginPath();
          g.moveTo(length / 2, -width / 2);
          g.lineTo(length / 2 + 11, -width * 1.2);
          g.lineTo(length / 2 + 11, width * 1.2);
          g.lineTo(length / 2, width / 2);
          g.fill();
          g.globalCompositeOperation = 'source-over';
        }
        g.fillStyle = car.paint;
        g.beginPath();
        g.roundRect(-length / 2, -width / 2, length, width, 0.6);
        g.fill();
        g.fillStyle = 'rgb(255 60 50 / 0.95)';
        g.fillRect(-length / 2 - 0.2, -width / 2, 0.6, 0.5);
        g.fillRect(-length / 2 - 0.2, width / 2 - 0.5, 0.6, 0.5);
        if (headlights) {
          g.fillStyle = 'rgb(255 250 230)';
          g.fillRect(length / 2 - 0.4, -width / 2, 0.6, 0.5);
          g.fillRect(length / 2 - 0.4, width / 2 - 0.5, 0.6, 0.5);
        }
        g.restore();
      }
      canvas.commit();
      ctx.publish({ cars: cars.length });
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('density')) resize();
      },
    };
  },
});
