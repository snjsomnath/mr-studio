// Magnifier (#287): a glass people move over the table. By default it shows what is under it
// larger, as the Lindholmen artwork's magnifier did; set to "The layers inside it" it is an
// X-ray: the layers placed inside it in the editor (its items) show only within the glass.
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
  x: number;
  y: number;
}

/** The glass's radius in table metres: `size` is its width as a share of the table's shorter side. */
export function radiusOf(size: number, width: number, height: number): number {
  return ((size / 100) * Math.min(width, height)) / 2;
}

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
      const r = radiusOf(ctx.params.size, width, height);
      const shape: RevealShape = { kind: 'circle', centre, radius_m: r };
      const xray = ctx.params.show === 'under';
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
      const zoom = Math.max(1, ctx.params.zoom);
      if (!xray) {
        const half = radius / zoom;
        picture.want({ x: at[0] - half, y: at[1] - half, width: half * 2, height: half * 2 });
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
        inside: !xray && picture.taken ? (g) => {
          // What was under the glass, larger: the copy covers the glass from edge to edge.
          g.imageSmoothingQuality = 'high';
          g.drawImage(picture.canvas, at[0] - radius, at[1] - radius, radius * 2, radius * 2);
        } : null,
      });
    });

    return {
      update(changed) {
        if (changed.includes('pinned')) pinned = ctx.params.pinned;
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
