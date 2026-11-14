import { defineLayer, geojsonLines, geojsonPolygons, loadSiteData, tableSpace, traceLine, tracePolygon, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
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
    const canvas = ctx.map.addCanvas('base', { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);

    // The base map is static: it is drawn once, and again only when a setting changes.
    function draw(buildings: ReturnType<typeof geojsonPolygons>, roads: ReturnType<typeof geojsonLines>) {
      const g = canvas.ctx;
      const p = ctx.params;
      g.fillStyle = p.ground;
      g.fillRect(0, 0, canvas.width, canvas.height);
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
      canvas.commit();
    }

    draw([], []);
    const [buildings, roads] = await Promise.all([loadSiteData(ctx.site, 'buildings'), loadSiteData(ctx.site, 'roads')]);
    const shapes = [geojsonPolygons(buildings, space), geojsonLines(roads, space)] as const;
    draw(...shapes);

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.some((key) => key !== 'opacity')) draw(...shapes);
      },
    };
  },
});
