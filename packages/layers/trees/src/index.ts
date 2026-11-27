import { SPRITE_FLOATS, readSiteGeometry, defineLayer, seededRandom, tableSpace, withAlpha } from '@mrstudio/sdk';
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
    // Crowns are one picture the graphics card stamps for every tree (#609), placed every frame.
    const crowns = ctx.map.addSprites('crowns', [crownSprite(ctx.params.color)], { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);
    const random = seededRandom(11);
    const trees: Tree[] = ((await readSiteGeometry(ctx.site, 'trees'))?.points ?? [])
      .filter(({ geometry: [x, y] }) => x > -20 && y > -20 && x < space.width + 20 && y < space.height + 20)
      .map(({ geometry: [x, y], properties }) => ({
        x,
        y,
        // Taller trees have wider crowns.
        radius: 2 + (Number(properties.height) || 8) * 0.22,
        phase: random() * Math.PI * 2,
      }));
    let time = 0;
    const buffer = new Float32Array(trees.length * SPRITE_FLOATS);
    /** Whether the crowns have been placed since the wind dropped to nothing. */
    let still = false;

    ctx.onFrame((dt) => {
      time += dt;
      const { size, sway } = ctx.params;
      // With no wind the crowns are placed once and left.
      if (sway === 0 && still) return;
      still = sway === 0;
      trees.forEach((tree, t) => {
        const r = tree.radius * size;
        // A gust travels across the table, so neighbouring trees lean together.
        const gust = Math.sin(time * 0.9 + tree.x * 0.012 + tree.phase * 0.3) + 0.4 * Math.sin(time * 2.3 + tree.phase);
        const o = t * SPRITE_FLOATS;
        buffer[o] = tree.x + gust * sway * 0.6;
        buffer[o + 1] = tree.y + Math.cos(time * 0.7 + tree.phase) * sway * 0.25;
        buffer[o + 2] = r * 2;
        buffer[o + 3] = r * 2;
        buffer[o + 4] = 0;
        buffer[o + 5] = 0;
        buffer[o + 6] = 1;
      });
      crowns.set(buffer, trees.length);
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) crowns.setOpacity(ctx.params.opacity);
        if (changed.includes('color')) crowns.setImages([crownSprite(ctx.params.color)]);
        still = false;
      },
    };
  },
});
