// Magnifier (#287, #351): a glass people move over the table. By default it works as the
// Lindholmen artwork's magnifier did: the table shows the circle being looked at, with the rest
// darkened, and the controller shows that circle larger, through a glass. Set to "The layers
// inside it" it is an X-ray on the table: the layers placed inside it in the editor (its
// items) show only within the glass.
// The glass's place is host state (`x`, `y`, `pinned`), so the projector, the editor's live
// table, the controller's pad and the phones all agree on where it is.
import { defineLayer, revealPath, tableFrame } from '@mrstudio/sdk';
import type { LayerManifest, PanelContext, RevealShape } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { lensHero } from './hero.ts';
import { drawGlass } from './glass.ts';

export interface Params {
  show: 'zoom' | 'under';
  zoom: number;
  size: number;
  pinned: boolean;
  dim: number;
  cover: boolean;
  follow: boolean;
  /** Slow caustic light over the lines in the controller's glass (#415). */
  caustic: boolean;
  x: number;
  y: number;
}

/** The glass's radius in table metres: `size` is its width as a share of the table's shorter side. */
export function radiusOf(size: number, width: number, height: number): number {
  return ((size / 100) * Math.min(width, height)) / 2;
}

/**
 * The circle the table marks, in table metres: the X-ray's glass itself, or for the magnifier the
 * part of the table the controller shows `zoom` times larger.
 */
export function circleOf(params: Pick<Params, 'show' | 'size' | 'zoom'>, width: number, height: number): number {
  const r = radiusOf(params.size, width, height);
  return params.show === 'under' ? r : r / Math.max(1, params.zoom);
}

/** Device pixels across the picture the table sends for the controller's glass. */
const VIEW_PX = 1024;
/** Milliseconds a sharp picture is kept while the glass stands still, as layers under it may move. */
const DETAIL_MS = 400;

/** After the glass moved here, how long values coming back from the host are older than what is shown. */
const ECHO_MS = 500;

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  table(ctx) {
    const frame = tableFrame(ctx.site);
    const { width, height } = frame;
    // Under the items: the map hidden inside the glass, for an X-ray. Above everything: the glass itself.
    const cover = ctx.map.addDrawing('cover', { resolution: 1024 });
    const glass = ctx.map.addCanvas('glass');
    const picture = ctx.map.addPicture();
    let centre: [number, number] = [ctx.params.x * width, ctx.params.y * height];
    let pinned = ctx.params.pinned;
    let movedAt = -Infinity;
    let time = 0;
    let coverKey = '';
    let shownAt = performance.now();
    let sentRevision = -1;
    let detailKey = '';
    let detailAt = 0;
    const sample = document.createElement('canvas');
    sample.width = sample.height = VIEW_PX;
    const sampleCtx = sample.getContext('2d')!;

    const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
    function moveTo(point: [number, number]) {
      centre = [clamp(point[0], width), clamp(point[1], height)];
      movedAt = performance.now();
      ctx.setParams({ x: Number((centre[0] / width).toFixed(4)), y: Number((centre[1] / height).toFixed(4)) });
    }

    ctx.pointer.on((sample) => {
      if (sample.source === 'phone' || sample.source === 'script') return;
      if (sample.phase === 'down') {
        if (ctx.params.follow) {
          // A click pins the glass where it is, and another lets it follow again from where the mouse is.
          pinned = !pinned;
          ctx.setParams({ pinned });
          if (!pinned) moveTo(sample.point);
        } else moveTo(sample.point);
        return;
      }
      if (sample.phase !== 'move') return;
      if (ctx.params.follow ? !pinned : sample.pressed) moveTo(sample.point);
    });

    ctx.onFrame((dt) => {
      time += dt;
      const xray = ctx.params.show === 'under';
      const r = circleOf(ctx.params, width, height);
      const shape: RevealShape = { kind: 'circle', centre, radius_m: r };
      ctx.reveal.set(xray ? shape : { kind: 'none' });

      // The map hidden inside the glass, drawn only when it changed.
      const key = xray && ctx.params.cover ? `${centre[0].toFixed(2)},${centre[1].toFixed(2)},${r.toFixed(2)}` : '';
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

      const at = glass.project(frame.toLonLat(centre));
      const radius = r * glass.pixelsPerMetre;
      if (!xray) {
        // The circle as the table shows it, sent to the controller to be shown larger there.
        picture.want({ x: at[0] - radius, y: at[1] - radius, width: radius * 2, height: radius * 2 });
        const key = `${centre[0].toFixed(2)},${centre[1].toFixed(2)},${r.toFixed(2)}`;
        const now = performance.now();
        if (picture.taken && picture.revision !== sentRevision && (key !== detailKey || now - detailAt > DETAIL_MS)) {
          sentRevision = picture.revision;
          detailKey = key;
          detailAt = now;
          // What the screen shows there, then whatever layers draw again sharply at this size.
          sampleCtx.imageSmoothingQuality = 'high';
          sampleCtx.drawImage(picture.canvas, 0, 0, VIEW_PX, VIEW_PX);
          const sharp = ctx.map.detail(centre, r, VIEW_PX);
          if (sharp) sampleCtx.drawImage(sharp, 0, 0);
          ctx.view.send(sample);
        }
      }
      glass.clear();
      drawGlass(glass.context, {
        centre: at,
        radius,
        width: glass.width,
        height: glass.height,
        dim: ctx.params.dim,
        pinned,
        time,
        arrival: (performance.now() - shownAt) / 550,
        line: Math.max(1, Math.min(glass.width, glass.height) / 900),
        inside: null,
      });
    });

    return {
      update(changed) {
        if (changed.includes('pinned')) pinned = ctx.params.pinned;
        if (changed.includes('show')) shownAt = performance.now();
        // Values coming back from the host for a move made here are older than what is shown.
        if ((changed.includes('x') || changed.includes('y')) && performance.now() - movedAt > ECHO_MS) {
          centre = [ctx.params.x * width, ctx.params.y * height];
        }
      },
      tool(input) {
        const geometry = input.geometry as { type?: string; coordinates?: [number, number] };
        if (input.tool !== 'move' || geometry.type !== 'Point' || !geometry.coordinates) return;
        moveTo(frame.toTable(geometry.coordinates));
      },
    };
  },

  hero(ctx: PanelContext<Params>, el: HTMLElement) {
    return lensHero(ctx, el);
  },
});
