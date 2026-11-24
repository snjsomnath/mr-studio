// The Reveal line's hero on the controller: the table's shape with its buildings, the line on it
// and the side that shows the layers inside tinted. Dragging anywhere moves the line.
import { tablePad } from '@mrstudio/sdk';
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import type { Params } from './index.ts';

export function swipeHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  let local: number | null = null;
  const vertical = () => ctx.params.axis !== 'horizontal';
  const pad = tablePad(ctx, el, {
    label: ctx.say('Move the line'),
    caption: ctx.say('Drag to move the line'),
    draw(g, box) {
      const at = (local ?? ctx.params.at) / 100;
      const colour = ctx.params.colour || '#9ad7ff';
      g.save();
      g.fillStyle = colour;
      g.globalAlpha = 0.14;
      const before = ctx.params.side !== 'after';
      if (vertical()) {
        const x = box.x + at * box.width;
        if (before) g.fillRect(box.x, box.y, x - box.x, box.height);
        else g.fillRect(x, box.y, box.x + box.width - x, box.height);
        g.globalAlpha = 1;
        g.fillRect(x - 1.5, box.y - 6, 3, box.height + 12);
        g.beginPath();
        g.arc(x, box.y + box.height / 2, 11, 0, Math.PI * 2);
        g.fill();
      } else {
        const y = box.y + at * box.height;
        if (before) g.fillRect(box.x, box.y, box.width, y - box.y);
        else g.fillRect(box.x, y, box.width, box.y + box.height - y);
        g.globalAlpha = 1;
        g.fillRect(box.x - 6, y - 1.5, box.width + 12, 3);
        g.beginPath();
        g.arc(box.x + box.width / 2, y, 11, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    },
    onDrag([fx, fy], phase) {
      const percent = Math.round((vertical() ? fx : fy) * 1000) / 10;
      local = phase === 'up' ? null : percent;
      ctx.setParams({ at: percent });
      pad.redraw();
    },
  });
  return { update: () => pad.redraw() };
}
