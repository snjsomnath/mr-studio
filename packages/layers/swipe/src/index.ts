// Reveal line (#288): a line across the table that people move. On one side of it the layers
// placed inside it in the editor (its items) show, such as pipes and tunnels under the ground;
// on the other the table stays as it is. Same reveal core as the Magnifier (#287): the runtime
// clips the items to the side this layer sets. Where the line is lives in the host (`at`), so
// every view, the controller's pad and the phones agree.
import { defineLayer, revealPath, tableFrame } from '@mrstudio/sdk';
import type { LayerManifest, PanelContext, RevealShape } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { swipeHero } from './hero.ts';

export interface Params {
  at: number;
  axis: 'vertical' | 'horizontal';
  side: 'before' | 'after';
  cover: boolean;
  sweep: boolean;
  colour: string;
}

/** The shape the items show through, for a line at `at` percent across a table of `width` by `height` metres. */
export function sideOf(params: Pick<Params, 'at' | 'axis' | 'side'>, width: number, height: number): RevealShape {
  const vertical = params.axis !== 'horizontal';
  return { kind: 'side', axis: vertical ? 'x' : 'y', at_m: (params.at / 100) * (vertical ? width : height), keep: params.side === 'after' ? 'after' : 'before' };
}

/** Seconds without a move before the line starts to sweep, and how long one sweep takes. */
const IDLE_S = 8;
const SWEEP_S = 24;
const ECHO_MS = 500;

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  table(ctx) {
    const frame = tableFrame(ctx.site);
    const { width, height } = frame;
    const cover = ctx.map.addDrawing('cover', { resolution: 1024 });
    const top = ctx.map.addCanvas('line');
    let at = ctx.params.at;
    let movedAt = -Infinity;
    let idle = 0;
    let sweepPhase = 0;
    let time = 0;
    let dragging: string | null = null;
    let near = false;
    let coverKey = '';

    const vertical = () => ctx.params.axis !== 'horizontal';
    const span = () => (vertical() ? width : height);
    const percentAt = (point: [number, number]) => Math.min(100, Math.max(0, ((vertical() ? point[0] : point[1]) / span()) * 100));
    function moveTo(percent: number) {
      at = percent;
      idle = 0;
      movedAt = performance.now();
      ctx.setParams({ at: Number(percent.toFixed(1)) });
    }

    ctx.pointer.on((sample) => {
      if (sample.source === 'phone' || sample.source === 'script') return;
      const distance = Math.abs(percentAt(sample.point) - at) / 100 * span();
      near = distance < span() * 0.04;
      if (sample.phase === 'down') {
        dragging = sample.id;
        moveTo(percentAt(sample.point));
      } else if (sample.phase === 'move' && dragging === sample.id && sample.pressed) moveTo(percentAt(sample.point));
      else if (sample.phase === 'up' || sample.phase === 'leave') {
        if (dragging === sample.id) dragging = null;
        if (sample.phase === 'leave') near = false;
      }
    });

    ctx.onFrame((dt) => {
      time += dt;
      idle += dt;
      // Nobody moving it: the line sweeps slowly from where it is, to invite people in.
      let shown = at;
      if (ctx.params.sweep && idle > IDLE_S && !dragging) {
        sweepPhase += dt / SWEEP_S;
        shown = 50 + 42 * Math.sin(sweepPhase * Math.PI * 2 + Math.asin(Math.max(-1, Math.min(1, (at - 50) / 42))));
      } else sweepPhase = 0;
      const shape = sideOf({ ...ctx.params, at: shown }, width, height);
      ctx.reveal.set(shape);

      const key = ctx.params.cover ? JSON.stringify(shape) : '';
      if (key !== coverKey) {
        coverKey = key;
        cover.clear();
        if (key) {
          cover.ctx.fillStyle = 'rgb(4 6 10)';
          revealPath(cover.ctx, shape, width, height);
          cover.ctx.fill();
        }
        cover.commit();
      }

      // The line, end to end across the table, with a handle in the middle.
      const m = (shown / 100) * span();
      const a = top.project(frame.toLonLat(vertical() ? [m, 0] : [0, m]));
      const b = top.project(frame.toLonLat(vertical() ? [m, height] : [width, m]));
      const g = top.context;
      top.clear();
      const colour = ctx.params.colour || '#9ad7ff';
      const lift = dragging || near ? 1 : 0.75 + 0.25 * Math.sin(time * 1.6);
      g.save();
      g.lineCap = 'round';
      g.strokeStyle = colour;
      g.shadowColor = colour;
      g.shadowBlur = 18;
      g.globalAlpha = 0.35 * lift;
      g.lineWidth = 10;
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
      g.shadowBlur = 0;
      g.globalAlpha = 0.95;
      g.lineWidth = 2.5;
      g.stroke();
      const cx = (a[0] + b[0]) / 2;
      const cy = (a[1] + b[1]) / 2;
      const r = Math.max(14, Math.min(top.width, top.height) * 0.028) * (dragging ? 1.15 : 1);
      g.fillStyle = 'rgb(8 12 20 / 0.85)';
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // Two arrows along the way the line moves.
      const [dx, dy] = (() => {
        const lx = b[0] - a[0];
        const ly = b[1] - a[1];
        const l = Math.hypot(lx, ly) || 1;
        return [-ly / l, lx / l];
      })();
      g.fillStyle = colour;
      for (const s of [-1, 1]) {
        const tipX = cx + dx * r * 0.62 * s;
        const tipY = cy + dy * r * 0.62 * s;
        const baseX = cx + dx * r * 0.18 * s;
        const baseY = cy + dy * r * 0.18 * s;
        g.beginPath();
        g.moveTo(tipX, tipY);
        g.lineTo(baseX - dy * r * 0.32, baseY + dx * r * 0.32);
        g.lineTo(baseX + dy * r * 0.32, baseY - dx * r * 0.32);
        g.closePath();
        g.fill();
      }
      g.restore();
    });

    return {
      update(changed) {
        if (changed.includes('at') && performance.now() - movedAt > ECHO_MS) {
          at = ctx.params.at;
          idle = 0;
        }
        if (changed.includes('axis')) idle = 0;
      },
      tool(input) {
        const geometry = input.geometry as { type?: string; coordinates?: [number, number] };
        if (input.tool !== 'move' || geometry.type !== 'Point' || !geometry.coordinates) return;
        moveTo(percentAt(frame.toTable(geometry.coordinates)));
      },
    };
  },

  hero(ctx: PanelContext<Params>, el: HTMLElement) {
    return swipeHero(ctx, el);
  },
});
