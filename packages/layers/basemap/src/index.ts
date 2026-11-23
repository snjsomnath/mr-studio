import { defineLayer, geojsonLines, geojsonPolygons, readSiteData, STRAY_REACH, tableReach, tableSpace, traceLine, tracePolygon, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { TILE_STYLES, tilesFor } from './tiles.ts';
import type { Style } from './tiles.ts';

interface Params {
  style: Style;
  ground: string;
  streets: boolean;
  streetColor: string;
  buildingColor: string;
  outlines: boolean;
  opacity: number;
}

/** Street width in metres when the data does not give one. */
const STREET_WIDTH_M = 10;

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('base', { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);
    let asked = 0;

    /** Your own streets and buildings, drawn dark; or plain ground under them. */
    function drawOwn(buildings: ReturnType<typeof geojsonPolygons>, roads: ReturnType<typeof geojsonLines>, ground = true) {
      const g = canvas.ctx;
      const p = ctx.params;
      if (ground) {
        canvas.clear();
        g.fillStyle = p.ground;
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      if ((p.style ?? 'dark') !== 'dark') return;
      if (p.streets) {
        g.strokeStyle = p.streetColor;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        for (const road of roads) {
          g.lineWidth = Number(road.properties.width) || STREET_WIDTH_M;
          g.beginPath();
          traceLine(g, road.geometry);
          g.stroke();
        }
      }
      g.fillStyle = p.buildingColor;
      g.strokeStyle = withAlpha('#ffffff', 0.28);
      g.lineWidth = 1.5 / canvas.scale;
      for (const building of buildings) {
        g.beginPath();
        tracePolygon(g, building.geometry);
        g.fill('evenodd');
        if (p.outlines) g.stroke();
      }
    }

    /** A map from a key-free tile service, laid on the table tile by tile. */
    /** `over` draws on top once the tiles are in, such as the table's own buildings. */
    async function drawTiles(style: keyof typeof TILE_STYLES, why = '', over?: () => void) {
      const mine = ++asked;
      const service = TILE_STYLES[style];
      ctx.publish({ source: service.credit, note: 'Loading the map…' });
      const tiles = tilesFor(ctx.site, canvas.scale, service);
      const g = canvas.ctx;
      let failed = 0;
      await Promise.all(
        tiles.map(async (tile) => {
          try {
            const response = await fetch(tile.url);
            if (!response.ok) throw new Error(String(response.status));
            const image = await createImageBitmap(await response.blob());
            if (mine !== asked) return;
            // Tile pixels are (near enough) linear in lon/lat over a table, and so are table metres.
            const [ox, oy] = space.toTable(tile.west, tile.north);
            const [rx, ry] = space.toTable(tile.east, tile.north);
            const [dx, dy] = space.toTable(tile.west, tile.south);
            g.save();
            g.transform((rx - ox) / image.width, (ry - oy) / image.width, (dx - ox) / image.height, (dy - oy) / image.height, ox, oy);
            g.drawImage(image, 0, 0);
            g.restore();
          } catch {
            failed++;
          }
        }),
      );
      if (mine !== asked) return;
      if (service.tone) {
        // Tiles are fetched with CORS, so the drawing can be read back and recoloured.
        const element = g.canvas;
        const pixels = g.getImageData(0, 0, element.width, element.height);
        const d = pixels.data;
        for (let i = 0; i < d.length; i += 4) [d[i], d[i + 1], d[i + 2]] = service.tone(d[i]!, d[i + 1]!, d[i + 2]!);
        g.putImageData(pixels, 0, 0);
      }
      over?.();
      canvas.commit();
      ctx.publish({ source: service.credit, note: failed === tiles.length && tiles.length ? 'The map could not be loaded: no connection to the tile service.' : why });
    }

    let shapes: [ReturnType<typeof geojsonPolygons>, ReturnType<typeof geojsonLines>] = [[], []];
    let loaded = false;
    function draw() {
      const style = ctx.params.style ?? 'dark';
      drawOwn(...shapes);
      // Without streets of its own, the table would show buildings floating on bare ground: a dark map from
      // OpenStreetMap goes under them (#146), and the table's own buildings are drawn on top.
      // Streets that lie mostly beside the table, such as ones left from another place, count as none (#180).
      const stray = shapes[1].length > 0 && tableReach(shapes[1].map((l) => l.geometry), space) < STRAY_REACH;
      if (style === 'dark' && loaded && (shapes[1].length === 0 || stray)) {
        canvas.commit();
        const why = stray
          ? "This table's streets reach only a corner of it, so a dark map from OpenStreetMap shows the streets here. Bring in streets for this place in Your place."
          : shapes[0].length
            ? 'This table has no streets of its own yet, so a dark map from OpenStreetMap shows them under your buildings.'
            : 'This table has no streets or buildings of its own yet, so a dark map from OpenStreetMap stands in for them.';
        void drawTiles('darkmap', why, () => drawOwn(shapes[0], [], false));
        return;
      }
      if (style === 'dark' || style === 'plain') {
        asked++;
        canvas.commit();
        ctx.publish({ source: '', note: '' });
        return;
      }
      canvas.commit();
      void drawTiles(style);
    }

    ctx.onCleanup(() => void asked++);
    draw();
    const [buildings, roads] = await Promise.all([readSiteData(ctx.site, 'buildings'), readSiteData(ctx.site, 'roads')]);
    shapes = [geojsonPolygons(buildings, space), geojsonLines(roads, space)];
    loaded = true;
    // The base map is static: it is drawn once, and again only when a setting changes.
    if ((ctx.params.style ?? 'dark') === 'dark') draw();

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.some((key) => key !== 'opacity')) draw();
      },
    };
  },
});
