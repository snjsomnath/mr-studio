// The Magnifier's hero on the controller: the table's shape with its buildings, and the glass on
// it. Dragging moves the glass on the table; it stays where it is let go.
import { tablePad } from '@mrstudio/sdk';
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import type { Params } from './index.ts';
import { radiusOf } from './index.ts';

export function lensHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  const { width_m, height_m } = ctx.site.extent;
  let local: [number, number] | null = null;
  const pad = tablePad(ctx, el, {
    label: ctx.say('Move the glass'),
    caption: ctx.say('Drag to move the glass'),
    draw(g, box) {
      const [fx, fy] = local ?? [ctx.params.x, ctx.params.y];
      const x = box.x + fx * box.width;
      const y = box.y + fy * box.height;
      const r = (radiusOf(ctx.params.size, width_m, height_m) / width_m) * box.width;
      g.fillStyle = 'rgb(255 222 166 / 0.16)';
      g.strokeStyle = ctx.params.pinned ? 'rgb(255 223 167 / 0.95)' : 'rgb(255 241 210 / 0.85)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, Math.max(6, r), 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(x + Math.max(6, r) * 0.71, y + Math.max(6, r) * 0.71);
      g.lineTo(x + Math.max(6, r) * 1.15, y + Math.max(6, r) * 1.15);
      g.lineWidth = 5;
      g.lineCap = 'round';
      g.stroke();
    },
    onDrag(at, phase) {
      local = phase === 'up' ? null : at;
      ctx.setParams({ x: Number(at[0].toFixed(4)), y: Number(at[1].toFixed(4)), pinned: true });
      pad.redraw();
    },
  });
  return { update: () => pad.redraw() };
}
