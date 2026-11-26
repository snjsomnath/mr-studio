// Shadow trails over the day (#265, from #81). The shadows of every other hour the sun is well up,
// laid on the ground together, each in its hour's colour from the cool morning through the pale
// noon to the warm evening: the ground reads as a shade clock, blue where the morning shades it,
// amber where the evening does, stronger where shade lasts. Outlines of every hour tangle in a
// dense city, so only the hour the controller is on is outlined, brightly. With a spot picked,
// the trails show just around it, as a sun clock for that place.
import { contours, tableFrame, zonedTimeToUtc } from '@mrstudio/sdk';
import type { FieldFrame, TableContext } from '@mrstudio/sdk';

import { sunAt } from './look.ts';

type Params = { mode: string; date: string; hour: number; trails: boolean; opacity: number };

/** Hours the sun is this high or more get a trail; a lower sun's shadows run across half the table. */
export const TRAIL_MIN_ALTITUDE = 12;
/** A trail every this many hours: more than that and a dense city turns into a tangle. */
export const TRAIL_STEP_H = 2;
/** With a spot picked, the trails show only this far around it, as a sun clock for that place. */
const FOCUS_M = 90;

/** The even hours of a day that get a trail. */
export function trailHours(altitudeAt: (hour: number) => number): number[] {
  const hours: number[] = [];
  for (let h = 0; h <= 24; h += TRAIL_STEP_H) if (altitudeAt(h) >= TRAIL_MIN_ALTITUDE) hours.push(h);
  return hours;
}

/** The trail hour nearest the controller's time, if one is within a step. */
export function nearestTrail(hours: readonly number[], hour: number): number | null {
  let best: number | null = null;
  for (const h of hours) if (Math.abs(h - hour) < TRAIL_STEP_H / 2 + 1e-6 && (best === null || Math.abs(h - hour) < Math.abs(best - hour))) best = h;
  return best;
}

const MORNING: [number, number, number] = [110, 170, 255];
const NOON: [number, number, number] = [255, 246, 214];
const EVENING: [number, number, number] = [255, 150, 80];

/** A trail's colour, by where its hour falls between the first and the last: cool, pale, warm. */
export function trailColour(share: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, share));
  const [a, b, f] = t < 0.5 ? [MORNING, NOON, t * 2] : [NOON, EVENING, (t - 0.5) * 2];
  return [0, 1, 2].map((c) => Math.round(a[c]! + (b[c]! - a[c]!) * f)) as [number, number, number];
}

export const trailCss = (share: number, alpha = 1) => `rgb(${trailColour(share).join(' ')} / ${alpha})`;

/** Outlines are traced on a grid at most this many cells wide: smooth enough, and quick to draw. */
const TRACE_CELLS = 320;

/**
 * The field averaged down to at most `cells` wide and then over each cell's neighbours, so the
 * outlines follow buildings smoothly instead of in steps, with few enough segments to draw.
 */
export function softened(field: FieldFrame, cells = TRACE_CELLS): FieldFrame {
  const quantised = field.data instanceof Uint8Array;
  const at = (i: number) => (quantised ? field.min + (field.data[i]! / 255) * (field.max - field.min) : field.data[i]!);
  const f = Math.max(1, Math.ceil(field.width / cells));
  const width = Math.max(1, Math.floor(field.width / f));
  const height = Math.max(1, Math.floor(field.height / f));
  const small = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += at((y * f + dy) * field.width + x * f + dx);
      small[y * width + x] = sum / (f * f);
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += small[yy * width + xx]!;
          n++;
        }
      }
      out[y * width + x] = sum / n;
    }
  }
  return { ...field, width, height, data: out, min: 0, max: 1 };
}

/**
 * The shade clock as RGBA pixels, one per cell: each cell takes the average colour of the hours it is
 * in shade, and is the stronger the more of them it is; cells always lit stay clear.
 */
export function shadeClock(hours: { share: number; field: FieldFrame }[]): Uint8ClampedArray {
  const first = hours[0]?.field;
  if (!first) return new Uint8ClampedArray(0);
  const n = first.width * first.height;
  const out = new Uint8ClampedArray(n * 4);
  const colours = hours.map((h) => trailColour(h.share));
  for (let i = 0; i < n; i++) {
    let weight = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    hours.forEach((h, k) => {
      const shade = 1 - (h.field.data[i] ?? 1);
      if (shade <= 0.02) return;
      const c = colours[k]!;
      weight += shade;
      r += c[0] * shade;
      g += c[1] * shade;
      b += c[2] * shade;
    });
    if (weight <= 0) continue;
    out[i * 4] = r / weight;
    out[i * 4 + 1] = g / weight;
    out[i * 4 + 2] = b / weight;
    // A share of the hours in shade: one hour is a faint wash, all day nearly solid.
    out[i * 4 + 3] = Math.round(255 * (0.18 + 0.62 * Math.sqrt(Math.min(1, weight / hours.length))));
  }
  return out;
}

