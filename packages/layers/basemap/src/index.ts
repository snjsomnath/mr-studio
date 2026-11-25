import { defineLayer, geojsonLines, hasSiteData, loadSiteField, sample, geojsonPolygons, readSiteData, STRAY_REACH, tableReach, tableSpace, traceLine, tracePolygon, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { TILE_STYLES, adjust, sourceTemplate, tileTemplate, tilesFor } from './tiles.ts';
import type { Style, TileStyle } from './tiles.ts';

interface Params {
  style: Style;
  /** The Sources connection a `source` map comes from. */
  source: string;
  grey: boolean;
  brightness: number;
  ground: string;
  streets: boolean;
  streetColor: string;
  buildingColor: string;
  waterColor: string;
  outlines: boolean;
  opacity: number;
}

/** Street width in metres when the data gives neither a width nor an OpenStreetMap class. */
const STREET_WIDTH_M = 10;

/**
 * Widths in metres by OpenStreetMap `highway` class, roughly as on the ground, so footways and
 * paths read as thin lines beside the roads rather than as broad bands (#215).
 */
const CLASS_WIDTH_M: Record<string, number> = {
  motorway: 22, trunk: 18, primary: 14, secondary: 12, tertiary: 10,
  motorway_link: 8, trunk_link: 8, primary_link: 8, secondary_link: 7, tertiary_link: 7,
  unclassified: 7, residential: 7, living_street: 6, service: 4.5, busway: 6,
  pedestrian: 5, track: 3, cycleway: 2.5, footway: 2, path: 1.8, steps: 2, bridleway: 2,
};

/** A street's drawn width: its own, else its class's, else the default. */
function streetWidth(properties: Record<string, unknown>): number {
  const own = Number(properties.width);
  if (own > 0) return own;
  const byClass = typeof properties.highway === 'string' ? CLASS_WIDTH_M[properties.highway] : undefined;
  return byClass ?? STREET_WIDTH_M;
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('base', { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);
    let asked = 0;

    /** Your own streets and buildings, drawn dark; or plain ground under them. */
    function drawOwn(buildings: ReturnType<typeof geojsonPolygons>, roads: ReturnType<typeof geojsonLines>, ground = true, g = canvas.ctx) {
      const p = ctx.params;
      if (ground) {
        if (g === canvas.ctx) canvas.clear();
        g.fillStyle = p.ground;
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      if ((p.style ?? 'dark') !== 'dark') return;
      // The scene's water (#343): polygons, or a mask on the site grid stretched over the table.
      if (water) {
        g.fillStyle = p.waterColor;
        for (const area of water.areas) {
          g.beginPath();
          tracePolygon(g, area.geometry);
          g.fill('evenodd');
        }
        if (water.mask) {
          g.imageSmoothingEnabled = true;
          g.drawImage(water.mask, 0, 0, ctx.site.extent.width_m, ctx.site.extent.height_m);
        }
      }
      if (p.streets) {
        g.strokeStyle = p.streetColor;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        // Narrowest first, so the main roads lie over the paths that meet them.
        for (const road of [...roads].sort((a, b) => streetWidth(a.properties) - streetWidth(b.properties))) {
          g.lineWidth = streetWidth(road.properties);
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

    /** What a tiled style draws from: a key-free service through the host's tile store, or a source. */
    async function serviceFor(style: TileStyle | 'source'): Promise<{ template: string; credit: string; maxzoom: number; tone?: (r: number, g: number, b: number) => [number, number, number] } | null> {
      if (style !== 'source') {
        const service = TILE_STYLES[style];
        return { template: tileTemplate(style), credit: service.credit, maxzoom: service.maxzoom, tone: service.tone };
      }
      const id = ctx.params.source;
      if (!id) return null;
      // The source's own name is its credit: "Mapbox", "CARTO", "Lantmäteriet", or what the author called it.
      const list = await fetch('/api/sources', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { sources: [] }))
        .catch(() => ({ sources: [] }));
      const found = ((list as { sources?: { id: string; name: string }[] }).sources ?? []).find((s) => s.id === id);
      return { template: sourceTemplate(id), credit: found?.name ?? id, maxzoom: 20 };
    }

    /** A tiled map laid on the table tile by tile. `over` draws on top once the tiles are in, such as the table's own buildings. */
    async function drawTiles(style: TileStyle | 'source', why = '', over?: () => void) {
      const mine = ++asked;
      const service = await serviceFor(style);
      if (mine !== asked) return;
      if (!service) {
        canvas.commit();
        ctx.publish({ source: '', note: ctx.say('Choose a map source, or set one up under Sources.') });
        return;
      }
      ctx.publish({ source: service.credit, note: ctx.say('Loading the map…') });
      const tiles = tilesFor(ctx.site, canvas.scale, service.template, service.maxzoom);
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
      // The night map's own tone, then black and white and brightness (#37). Only for the base map
      // the author chose: the stand-in under a table without streets keeps its night look.
      const own = over ? undefined : adjust(ctx.params.grey, ctx.params.brightness ?? 1);
      const tones = [service.tone, own].filter((t): t is NonNullable<typeof t> => Boolean(t));
      if (tones.length > 0) {
        // Tiles come from this computer's host, so the drawing can be read back and recoloured.
        const element = g.canvas;
        const pixels = g.getImageData(0, 0, element.width, element.height);
        const d = pixels.data;
        for (let i = 0; i < d.length; i += 4) {
          let rgb: [number, number, number] = [d[i]!, d[i + 1]!, d[i + 2]!];
          for (const tone of tones) rgb = tone(...rgb);
          [d[i], d[i + 1], d[i + 2]] = rgb;
        }
        g.putImageData(pixels, 0, 0);
      }
      over?.();
      canvas.commit();
      const lost = failed === tiles.length && tiles.length > 0;
      ctx.publish({ source: service.credit, note: lost ? (style === 'source' ? ctx.say('The map could not be loaded from this source. Check it under Sources.') : ctx.say('The map could not be loaded: no connection to the map service, and no copy kept from before.')) : why });
    }

    let shapes: [ReturnType<typeof geojsonPolygons>, ReturnType<typeof geojsonLines>] = [[], []];
    let loaded = false;
    let water: { areas: ReturnType<typeof geojsonPolygons>; mask: OffscreenCanvas | null } | null = null;
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

    /** The water, as polygons in table metres or as a picture of the mask in the water colour. */
    async function readWater(): Promise<typeof water> {
      if (!hasSiteData(ctx.site, 'water')) return null;
      if (!/\.tiff?$/i.test(String(ctx.site.data?.water))) return { areas: geojsonPolygons(await readSiteData(ctx.site, 'water'), space), mask: null };
      const field = await loadSiteField(ctx.site, 'water');
      if (!field || typeof OffscreenCanvas === 'undefined') return null;
      const mask = new OffscreenCanvas(field.width, field.height);
      const g = mask.getContext('2d')!;
      const image = g.createImageData(field.width, field.height);
      const [r, gr, b] = [1, 3, 5].map((i) => parseInt(ctx.params.waterColor.slice(i, i + 2), 16) || 0);
      for (let i = 0; i < field.width * field.height; i++) {
        if (!(sample(field, i % field.width, Math.floor(i / field.width)) > 0.5)) continue;
        image.data.set([r!, gr!, b!, 255], i * 4);
      }
      g.putImageData(image, 0, 0);
      return { areas: [], mask };
    }

    // A magnifier's sharp picture (#413): the table's own streets and buildings drawn again at its
    // size. Tiled styles stay the screen's copy, except for the buildings drawn over the stand-in map.
    ctx.map.addDetail((g) => {
      if (!loaded || (ctx.params.style ?? 'dark') !== 'dark') return;
      g.globalAlpha = ctx.params.opacity;
      const stray = shapes[1].length > 0 && tableReach(shapes[1].map((l) => l.geometry), space) < STRAY_REACH;
      if (shapes[1].length === 0 || stray) drawOwn(shapes[0], [], false, g);
      else drawOwn(shapes[0], shapes[1], true, g);
    });

    ctx.onCleanup(() => void asked++);
    draw();
    const [buildings, roads] = await Promise.all([readSiteData(ctx.site, 'buildings'), readSiteData(ctx.site, 'roads')]);
    shapes = [geojsonPolygons(buildings, space), geojsonLines(roads, space)];
    water = await readWater().catch((error) => {
      console.warn('[basemap] water not read', error);
      return null;
    });
    loaded = true;
    // The base map is static: it is drawn once, and again only when a setting changes.
    if ((ctx.params.style ?? 'dark') === 'dark') draw();

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('waterColor') && water?.mask) {
          void readWater().then((next) => {
            water = next;
            draw();
          });
        } else if (changed.some((key) => key !== 'opacity')) draw();
      },
    };
  },
});
