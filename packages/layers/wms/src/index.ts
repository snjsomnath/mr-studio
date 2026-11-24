import { defineLayer, tableSpace } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { resolve } from './presets.ts';
import { request } from './request.ts';

interface Params {
  /** A map that comes with MR Studio (`presets.ts`), or `custom` for the address and layers below. */
  map: string;
  /** `wms`, or `arcgis` for an ArcGIS MapServer or ImageServer address (#42). */
  service: string;
  url: string;
  layers: string;
  styles: string;
  source: string;
  /** A source from the Sources manager whose key or login signs the request (#42). */
  signin: string;
  opacity: number;
}

/** What to ask the host for, or nothing while the map is not set up yet. */
function wanted(params: Params) {
  const wanted = resolve(params);
  // An ArcGIS service shows all its layers when none are named; a WMS needs at least one.
  const needsLayers = wanted.service !== 'arcgis';
  if ((!wanted.url.trim() && !wanted.signin?.trim()) || (needsLayers && !wanted.layers.trim())) return null;
  return wanted;
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  // A slideshow fetches its maps when it opens; the host keeps them for a venue without a connection.
  async prefetch(site, params) {
    const map = wanted(params);
    if (map) await fetch(request(site, map).href).then((response) => response.arrayBuffer());
  },

  async table(ctx) {
    const canvas = ctx.map.addDrawing('wms', { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);
    let asked = 0;

    async function load() {
      const mine = ++asked;
      canvas.clear();
      canvas.commit();
      const map = wanted(ctx.params);
      if (!map) {
        ctx.publish({ note: 'Choose a map, or give the service address (or a sign-in from Sources) and its layers' });
        return;
      }
      const { href, bbox, width, height } = request(ctx.site, map);
      ctx.publish({ note: 'Loading the map…', source: map.source });
      try {
        const response = await fetch(href);
        if (!response.ok) throw new Error(await response.text());
        const image = await createImageBitmap(await response.blob());
        if (mine !== asked) return;
        // Image pixels are linear in lon/lat, and so are table metres: three corners fix the mapping.
        const at = (px: number, py: number) => space.toTable(bbox[0] + (px / width) * (bbox[2] - bbox[0]), bbox[3] - (py / height) * (bbox[3] - bbox[1]));
        const [ox, oy] = at(0, 0);
        const [rx, ry] = at(image.width, 0);
        const [dx, dy] = at(0, image.height);
        const g = canvas.ctx;
        canvas.clear();
        g.save();
        g.transform((rx - ox) / image.width, (ry - oy) / image.width, (dx - ox) / image.height, (dy - oy) / image.height, ox, oy);
        g.drawImage(image, 0, 0);
        g.restore();
        canvas.commit();
        ctx.publish({ note: '', source: map.source });
      } catch (error) {
        if (mine === asked) ctx.publish({ note: `The map could not be loaded: ${(error as Error).message.slice(0, 200)}` });
      }
    }

    ctx.onCleanup(() => void asked++);
    await load();

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.some((key) => key === 'map' || key === 'service' || key === 'url' || key === 'layers' || key === 'styles' || key === 'signin')) void load();
      },
    };
  },
});