interface Trail {
  hour: number;
  share: number;
  /** The shadow at that hour, softened: 1 lit, 0 shade. */
  field: FieldFrame;
}

export function trailsOnTable(ctx: TableContext<Params>, spotAt: () => [number, number] | null) {
  const drawing = ctx.map.addDrawing('sunlight-trails', { opacity: ctx.params.opacity });
  const frame = tableFrame(ctx.site);
  let trails: Trail[] = [];
  let picture: HTMLCanvasElement | null = null;
  let asked = 0;
  let drawn = '';
  /** The outline of each hour, traced when first shown. */
  const outlines = new Map<number, (readonly [readonly number[], readonly number[]])[]>();

  const wanted = () => ctx.params.trails && ctx.params.mode === 'instant';

  /** Asks the engine for the shadows at each trail hour, one short job each. */
  async function compute() {
    const mine = ++asked;
    trails = [];
    picture = null;
    outlines.clear();
    drawn = '';
    if (!wanted()) return;
    const date = ctx.params.date;
    const hours = trailHours((h) => sunAt(ctx.site, date, h).altitude);
    const span = Math.max(1, hours.length - 1);
    const found = await Promise.all(
      hours.map(async (hour, k): Promise<Trail | null> => {
        try {
          const stream = await ctx.engine.open('sunlight', { mode: 'instant', time: zonedTimeToUtc(date, hour, ctx.site.timezone), trees: false }, ['shadow']);
          const shadow = await new Promise<FieldFrame>((resolve) => stream.on('shadow', (f) => f.progress >= 1 && resolve(f)));
          stream.close();
          return { hour, share: k / span, field: softened(shadow) };
        } catch (error) {
          console.warn(`[sunlight] the ${hour}:00 shadows were not drawn`, error);
          return null;
        }
      }),
    );
    if (mine !== asked) return;
    trails = found.filter((t): t is Trail => t !== null);
    const first = trails[0]?.field;
    if (first) {
      picture = document.createElement('canvas');
      picture.width = first.width;
      picture.height = first.height;
      picture.getContext('2d')!.putImageData(new ImageData(shadeClock(trails) as Uint8ClampedArray<ArrayBuffer>, first.width, first.height), 0, 0);
    }
    ctx.publish({ trailHours: trails.map((t) => t.hour) });
    drawn = '';
  }

  ctx.onFrame(() => {
    const now = wanted() ? (nearestTrail(trails.map((t) => t.hour), ctx.clock.now() ?? ctx.params.hour) ?? -1) : -1;
    const spot = spotAt();
    const key = wanted() ? `${trails.length}|${now}|${spot?.join() ?? ''}` : '';
    if (key === drawn) return;
    drawn = key;
    drawing.clear();
    if (wanted() && picture) {
      const g = drawing.ctx;
      const { width: w, height: h } = drawing;
      g.save();
      if (spot) {
        // Around a spot: the trails inside a circle, its edge marked faintly.
        const [cx, cy] = frame.toTable(spot);
        g.strokeStyle = 'rgb(255 255 255 / 0.45)';
        g.lineWidth = 1.5 / drawing.scale;
        g.setLineDash([4 / drawing.scale, 6 / drawing.scale]);
        g.beginPath();
        g.arc(cx, cy, FOCUS_M, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
        g.clip();
      }
      g.imageSmoothingEnabled = true;
      g.drawImage(picture, 0, 0, w, h);
      // The controller's hour, outlined in its colour over a dark edge so it reads on lit ground.
      const trail = trails.find((t) => t.hour === now);
      if (trail) {
        let lines = outlines.get(trail.hour);
        if (!lines) {
          lines = contours(trail.field, w, [0.5])[0]!.segments;
          outlines.set(trail.hour, lines);
        }
        const path = new Path2D();
        for (const [a, b] of lines) {
          path.moveTo(a[0]!, a[1]!);
          path.lineTo(b[0]!, b[1]!);
        }
        g.lineCap = 'round';
        g.strokeStyle = 'rgb(10 14 30 / 0.55)';
        g.lineWidth = 4.5 / drawing.scale;
        g.stroke(path);
        g.strokeStyle = trailCss(trail.share);
        g.lineWidth = 2.2 / drawing.scale;
        g.stroke(path);
      }
      g.restore();
    }
    drawing.commit();
  });

  void compute();

  return {
    update(changed: string[]) {
      if (changed.includes('opacity')) drawing.setOpacity(ctx.params.opacity);
      if (changed.some((key) => key === 'trails' || key === 'mode' || key === 'date')) void compute();
      drawn = '';
    },
  };
}
