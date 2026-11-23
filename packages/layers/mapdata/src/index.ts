import { categorySlots, defineLayer, geojsonLines, geojsonPoints, geojsonPolygons, readSiteData, tablePalette, tableSpace, traceLine, tracePolygon, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest, Placed, XY } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { PALETTE, PULSE_S, categories, categoryColours, strength } from './categories.ts';

interface Params {
  dataset: string;
  colorBy: string;
  color: string;
  reveal: boolean;
  width: number;
  opacity: number;
}

type Shapes = { polygons: Placed<XY[][]>[]; lines: Placed<XY[]>[]; points: Placed<XY>[] };

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('mapdata', { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);
    let shapes: Shapes = { polygons: [], lines: [], points: [] };
    let names: string[] = [];
    let pulse = 0;
    let dirty = true;

    const category = (properties: Record<string, unknown>) => (names.length ? names.indexOf(String(properties?.[ctx.params.colorBy])) : -1);
    // Categories take the table palette's eight category colours first (#93), then the layer's own extras.
    const colour = (n: number) => (n >= 0 ? categoryColours(categorySlots(tablePalette(ctx.site)))[n % PALETTE.length]! : ctx.params.color);

    async function load() {
      const geojson = ctx.params.dataset ? await readSiteData(ctx.site, ctx.params.dataset) : null;
      shapes = geojson
        ? { polygons: geojsonPolygons(geojson, space), lines: geojsonLines(geojson, space), points: geojsonPoints(geojson, space) }
        : { polygons: [], lines: [], points: [] };
      describe();
    }

    function describe() {
      names = categories([...shapes.polygons, ...shapes.lines, ...shapes.points], ctx.params.colorBy);
      // The controller's Next walks the categories, and a slideshow moves on after the last.
      ctx.steps.define(ctx.params.reveal ? names.length : 0, names);
      ctx.publish({
        legend: names.length ? names.map((label, n) => ({ label, color: colour(n) })) : ctx.params.dataset ? [{ label: ctx.params.dataset, color: ctx.params.color }] : [],
        note: !ctx.params.dataset ? 'Choose a dataset of the site' : shapes.polygons.length + shapes.lines.length + shapes.points.length === 0 ? `No shapes in '${ctx.params.dataset}'` : '',
      });
      dirty = true;
    }

    let palette = tablePalette(ctx.site);
    ctx.onFrame((dt) => {
      // The table's palette changed: recolour, and send the legend again.
      if (tablePalette(ctx.site) !== palette) {
        palette = tablePalette(ctx.site);
        describe();
      }
      if (pulse > 0) {
        pulse = Math.max(0, pulse - dt);
        dirty = true;
      }
      if (!dirty) return;
      dirty = false;
      const revealed = ctx.params.reveal ? ctx.steps.revealed : 0;
      const newest = revealed - 1;
      const glow = pulse > 0 ? Math.sin((pulse / PULSE_S) * Math.PI) : 0;
      const g = canvas.ctx;
      canvas.clear();
      g.lineJoin = 'round';
      g.lineCap = 'round';
      const style = (properties: Record<string, unknown>) => {
        const n = category(properties);
        const alpha = strength(n, revealed, names.length);
        const lit = n === newest && glow > 0;
        return { colour: colour(n), alpha, extra: lit ? glow : 0 };
      };
      for (const polygon of shapes.polygons) {
        const { colour: c, alpha, extra } = style(polygon.properties);
        g.beginPath();
        tracePolygon(g, polygon.geometry);
        g.fillStyle = withAlpha(c, 0.45 * alpha + 0.3 * extra);
        g.fill('evenodd');
        g.strokeStyle = withAlpha(c, alpha);
        g.lineWidth = (ctx.params.width / canvas.scale) * (1 + extra);
        g.stroke();
      }
      for (const line of shapes.lines) {
        const { colour: c, alpha, extra } = style(line.properties);
        g.beginPath();
        traceLine(g, line.geometry);
        g.strokeStyle = withAlpha(c, alpha);
        g.lineWidth = ((ctx.params.width * 2) / canvas.scale) * (1 + extra);
        g.stroke();
      }
      for (const point of shapes.points) {
        const { colour: c, alpha, extra } = style(point.properties);
        g.beginPath();
        g.arc(point.geometry[0], point.geometry[1], ((ctx.params.width * 3) / canvas.scale) * (1 + extra), 0, Math.PI * 2);
        g.fillStyle = withAlpha(c, alpha);
        g.fill();
      }
      canvas.commit();
    });

    await load();

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('dataset')) void load();
        else if (changed.some((key) => key === 'colorBy' || key === 'reveal' || key === 'color')) describe();
        dirty = true;
      },
      step() {
        pulse = PULSE_S;
        dirty = true;
      },
    };
  },
});
