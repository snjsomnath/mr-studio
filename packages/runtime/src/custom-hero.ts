// A custom layer's hero on the controller (#342). A custom layer has no code of its own, so
// without this the centre of the controller stayed empty while it was open. It shows a small
// map of the layer's data in the table's look (its colours, over the table's buildings), and
// for a layer of named points, such as places for the place motions, the places by name, the
// one the table is showing now marked.

import { css, paintScale, readShapes, siteDataUrl, tableFrame, tablePalette } from '@mrstudio/sdk';
import type { CustomLayer, GeoJsonCollection, PanelContext, PanelHandlers, Shapes } from '@mrstudio/sdk';

import { dataUrl, loadData } from './recipe-player.ts';

/** The property that names a point, in the words files use. */
const NAME_KEYS = ['name', 'namn', 'title', 'titel', 'label'];
const MOST_NAMES = 24;

type Props = Record<string, unknown>;
type Drawn = { shapes: Shapes; colour: (p: Props) => string; kind: string };

function nameOf(properties: Props): string | undefined {
  for (const key of NAME_KEYS) {
    const value = properties?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** True when a custom layer can have this hero: it has data of its own to show. */
export function hasCustomHero(recipe: CustomLayer | undefined): boolean {
  return Boolean(recipe?.data?.some((d) => d.dataset || d.path));
}

export function customHero(ctx: PanelContext, el: HTMLElement, recipe: () => CustomLayer | undefined): PanelHandlers {
  el.classList.add('custom-hero');
  const canvas = document.createElement('canvas');
  canvas.className = 'custom-hero-map';
  canvas.setAttribute('aria-hidden', 'true');
  const list = document.createElement('ul');
  list.className = 'custom-hero-places';
  list.setAttribute('aria-label', ctx.say('Places'));
  list.hidden = true;
  const cell = document.createElement('div');
  cell.className = 'custom-hero-cell';
  cell.append(canvas);
  el.append(cell, list);

  const frame = tableFrame(ctx.site);
  let buildings: Shapes | null = null;
  let drawn: Drawn[] = [];
  let names: { name: string; colour: string; kind?: string }[] = [];
  let key = '';

  const load = async () => {
    const r = recipe();
    if (!r) return;
    const palette = tablePalette(ctx.site);
    const next: Drawn[] = [];
    const found: { name: string; colour: string; kind?: string }[] = [];
    for (const data of r.data ?? []) {
      const url = dataUrl(data, ctx.site);
      if (!url) continue;
      let collection: GeoJsonCollection;
      try {
        collection = await loadData(url);
      } catch {
        continue;
      }
      const shapes = readShapes(collection, frame);
      const block = (r.look ?? []).find((b) => b.data === data.id);
      const rows = collection.features.map((f) => (f.properties ?? {}) as Props);
      const scale = paintScale((block?.props as { color?: never } | undefined)?.color, rows, palette);
      const colour = (p: Props) => css(scale.colour(p));
      next.push({ shapes, colour, kind: block?.block ?? 'points' });
      for (const spot of shapes.spots) {
        const name = nameOf(spot.properties as Props);
        const props = spot.properties as Props;
        const kind = [props?.category, props?.kategori, props?.type].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
        if (name && !found.some((f) => f.name === name)) found.push({ name, colour: colour(props), kind });
      }
    }
    drawn = next;
    names = found.slice(0, MOST_NAMES);
    if (!buildings) {
      const url = siteDataUrl(ctx.site, 'buildings');
      if (url) buildings = await loadData(url).then((c) => readShapes(c, frame)).catch(() => null);
    }
    draw();
    fill();
  };

  const draw = () => {
    // As wide as its column, but no taller than a third of the screen, so the layer's
    // choices stay in view under it.
    let width = Math.max(1, (el.clientWidth || 960) * 0.6);
    let height = Math.round((width * frame.height) / frame.width);
    const most = Math.round(window.innerHeight * 0.36);
    if (height > most) {
      height = most;
      width = Math.round((height * frame.width) / frame.height);
    }
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const g = canvas.getContext('2d');
    if (!g) return;
    const s = (canvas.width / frame.width);
    g.setTransform(s, 0, 0, s, 0, 0);
    g.fillStyle = '#0b0f17';
    g.fillRect(0, 0, frame.width, frame.height);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const px = 1 / s;
    for (const area of buildings?.areas ?? []) {
      g.beginPath();
      for (const ring of area.polygons.flat()) ring.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.fillStyle = '#1c2433';
      g.fill('evenodd');
    }
    for (const { shapes, colour } of drawn) {
      for (const area of shapes.areas) {
        g.beginPath();
        for (const ring of area.polygons.flat()) ring.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.globalAlpha = 0.55;
        g.fillStyle = colour(area.properties as Props);
        g.fill('evenodd');
        g.globalAlpha = 1;
      }
      for (const path of shapes.paths) {
        g.beginPath();
        path.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.strokeStyle = colour(path.properties as Props);
        g.lineWidth = 2 * px;
        g.stroke();
      }
      const current = String((ctx.shared as { legend_highlight?: unknown }).legend_highlight ?? '');
      for (const spot of shapes.spots) {
        const [x, y] = spot.point;
        const lit = current !== '' && nameOf(spot.properties as Props) === current;
        g.beginPath();
        g.arc(x, y, (lit ? 9 : 6) * px, 0, Math.PI * 2);
        g.fillStyle = colour(spot.properties as Props);
        g.shadowColor = g.fillStyle;
        g.shadowBlur = (lit ? 14 : 6) * ratio;
        g.fill();
        g.shadowBlur = 0;
      }
    }
  };

  const fill = () => {
    list.hidden = names.length === 0;
    const current = String((ctx.shared as { legend_highlight?: unknown }).legend_highlight ?? '');
    list.replaceChildren(
      ...names.map(({ name, colour, kind }) => {
        const item = document.createElement('li');
        item.classList.toggle('is-current', name === current);
        const dot = document.createElement('i');
        dot.style.background = colour;
        const words = document.createElement('span');
        words.textContent = name;
        if (kind) {
          const small = document.createElement('small');
          small.textContent = ctx.say(kind);
          words.append(small);
        }
        item.append(dot, words);
        return item;
      }),
    );
  };

  const resize = new ResizeObserver(() => draw());
  resize.observe(el);
  ctx.onCleanup(() => resize.disconnect());
  void load();

  return {
    update() {
      // The recipe, the palette or what is highlighted changed.
      const next = JSON.stringify([recipe()?.data, recipe()?.look, ctx.site.palette]);
      if (next !== key) {
        key = next;
        void load();
        return;
      }
      draw();
      fill();
    },
  };
}
