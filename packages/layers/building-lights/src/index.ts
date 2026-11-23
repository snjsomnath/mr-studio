import { defineLayer, geojsonPolygons, readSiteData, seededRandom, tableSpace } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  lit: number;
  color: string;
  pace: number;
  opacity: number;
}

interface Light {
  /** The window: a short dash along a facade, from (x0, y0) to (x1, y1) in table metres. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Which building it is on, for the building's own tint and its brief blackouts. */
  building: number;
  /** Lit when `lit` is above this, so raising the control lights more windows rather than different ones. */
  threshold: number;
  /** Current and target brightness, 0..1. */
  level: number;
  target: number;
  /** Seconds until this window next changes its mind. */
  wait: number;
}

interface Building {
  rings: [number, number][][];
  /** About one building in five is lit white; the rest are warm. */
  white: boolean;
  /** How bright its windows are, so the city is not one even glow. */
  brightness: number;
  /** Seconds left in a blackout, when the whole building goes dark for a moment. */
  dark: number;
}

/** Windows along the facades, as in the interactive map: lit dashes on the footprint outline, seen from above. */
const WINDOW_M = 3;
const GAP_M = 4.5;
/** The most windows worth drawing; a very built-up site spaces them further apart. */
const MAX_LIGHTS = 20_000;
const FRAME_S = 1 / 15;
/** The facade line, and the soft glow under it, in metres. */
const LINE_M = 1.4;
const GLOW_M = 5;
const WHITE = '#ffffff';

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('windows', { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);
    const random = seededRandom(23);
    const footprints = geojsonPolygons(await readSiteData(ctx.site, 'buildings'), space);

    const buildings: Building[] = [];
    for (const { geometry: rings } of footprints) {
      const outer = rings[0] ?? [];
      const xs = outer.map((p) => p[0]);
      const ys = outer.map((p) => p[1]);
      if (Math.max(...xs) < 0 || Math.max(...ys) < 0 || Math.min(...xs) > space.width || Math.min(...ys) > space.height) continue;
      const index = buildings.length;
      buildings.push({ rings, white: (index * 7) % 5 === 0, brightness: 0.55 + (((index * 7) % 13) / 13) * 0.45, dark: 0 });
    }

    // Windows walk each facade, courtyards included, from a random start so rows do not line up.
    const lights: Light[] = [];
    for (let scale = 1; ; scale *= 1.4) {
      lights.length = 0;
      const step = (WINDOW_M + GAP_M) * scale;
      buildings.forEach((building, b) => {
        for (const ring of building.rings) {
          let carry = random() * step;
          for (let i = 0; i + 1 < ring.length; i++) {
            const [ax, ay] = ring[i]!;
            const [bx, by] = ring[i + 1]!;
            const length = Math.hypot(bx - ax, by - ay);
            if (length === 0) continue;
            const [ux, uy] = [(bx - ax) / length, (by - ay) / length];
            for (let d = carry; d + WINDOW_M <= length; d += step) {
              lights.push({ x0: ax + ux * d, y0: ay + uy * d, x1: ax + ux * (d + WINDOW_M), y1: ay + uy * (d + WINDOW_M), building: b, threshold: random(), level: 0, target: 0, wait: random() * 4 });
            }
            // The next edge carries on the rhythm where this one left it.
            carry = Math.max(0, carry + Math.ceil(Math.max(0, length - carry) / step) * step - length);
          }
        }
      });
      if (lights.length <= MAX_LIGHTS) break;
    }

    let since = Infinity;
    ctx.onFrame((dt) => {
      since += dt;
      if (since < FRAME_S) return;
      const step = Math.min(since, 0.25);
      since = 0;
      const { lit, color, pace } = ctx.params;
      const g = canvas.ctx;
      canvas.clear();
      // Now and then a whole building goes dark for a moment, as in the interactive map.
      for (const building of buildings) {
        if (building.dark > 0) building.dark -= step * pace;
        else if (random() < 0.004 * pace) building.dark = 0.3 + random() * 1.4;
      }
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      // A soft glow along every lit building's outline, so the facades read as lit from within.
      g.lineWidth = GLOW_M;
      g.lineJoin = 'round';
      buildings.forEach((building) => {
        if (building.dark > 0 || lit <= 0) return;
        g.strokeStyle = building.white ? WHITE : color;
        g.globalAlpha = 0.12 * building.brightness * Math.min(1, lit * 2);
        g.beginPath();
        for (const ring of building.rings) {
          ring.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
          g.closePath();
        }
        g.stroke();
      });
      // The windows themselves: dashes along the facade that come on and go off.
      g.lineWidth = LINE_M;
      for (const light of lights) {
        light.wait -= step * pace;
        if (light.wait <= 0) {
          // Most windows follow the control; a few are switched the other way for a while, which is the twinkle.
          const on = light.threshold < lit;
          light.target = random() < 0.12 ? (on ? 0.15 : lit > 0 ? 0.7 : 0) : on ? 0.55 + random() * 0.45 : 0;
          light.wait = 2 + random() * 14;
        }
        light.level += (light.target - light.level) * Math.min(1, step * 2.5);
        const building = buildings[light.building]!;
        if (light.level < 0.02 || building.dark > 0) continue;
        g.strokeStyle = building.white ? WHITE : color;
        g.globalAlpha = light.level * building.brightness;
        g.beginPath();
        g.moveTo(light.x0, light.y0);
        g.lineTo(light.x1, light.y1);
        g.stroke();
      }
      g.restore();
      canvas.commit();
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        // Respond to the slider now rather than as each window's timer runs out.
        if (changed.includes('lit')) for (const light of lights) light.wait = Math.min(light.wait, random() * 1.5);
      },
    };
  },
});
