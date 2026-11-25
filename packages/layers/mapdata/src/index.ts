import { readSiteGeometry, categorySlots, defineLayer, pickScheme, schemeColour, schemeOrder, tablePalette, traceLine, tracePolygon, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest, Placed, XY } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { PALETTE, PULSE_S, categories, categoryColours, strength } from './categories.ts';

interface Params {
  dataset: string;
  colorBy: string;
  color: string;
  /** `auto` (a scheme when every value belongs to one, such as energy classes), `palette`, or a scheme's id (#207). */
  scheme?: string;
  /** The colour of each category, set by the author; beats the scheme and the palette. */
  colors?: Record<string, string>;
  reveal: boolean;
  width: number;
  opacity: number;
}

/** Above this many shapes the drawing is spread over frames (#263), SLICE_MS per frame, checking the time every SLICE_SHAPES shapes. */
const SLICE_FROM = 3000;
const SLICE_MS = 6;
const SLICE_SHAPES = 50;

type Shapes = { polygons: Placed<XY[][]>[]; lines: Placed<XY[]>[]; points: Placed<XY>[] };

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('mapdata', { opacity: ctx.params.opacity });
    let shapes: Shapes = { polygons: [], lines: [], points: [] };
    let names: string[] = [];
    let pulse = 0;
    let dirty = true;

    let scheme: ReturnType<typeof pickScheme> = null;
    const category = (properties: Record<string, unknown>) => (names.length ? names.indexOf(String(properties?.[ctx.params.colorBy])) : -1);
    // A category's own colours come first: the author's, then a scheme such as energy classes
    // (#207). Otherwise categories take the table palette's eight category colours (#93), then the layer's own extras.
    const colour = (n: number) => {
      if (n < 0) return ctx.params.color;
      const name = names[n]!;
      const own = ctx.params.colors && typeof ctx.params.colors === 'object' ? ctx.params.colors[name] : undefined;
      return own ?? (scheme ? schemeColour(scheme, name) : null) ?? categoryColours(categorySlots(tablePalette(ctx.site)))[n % PALETTE.length]!;
    };

    async function load() {
      shapes = (ctx.params.dataset ? await readSiteGeometry(ctx.site, ctx.params.dataset) : null) ?? { polygons: [], lines: [], points: [] };
      describe();
    }

    function describe() {
      names = categories([...shapes.polygons, ...shapes.lines, ...shapes.points], ctx.params.colorBy);
      scheme = pickScheme(ctx.params.scheme, names);
      // Classes in their own order (A to G), so Next reveals the scale, not the file's order.
      if (scheme) names = schemeOrder(scheme, names);
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
      if (dirty && !job) {
        dirty = false;
        const count = shapes.polygons.length + shapes.lines.length + shapes.points.length;
        if (count <= SLICE_FROM) {
          canvas.clear();
          paint(canvas.ctx);
          canvas.commit();
        } else {
          // A big dataset (#263) is drawn a few milliseconds per frame into a picture of its own,
          // so the table keeps moving, and the old picture stays up until the new one is done.
          const { width, height } = canvas.ctx.canvas;
          const back = new OffscreenCanvas(width, height);
          // Drawn on the CPU, so the time each slice takes is the time it costs (a GPU canvas only records).
          const g = back.getContext('2d', { willReadFrequently: true })!;
          g.setTransform(canvas.ctx.getTransform());
          job = { back, steps: painting(g as unknown as CanvasRenderingContext2D) };
        }
      }
      if (job) {
        const until = performance.now() + SLICE_MS;
        let step = job.steps.next();
        while (!step.done && performance.now() < until) step = job.steps.next();
        if (step.done) {
          canvas.clear();
          const g = canvas.ctx;
          g.save();
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.drawImage(job.back, 0, 0);
          g.restore();
          canvas.commit();
          job = null;
        }
      }
    });
    let job: { back: OffscreenCanvas; steps: Generator<void, void> } | null = null;

    /** Draws the shapes as they are now into `g`, in table metres: the table's drawing, and a magnifier's sharp picture (#413). */
    function paint(g: CanvasRenderingContext2D) {
      for (const _ of painting(g));
    }

    /** `paint`, pausing after every few hundred shapes. */
    function* painting(g: CanvasRenderingContext2D): Generator<void, void> {
      const revealed = ctx.params.reveal ? ctx.steps.revealed : 0;
      const newest = revealed - 1;
      const glow = pulse > 0 ? Math.sin((pulse / PULSE_S) * Math.PI) : 0;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      // One style per category, worked out once per drawing rather than once per shape.
      const styles = new Map<number, { colour: string; alpha: number; extra: number; fill: string; stroke: string }>();
      const style = (properties: Record<string, unknown>) => {
        const n = category(properties);
        let found = styles.get(n);
        if (!found) {
          const alpha = strength(n, revealed, names.length);
          const extra = n === newest && glow > 0 ? glow : 0;
          const c = colour(n);
          found = { colour: c, alpha, extra, fill: withAlpha(c, 0.45 * alpha + 0.3 * extra), stroke: withAlpha(c, alpha) };
          styles.set(n, found);
        }
        return found;
      };
      let drawn = 0;
      for (const polygon of shapes.polygons) {
        const { fill, stroke, extra } = style(polygon.properties);
        g.beginPath();
        tracePolygon(g, polygon.geometry);
        g.fillStyle = fill;
        g.fill('evenodd');
        g.strokeStyle = stroke;
        g.lineWidth = (ctx.params.width / canvas.scale) * (1 + extra);
        g.stroke();
        if (++drawn % SLICE_SHAPES === 0) yield;
      }
      for (const line of shapes.lines) {
        const { stroke, extra } = style(line.properties);
        g.beginPath();
        traceLine(g, line.geometry);
        g.strokeStyle = stroke;
        g.lineWidth = ((ctx.params.width * 2) / canvas.scale) * (1 + extra);
        g.stroke();
        if (++drawn % SLICE_SHAPES === 0) yield;
      }
      for (const point of shapes.points) {
        const { stroke, extra } = style(point.properties);
        g.beginPath();
        g.arc(point.geometry[0], point.geometry[1], ((ctx.params.width * 3) / canvas.scale) * (1 + extra), 0, Math.PI * 2);
        g.fillStyle = stroke;
        g.fill();
        if (++drawn % SLICE_SHAPES === 0) yield;
      }
    }
    ctx.map.addDetail((g) => {
      g.globalAlpha = ctx.params.opacity;
      paint(g);
    });

    await load();

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('dataset')) void load();
        else if (changed.some((key) => key === 'colorBy' || key === 'reveal' || key === 'color' || key === 'scheme' || key === 'colors')) describe();
        dirty = true;
      },
      step() {
        pulse = PULSE_S;
        dirty = true;
      },
    };
  },
});
