import { readSiteGeometry, defineLayer, seededRandom, tableSpace, withAlpha } from '@mrstudio/sdk';
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
/**
 * The trees are split over this many pictures, and each redraw makes only one of them again, so a
 * city's trees cost a third as much a frame (#596). Each tree still moves eight times a second,
 * plenty for a crown that leans a metre or so.
 */
const PARTS = 3;

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
    const canvases = Array.from({ length: PARTS }, (_, i) => ctx.map.addDrawing(i === 0 ? 'crowns' : `crowns-${i}`, { opacity: ctx.params.opacity }));
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
    let sprite = crownSprite(ctx.params.color);
    let time = 0;
    let since = Infinity;
    let turn = 0;
    /** Parts still to draw before the trees stand still, when there is no wind. */
    let still = PARTS;

    function draw(part: number) {
      const { size, sway } = ctx.params;
      const canvas = canvases[part]!;
      canvas.clear();
      for (let t = part; t < trees.length; t += PARTS) {
        const tree = trees[t]!;
        const r = tree.radius * size;
        // A gust travels across the table, so neighbouring trees lean together.
        const gust = Math.sin(time * 0.9 + tree.x * 0.012 + tree.phase * 0.3) + 0.4 * Math.sin(time * 2.3 + tree.phase);
        const dx = gust * sway * 0.6;
        const dy = Math.cos(time * 0.7 + tree.phase) * sway * 0.25;
        canvas.ctx.drawImage(sprite, tree.x - r + dx, tree.y - r + dy, r * 2, r * 2);
      }
      canvas.commit();
    }

    ctx.onFrame((dt) => {
      time += dt;
      since += dt;
      if (since < FRAME_S) return;
      since = 0;
      // With no wind the crowns are drawn once and left.
      if (ctx.params.sway === 0) {
        if (still === 0) return;
        still -= 1;
      } else still = PARTS;
      draw(turn);
      turn = (turn + 1) % PARTS;
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) for (const canvas of canvases) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('color')) sprite = crownSprite(ctx.params.color);
        // A new colour or size shows on every tree at once.
        for (let part = 0; part < PARTS; part++) draw(part);
        still = PARTS;
      },
    };
  },
});
