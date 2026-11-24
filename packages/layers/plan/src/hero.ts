// The Masterplan's hero on the controller (#286): the drawing itself, as the table shows it. The
// phases the table shows are full, those still to come faint, the one pointed at on the table
// lit, and it turns from lines to colour when the table does. The artwork stays readable on the
// controller while the table is clean.
import { siteDataUrl } from '@mrstudio/sdk';
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import { datasetOf, loadImage, picture } from './drawing.ts';
import type { Params } from './drawing.ts';

const STYLE = `
.mrs-plan { position: relative; border-radius: 1.125rem; overflow: hidden; user-select: none;
  background: radial-gradient(120% 100% at 50% 0%, #1d2233 0%, #10131d 60%, #0a0c14 100%);
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); }
.mrs-plan canvas { display: block; width: 100%; height: clamp(16rem, 52vh, 40rem); }
`;

/** Seconds a phase or the colour takes to change on the controller. */
const EASE_S = 0.8;

export function planHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  el.innerHTML = `<style>${STYLE}</style>`;
  const root = document.createElement('div');
  root.className = 'mrs-plan';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', ctx.say('The drawing'));
  root.append(canvas);
  el.append(root);
  const g = canvas.getContext('2d')!;

  let base: HTMLImageElement | null = null;
  let colourImage: HTMLImageElement | null = null;
  let phases: { name: string; image: HTMLImageElement; shown: number }[] = [];
  let aspect = ctx.site.extent.width_m / Math.max(1e-6, ctx.site.extent.height_m);
  let colour = 0;
  const lit = new Map<string, number>();
  let frame = 0;
  let last = 0;
  let loading = 0;
  let loadedKey = '';

  const target = () => ({
    colour: colourImage && ctx.params.look === 'colour' && ctx.shared.turned !== false ? 1 : 0,
    shown: (k: number) => {
      const list = ctx.shared.shown as number[] | undefined;
      return Array.isArray(list) ? (list[k] ?? 0) : 1;
    },
  });

  async function load() {
    const mine = ++loading;
    const name = datasetOf(ctx.site, ctx.params.dataset);
    let svg: Document | null = null;
    const url = name ? siteDataUrl(ctx.site, name) : null;
    if (url) {
      try {
        const response = await fetch(url);
        if (response.ok) svg = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
      } catch {
        svg = null;
      }
    }
    if (svg?.querySelector('parsererror') || svg?.documentElement.localName !== 'svg') svg = null;
    const box = (svg?.documentElement.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    const nextAspect = box.length === 4 && box.every(Number.isFinite) && box[3]! > 0 ? box[2]! / box[3]! : aspect;
    // Pictured at about the size it is shown at, on a sharp screen.
    const width = Math.round(Math.min(2400, Math.max(800, canvas.clientWidth * 2)));
    const height = Math.max(1, Math.round(width / nextAspect));
    const groups = svg ? [...svg.querySelectorAll('[data-mrs-phase]')] : [];
    const [nextBase, ...images] = svg ? await Promise.all([picture(svg, null, width, height), ...groups.map((group) => picture(svg!, group.getAttribute('data-mrs-phase'), width, height))]) : [null];
    const nextColour = await loadImage(ctx.params.colour ? siteDataUrl(ctx.site, ctx.params.colour) : null);
    if (mine !== loading) return;
    aspect = nextAspect;
    base = nextBase ?? null;
    colourImage = nextColour;
    phases = groups.map((group, k) => ({ name: group.getAttribute('data-mrs-name') ?? `Part ${k + 1}`, image: images[k]!, shown: target().shown(k) }));
    colour = target().colour;
    request();
  }

  function request() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function draw(now: number) {
    frame = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    const step = dt / EASE_S;
    const toward = (from: number, to: number) => (Math.abs(to - from) <= step ? to : from + Math.sign(to - from) * step);
    const aim = target();
    let moving = false;
    colour = toward(colour, aim.colour);
    if (colour !== aim.colour) moving = true;
    const pointing = String(ctx.shared.pointing ?? '');
    phases.forEach((p, k) => {
      p.shown = toward(p.shown, aim.shown(k));
      const l = toward(lit.get(p.name) ?? 0, p.name === pointing ? 1 : 0);
      lit.set(p.name, l);
      if (p.shown !== aim.shown(k) || (l > 0 && l < 1)) moving = true;
    });

    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    const scale = Math.min((w - 32) / aspect, h - 32);
    const bw = aspect * scale;
    const bh = scale;
    const x = (w - bw) / 2;
    const y = (h - bh) / 2;
    if (base) {
      g.globalAlpha = 1 - colour;
      g.drawImage(base, x, y, bw, bh);
    }
    if (colourImage && colour > 0) {
      g.globalAlpha = colour;
      g.drawImage(colourImage, x, y, bw, bh);
    }
    for (const p of phases) {
      const l = lit.get(p.name) ?? 0;
      const alpha = Math.min(1, p.shown + (1 - p.shown) * l);
      if (alpha <= 0) continue;
      g.globalAlpha = alpha;
      g.drawImage(p.image, x, y, bw, bh);
      if (l > 0) {
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = 0.3 * l;
        g.drawImage(p.image, x, y, bw, bh);
        g.restore();
      }
    }
    g.globalAlpha = 1;
    if (moving) request();
    else last = 0;
  }

  const observer = new ResizeObserver(request);
  observer.observe(canvas);
  ctx.onCleanup(() => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    loading++;
  });
  loadedKey = `${ctx.params.dataset}|${ctx.params.colour}`;
  void load();

  return {
    update() {
      const key = `${ctx.params.dataset}|${ctx.params.colour}`;
      if (key !== loadedKey) {
        loadedKey = key;
        void load();
      }
      request();
    },
  };
}
