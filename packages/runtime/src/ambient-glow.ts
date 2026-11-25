// The ambient glow (#476): the projector's blank space around the model glows softly in the
// model's own colours, as the lights behind some televisions do. A few times a second the table
// is copied at a tiny size, the colours along each of the model's edges are read from it, and a
// small canvas paints them fading out from the edge. The browser stretches that canvas over the
// surface, which smooths it; there is no blur filter (WebKit draws those slowly, #181). Colours
// ease towards the new ones over about a second, so the glow breathes rather than flickers.
// Rules in docs/contracts/present.md, Ambient glow.

import type { SiteInfo } from '@mrstudio/sdk';
import { pixelsPerCm } from './ribbon-bands.ts';

type RGB = [number, number, number];
type Quad = [[number, number], [number, number], [number, number], [number, number]];

/** Colours read along each edge, from one end to the other. */
export const SEGMENTS = 10;
/** How far the glow reaches from the model's edge, in cm on the table. */
export const REACH_CM = 14;
/** Copies of the table a second. */
const SAMPLES_PER_S = 4;
/** Seconds the colours take to get most of the way to new ones. */
const EASE_S = 0.8;
/** The glow's canvas is the surface divided by this: small, then stretched smooth. */
const DOWNSCALE = 10;

export interface GlowSettings {
  on: boolean;
  /** 0 to 1. */
  strength: number;
  colours: 'edges' | 'one';
}

/** The table's glow settings with their defaults, or null when it is off. */
export function glowSettings(table: SiteInfo['table']): GlowSettings | null {
  const glow = table?.glow;
  if (!glow || glow.on === false) return null;
  return { on: true, strength: Math.max(0, Math.min(1, glow.strength ?? 0.5)), colours: glow.colours === 'one' ? 'one' : 'edges' };
}

/**
 * How much a pixel counts towards the colour: vivid and bright colours count, dark and grey ones
 * hardly, so a yellow layer over a dark base map gives a yellow glow rather than a muddy one.
 */
function weight(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  const value = max / 255;
  return 0.005 + value * value * (0.08 + saturation * saturation * 4);
}

/**
 * A colour brought up to glow: as bright as `floor` at least in its strongest channel, keeping its
 * hue, as a television's lights do with a dim picture. Black stays black.
 */
export function lift([r, g, b]: RGB, floor = 190): RGB {
  const max = Math.max(r, g, b);
  if (max < 1) return [0, 0, 0];
  // A nearly black edge stays dim: the lift grows with how much light there is to lift.
  const k = Math.max(1, (floor * Math.min(1, max / 60)) / max);
  return [Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k)];
}

/**
 * The colours along each edge of `quad` (top, right, bottom, left, each in `SEGMENTS` steps from
 * its first corner), read from a small picture of the table just inside the edge. With
 * `colours: 'one'`, every step gets the picture's one dominant colour.
 */
export function edgeColours(image: { width: number; height: number; data: Uint8ClampedArray }, quad: Quad, colours: 'edges' | 'one'): RGB[][] {
  const { width, height, data } = image;
  const read = (x: number, y: number): RGB | null => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const i = (py * width + px) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };
  const mix = (samples: RGB[]): RGB => {
    let [r, g, b, w] = [0, 0, 0, 0];
    for (const [sr, sg, sb] of samples) {
      const k = weight(sr, sg, sb);
      r += sr * k;
      g += sg * k;
      b += sb * k;
      w += k;
    }
    return w > 0 ? lift([r / w, g / w, b / w]) : [0, 0, 0];
  };
  const centre = [quad.reduce((s, p) => s + p[0], 0) / 4, quad.reduce((s, p) => s + p[1], 0) / 4];
  if (colours === 'one') {
    const all: RGB[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inside(quad, x, y)) all.push(read(x, y)!);
    const one = mix(all);
    return quad.map(() => Array.from({ length: SEGMENTS }, () => [...one] as RGB));
  }
  return quad.map((a, side) => {
    const b = quad[(side + 1) % 4]!;
    return Array.from({ length: SEGMENTS }, (_, s) => {
      const samples: RGB[] = [];
      // A patch of the segment, from just inside the edge to a sixth of the way in.
      for (let along = 0; along < 3; along++) {
        const t = (s + (along + 0.5) / 3) / SEGMENTS;
        const ex = a[0] + (b[0] - a[0]) * t;
        const ey = a[1] + (b[1] - a[1]) * t;
        for (let depth = 0.02; depth <= 0.17; depth += 0.05) {
          const sample = read(ex + (centre[0]! - ex) * depth, ey + (centre[1]! - ey) * depth);
          if (sample) samples.push(sample);
        }
      }
      return mix(samples);
    });
  });
}

/** Whether a point is inside a convex quad given clockwise or anticlockwise. */
function inside(quad: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i]!;
    const [bx, by] = quad[(i + 1) % 4]!;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
  }
  return true;
}

/**
 * Paints the glow into `out` (RGBA, `width` × `height`): outside `quad`, each pixel takes the
 * colour of the nearest point on the model's edge and fades with its distance, `reach` pixels
 * to fall to about a tenth. Inside the model nothing is painted.
 */
export function paintGlow(out: Uint8ClampedArray, width: number, height: number, quad: Quad, colours: RGB[][], strength: number, reach: number): void {
  const at = (side: number, t: number): RGB => {
    // Between the middles of the segments, so the colour changes smoothly along the edge.
    const steps = colours[side]!;
    const f = Math.max(0, Math.min(SEGMENTS - 1, t * SEGMENTS - 0.5));
    const i = Math.floor(f);
    const k = f - i;
    const a = steps[i]!;
    const b = steps[Math.min(SEGMENTS - 1, i + 1)]!;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  };
  const fall = 2.3 / Math.max(1, reach);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      if (inside(quad, px, py)) {
        out[o + 3] = 0;
        continue;
      }
      let best = Infinity;
      let side = 0;
      let along = 0;
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = quad[i]!;
        const [bx, by] = quad[(i + 1) % 4]!;
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
        if (d < best) [best, side, along] = [d, i, t];
      }
      const [r, g, b] = at(side, along);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255 * strength * Math.exp(-best * fall);
    }
  }
}

