import { defineLayer, geojsonPolygons, insidePolygon, readSiteData, seededRandom, tableSpace } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  lit: number;
  color: string;
  pace: number;
  opacity: number;
}

interface Light {
  x: number;
  y: number;
  /** Lit when `lit` is above this, so raising the control lights more windows rather than different ones. */
  threshold: number;
  /** Current and target brightness, 0..1. */
  level: number;
  target: number;
  /** Seconds until this window next changes its mind. */
  wait: number;
}

/** Distance between windows in metres, and the most windows worth drawing. */
const SPACING_M = 7;
const MAX_LIGHTS = 12_000;
const WINDOW_M = 2.6;
const FRAME_S = 1 / 15;

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('windows', { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);
    const random = seededRandom(23);
    const buildings = geojsonPolygons(await readSiteData(ctx.site, 'buildings'), space);

    // Windows sit on a grid inside each footprint. A coarser grid is used when a site is very built up.
    const lights: Light[] = [];
    for (let spacing = SPACING_M; ; spacing *= 1.4) {
      lights.length = 0;
      for (const { geometry: rings } of buildings) {
        const outer = rings[0] ?? [];
        const xs = outer.map((p) => p[0]);
        const ys = outer.map((p) => p[1]);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        if (x1 < 0 || y1 < 0 || x0 > space.width || y0 > space.height) continue;
        const offsetX = random() * spacing;
        const offsetY = random() * spacing;
        for (let y = y0 + offsetY; y < y1; y += spacing) {
          for (let x = x0 + offsetX; x < x1; x += spacing) {
            if (insidePolygon(rings, x, y)) lights.push({ x, y, threshold: random(), level: 0, target: 0, wait: random() * 4 });
          }
        }
      }
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
      g.fillStyle = color;
      for (const light of lights) {
        light.wait -= step * pace;
        if (light.wait <= 0) {
          // Most windows follow the control; a few are switched the other way for a while, which is the twinkle.
          const on = light.threshold < lit;
          light.target = random() < 0.12 ? (on ? 0.15 : lit > 0 ? 0.7 : 0) : on ? 0.55 + random() * 0.45 : 0;
          light.wait = 2 + random() * 14;
        }
        light.level += (light.target - light.level) * Math.min(1, step * 2.5);
        if (light.level < 0.02) continue;
        g.globalAlpha = light.level;
        g.fillRect(light.x - WINDOW_M / 2, light.y - WINDOW_M / 2, WINDOW_M, WINDOW_M);
      }
      g.globalAlpha = 1;
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
