import { defineLayer, geojsonPoints, loadSiteData, seededRandom, tableSpace, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  color: string;
  size: number;
  sway: number;
  opacity: number;
}

interface Tree {
  x: number;
  y: number;
  radius: number;
  phase: number;
}

/** Seconds between redraws. Leaves move slowly, so there is no need to draw every frame. */
const FRAME_S = 1 / 24;

/** A soft crown, drawn once and stamped for every tree. */
function crownSprite(color: string): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 96;
  const g = sprite.getContext('2d')!;
  const gradient = g.createRadialGradient(40, 40, 4, 48, 48, 48);
  gradient.addColorStop(0, withAlpha(color, 0.95));
  gradient.addColorStop(0.55, withAlpha(color, 0.6));
  gradient.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = gradient;
  g.fillRect(0, 0, 96, 96);
  return sprite;
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addCanvas('crowns', { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);
    const random = seededRandom(11);
    const trees: Tree[] = geojsonPoints(await loadSiteData(ctx.site, 'trees'), space)
      .filter(({ geometry: [x, y] }) => x > -20 && y > -20 && x < space.width + 20 && y < space.height + 20)
      .map(({ geometry: [x, y], properties }) => ({
        x,
        y,
        // Taller trees have wider crowns.
        radius: 2 + (Number(properties.height) || 8) * 0.22,
        phase: random() * Math.PI * 2,
      }));
    let sprite = crownSprite(ctx.params.color);
    let time = 0;
    let since = Infinity;

    ctx.onFrame((dt) => {
      time += dt;
      since += dt;
      if (since < FRAME_S) return;
      since = 0;
      const { size, sway } = ctx.params;
      canvas.clear();
      for (const tree of trees) {
        const r = tree.radius * size;
        // A gust travels across the table, so neighbouring trees lean together.
        const gust = Math.sin(time * 0.9 + tree.x * 0.012 + tree.phase * 0.3) + 0.4 * Math.sin(time * 2.3 + tree.phase);
        const dx = gust * sway * 0.6;
        const dy = Math.cos(time * 0.7 + tree.phase) * sway * 0.25;
        canvas.ctx.drawImage(sprite, tree.x - r + dx, tree.y - r + dy, r * 2, r * 2);
      }
      canvas.commit();
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('color')) sprite = crownSprite(ctx.params.color);
        since = Infinity;
      },
    };
  },
});
