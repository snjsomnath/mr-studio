// The Magnifier's hero on the controller (#287, #351). As the Lindholmen artwork's magnifier:
// the part of the table under the circle, larger, through a glass, beside a small navigator of
// the whole table to move the circle. For an X-ray it is the navigator alone, larger.
import { tablePad } from '@mrstudio/sdk';
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import type { Params } from './index.ts';
import { circleOf } from './index.ts';
import { GlassView } from './view.ts';

const STYLE = `
.mrs-lens { display: flex; gap: 1.5rem; align-items: center; justify-content: center; }
.mrs-lens-glass { position: relative; flex: 0 0 auto; width: clamp(16rem, 52vh, 40rem); aspect-ratio: 1; border-radius: 50%;
  background: radial-gradient(circle at 50% 45%, #141824 0%, #07090f 70%);
  box-shadow: 0 0 0 1px rgb(255 226 170 / 0.18), 0 0 4rem rgb(255 213 143 / 0.16), 0 1.5rem 4rem rgb(0 0 0 / 0.45); }
.mrs-lens-glass canvas { display: block; width: 100%; height: 100%; border-radius: 50%; }
.mrs-lens-glass p { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; text-align: center; padding: 3rem;
  color: rgb(255 241 210 / 0.6); font-size: 1rem; }
.mrs-lens-nav { flex: 1 1 18rem; max-width: 28rem; }
.mrs-lens-nav .mrs-pad canvas { height: clamp(10rem, 26vh, 18rem); }
`;

export function lensHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  const { width_m, height_m } = ctx.site.extent;
  let local: [number, number] | null = null;
  let stopWatching: (() => void) | null = null;
  let latest: ImageBitmap | null = null;
  let view: GlassView | null = null;
  let glassBox: HTMLElement | null = null;
  let waiting: HTMLElement | null = null;
  let pad: { redraw(): void } | null = null;
  let mode = '';

  // The caustic light (#415): on unless the layer turns it off or the viewer asks for less motion.
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const lit = () => ctx.params.caustic !== false && !still?.matches && !!view?.animates;
  let frame = 0;
  const started = performance.now();

  const drawGlass = () => {
    if (!view || !glassBox || !latest) return;
    const size = Math.round(glassBox.clientWidth * Math.min(2, globalThis.devicePixelRatio || 1));
    if (size < 2) return;
    view.draw(latest, size, !!ctx.params.pinned, lit() ? 1 : 0, (performance.now() - started) / 1000);
    if (waiting) waiting.style.display = 'none';
    // The light keeps moving between the table's pictures.
    if (lit() && !frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        drawGlass();
      });
    }
  };

  const build = () => {
    mode = ctx.params.show === 'under' ? 'under' : 'zoom';
    stopWatching?.();
    stopWatching = null;
    el.innerHTML = `<style>${STYLE}</style>`;
    const root = document.createElement('div');
    root.className = 'mrs-lens';
    const nav = document.createElement('div');
    nav.className = 'mrs-lens-nav';
    if (mode === 'zoom') {
      glassBox = document.createElement('div');
      glassBox.className = 'mrs-lens-glass';
      view = new GlassView();
      view.canvas.setAttribute('role', 'img');
      view.canvas.setAttribute('aria-label', ctx.say('The table under the glass, larger'));
      waiting = document.createElement('p');
      waiting.textContent = ctx.say('Waiting for the table');
      glassBox.append(view.canvas, waiting);
      root.append(glassBox, nav);
      stopWatching = ctx.view.watch((picture) => {
        latest?.close();
        latest = picture;
        drawGlass();
      });
    } else {
      glassBox = view = waiting = null;
      nav.style.maxWidth = 'none';
      root.append(nav);
    }
    el.append(root);
    pad = tablePad(ctx, nav, {
      label: ctx.say('Move the glass'),
      caption: ctx.say('Drag to move the glass'),
      draw(g, box) {
        const [fx, fy] = local ?? [ctx.params.x, ctx.params.y];
        const x = box.x + fx * box.width;
        const y = box.y + fy * box.height;
        const r = Math.max(5, (circleOf(ctx.params, width_m, height_m) / width_m) * box.width);
        g.fillStyle = 'rgb(255 222 166 / 0.16)';
        g.strokeStyle = ctx.params.pinned ? 'rgb(255 223 167 / 0.95)' : 'rgb(255 241 210 / 0.85)';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      },
      onDrag(at, phase) {
        local = phase === 'up' ? null : at;
        ctx.setParams({ x: Number(at[0].toFixed(4)), y: Number(at[1].toFixed(4)), pinned: true });
        pad?.redraw();
      },
    });
  };

  build();
  const resize = new ResizeObserver(() => drawGlass());
  resize.observe(el);
  ctx.onCleanup(() => {
    resize.disconnect();
    cancelAnimationFrame(frame);
    frame = 0;
    view = null;
    stopWatching?.();
    latest?.close();
  });
  return {
    update: () => {
      if ((ctx.params.show === 'under' ? 'under' : 'zoom') !== mode) build();
      pad?.redraw();
      drawGlass();
    },
  };
}
