import { clipToTable, defineLayer, tableFrame, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { seams } from './seams.ts';

/** Seconds for one breath of the glow, and for a ripple to travel the grid. */
const PULSE_S = 2.4;
const RIPPLE_S = 3.2;

interface Params {
  color: string;
  pulse: boolean;
  nodes: boolean;
  width: number;
  glow: number;
  /** A tile size other than the table's; 0 takes `table.tile_cm`. */
  tile_cm: number;
}

/**
 * The Chalmers demo's grid animation (#191): the model's tile seams drawn on the table in a
 * glowing line that breathes, with a node at every crossing and ripples running out from the
 * centre. Used to check that the projection lands on the physical tiles.
 */
export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  table(ctx) {
    const canvas = ctx.map.addCanvas('grid');
    const frame = tableFrame(ctx.site);
    let clock = 0;

    function draw(): void {
      const g = canvas.context;
      const p = ctx.params;
      canvas.clear();
      const { xs, ys } = seams(ctx.site, p.tile_cm);
      const at = (x: number, y: number) => canvas.project(frame.toLonLat([x, y]));
      const breath = p.pulse ? 0.5 + 0.5 * Math.sin((clock / PULSE_S) * Math.PI * 2) : 1;
      const width = p.width;

      g.save();
      clipToTable(canvas, ctx.site);
      g.lineCap = 'round';
      // The glow: wide faint strokes under a sharp core.
      const stroke = (alpha: number, lineWidth: number, blur: number) => {
        g.strokeStyle = withAlpha(p.color, alpha);
        g.lineWidth = lineWidth;
        g.shadowColor = p.color;
        g.shadowBlur = blur;
        g.beginPath();
        for (const x of xs) {
          const [a, b] = [at(x, 0), at(x, ys[ys.length - 1]!)];
          g.moveTo(a[0], a[1]);
          g.lineTo(b[0], b[1]);
        }
        for (const y of ys) {
          const [a, b] = [at(0, y), at(xs[xs.length - 1]!, y)];
          g.moveTo(a[0], a[1]);
          g.lineTo(b[0], b[1]);
        }
        g.stroke();
      };
      if (p.glow > 0) stroke(0.18 * p.glow * (0.6 + 0.4 * breath), width * 5, 24 * p.glow);
      stroke(0.55 + 0.45 * breath, width, 8 * p.glow);
      g.shadowBlur = 0;

      if (p.nodes) {
        // Ripples run out from the centre crossing by crossing, so every node is seen to light in turn.
        const [cx, cy] = [xs[xs.length - 1]! / 2, ys[ys.length - 1]! / 2];
        const far = Math.hypot(cx, cy) || 1;
        const front = (clock % RIPPLE_S) / RIPPLE_S;
        const radius = Math.max(3, width * 2.2);
        for (const x of xs) {
          for (const y of ys) {
            const [px, py] = at(x, y);
            const reach = Math.hypot(x - cx, y - cy) / far;
            const near = Math.max(0, 1 - Math.abs(front - reach) * 6);
            g.beginPath();
            g.arc(px, py, radius * (1 + near * 0.8), 0, Math.PI * 2);
            g.fillStyle = withAlpha('#ffffff', 0.55 + 0.45 * near);
            g.shadowColor = p.color;
            g.shadowBlur = 12 * p.glow + 18 * near;
            g.fill();
            if (near > 0.05) {
              g.beginPath();
              g.arc(px, py, radius * (2 + near * 3), 0, Math.PI * 2);
              g.strokeStyle = withAlpha(p.color, near * 0.8);
              g.lineWidth = Math.max(1, width * 0.6);
              g.stroke();
            }
          }
        }
        g.shadowBlur = 0;
      }
      g.restore();
    }

    ctx.onFrame((dt) => {
      clock += dt;
      draw();
    });
    draw();
    return {};
  },
});