/** Where the table is, for the glow: the model's corners on the surface in CSS pixels, and the surface's size. */
export interface GlowMeasure {
  footprint: [number, number][];
  surface: { width: number; height: number };
  /** Where the table view (what `sample` copies) is on the surface, when it doesn't fill it. */
  view?: { left: number; top: number; width: number };
}

/** What the glow needs from the table view. */
export interface GlowSource {
  /** The table copied `width` pixels wide, with the surface's proportions, or null when it can't be. */
  sample(width: number): Promise<ImageData | null>;
  /** What the open layers ask of the glow, the most recent first: 'off', a fixed colour, or nothing. */
  glowWish(): 'off' | string | null;
}

function parseColour(css: string): RGB | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (!hex) return null;
  const n = parseInt(hex[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class AmbientGlow {
  private readonly canvas = document.createElement('canvas');
  private readonly g = this.canvas.getContext('2d')!;
  private current: RGB[][] | null = null;
  private target: RGB[][] | null = null;
  private shown = 0;
  private lastSample = 0;
  private sampling = false;
  private last = 0;
  private frame = 0;
  private stopped = false;

  private readonly source: GlowSource;
  private readonly measure: () => GlowMeasure | null;
  private readonly settings: () => SiteInfo['table'];

  constructor(host: HTMLElement, source: GlowSource, measure: () => GlowMeasure | null, settings: () => SiteInfo['table']) {
    this.source = source;
    this.measure = measure;
    this.settings = settings;
    this.canvas.className = 'table-glow';
    this.canvas.setAttribute('aria-hidden', 'true');
    // Under the ribbons, which stay on top.
    host.append(this.canvas);
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    this.canvas.remove();
  }

  private tick = (now: number): void => {
    if (this.stopped) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.last ? Math.min(0.25, (now - this.last) / 1000) : 0;
    this.last = now;
    const settings = glowSettings(this.settings());
    const wish = this.source.glowWish();
    const measured = this.measure();
    const wanted = settings && wish !== 'off' && measured ? settings.strength : 0;
    // The glow fades in and out with the setting and with the layers that turn it off.
    const fade = 1 - Math.exp(-dt / (EASE_S / 2));
    this.shown += (wanted - this.shown) * fade;
    if (this.shown < 0.004 && wanted === 0) {
      if (!this.canvas.hidden) this.canvas.hidden = true;
      return;
    }
    this.canvas.hidden = false;
    if (!measured || !settings) return;
    const fixed = wish && wish !== 'off' ? parseColour(wish) : null;
    if (fixed) this.target = [0, 1, 2, 3].map(() => Array.from({ length: SEGMENTS }, () => [...fixed] as RGB));
    else if (now - this.lastSample > 1000 / SAMPLES_PER_S && !this.sampling) void this.take(measured, settings.colours, now);
    if (!this.target) return;
    if (!this.current) this.current = this.target.map((side) => side.map((c) => [...c] as RGB));
    const ease = 1 - Math.exp(-dt / (EASE_S / 2.3));
    let moving = false;
    for (let side = 0; side < 4; side++) {
      for (let s = 0; s < SEGMENTS; s++) {
        const c = this.current[side]![s]!;
        const t = this.target[side]![s]!;
        for (let k = 0; k < 3; k++) {
          const step = (t[k]! - c[k]!) * ease;
          if (Math.abs(t[k]! - c[k]!) > 0.5) moving = true;
          c[k] = c[k]! + step;
        }
      }
    }
    // Painting is a few thousand pixels; it is still skipped when nothing changes.
    const key = `${Math.round(this.shown * 200)}|${measured.surface.width}x${measured.surface.height}|${measured.footprint.flat().map(Math.round).join(',')}`;
    if (!moving && key === this.painted) return;
    this.painted = key;
    this.paint(measured);
  };
  private painted = '';

  private async take(measured: GlowMeasure, colours: 'edges' | 'one', now: number): Promise<void> {
    this.sampling = true;
    this.lastSample = now;
    try {
      const width = 96;
      const image = await this.source.sample(width);
      if (!image) return;
      const view = measured.view ?? { left: 0, top: 0, width: measured.surface.width };
      const k = image.width / Math.max(1, view.width);
      const quad = measured.footprint.map(([x, y]) => [(x - view.left) * k, (y - view.top) * k]) as Quad;
      this.target = edgeColours(image, quad, colours);
    } catch (error) {
      console.warn('[glow] the table could not be read', error);
    } finally {
      this.sampling = false;
    }
  }

  private paint(measured: GlowMeasure): void {
    const { surface, footprint } = measured;
    const width = Math.max(8, Math.round(surface.width / DOWNSCALE));
    const height = Math.max(8, Math.round(surface.height / DOWNSCALE));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const k = width / Math.max(1, surface.width);
    const quad = footprint.map(([x, y]) => [x * k, y * k]) as Quad;
    const table = this.settings();
    const perCm = table && table.width_cm > 0 ? pixelsPerCm(footprint, table) * k : 0;
    const reach = perCm > 0 ? REACH_CM * perCm : Math.min(width, height) * 0.12;
    const image = this.g.createImageData(width, height);
    paintGlow(image.data, width, height, quad, this.current!, this.shown, reach);
    this.g.putImageData(image, 0, 0);
  }
}
