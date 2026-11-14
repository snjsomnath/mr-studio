// Visual blocks. Each is a function that draws shapes through a View with a style.
// A style value is either a constant or a function of the shape, so data-driven
// colouring is `fill: (b) => scale(b.properties.demand)`. Blocks keep no state:
// call them every frame with the current data.

import type { Point } from './geo.ts';
import { clamp01, css } from './scale.ts';
import type { Rgba } from './scale.ts';
import type { Area, Path, Spot } from './sources.ts';
import type { View } from './view.ts';

/** A constant, or a function of the shape being drawn. */
export type Styled<S, T> = T | ((shape: S) => T);

function resolve<S, T>(value: Styled<S, T> | undefined, shape: S, fallback: T): T {
  if (value === undefined) return fallback;
  return typeof value === 'function' ? (value as (shape: S) => T)(shape) : value;
}

function trace(view: View, points: readonly Point[], close: boolean): void {
  const pen = view.pen;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = view.toPx(points[i]!);
    if (i === 0) pen.moveTo(x, y);
    else pen.lineTo(x, y);
  }
  if (close) pen.closePath();
}

// ---- Areas: choropleths, footprints, vessels -------------------------------

export interface AreaStyle<P> {
  /** Fill colour, or null for none. This is the choropleth: colour by attribute. */
  fill?: Styled<Area<P>, Rgba | null>;
  stroke?: Styled<Area<P>, Rgba | null>;
  /** Outline width in pixels. */
  strokeWidth?: Styled<Area<P>, number>;
  /**
   * A second colour that fills the shape from its bottom edge up to `level` (0..1),
   * like liquid in a vessel: a battery's charge, a tank, a quota.
   */
  levelFill?: Styled<Area<P>, Rgba | null>;
  level?: Styled<Area<P>, number>;
  /** Skip shapes for which this is false. */
  show?: (area: Area<P>) => boolean;
}

/** Fills and outlines areas. With `fill` driven by a scale this is a choropleth. */
export function drawAreas<P>(view: View, areas: readonly Area<P>[], style: AreaStyle<P>): void {
  const pen = view.pen;
  for (const area of areas) {
    if (style.show && !style.show(area)) continue;
    const fill = resolve(style.fill, area, null);
    const stroke = resolve(style.stroke, area, null);
    const levelFill = resolve(style.levelFill, area, null);
    if (!fill && !stroke && !levelFill) continue;
    pen.beginPath();
    for (const polygon of area.polygons) for (const ring of polygon) trace(view, ring, true);
    if (fill) {
      pen.fillStyle = css(fill);
      pen.fill('evenodd');
    }
    if (levelFill) {
      const level = clamp01(resolve(style.level, area, 0));
      if (level > 0) {
        let top = Infinity;
        let bottom = -Infinity;
        let left = Infinity;
        let right = -Infinity;
        for (const polygon of area.polygons) {
          for (const point of polygon[0] ?? []) {
            const [x, y] = view.toPx(point);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
        pen.save();
        pen.clip('evenodd');
        pen.fillStyle = css(levelFill);
        pen.beginPath();
        pen.rect(left, bottom - (bottom - top) * level, right - left, (bottom - top) * level);
        pen.fill();
        pen.restore();
        // The clip consumed the path; trace it again for the outline.
        if (stroke) {
          pen.beginPath();
          for (const polygon of area.polygons) for (const ring of polygon) trace(view, ring, true);
        }
      }
    }
    if (stroke) {
      pen.strokeStyle = css(stroke);
      pen.lineWidth = resolve(style.strokeWidth, area, 1) * view.detail;
      pen.stroke();
    }
  }
}

// ---- Paths: networks, routes, flow lines -----------------------------------

export interface PathStyle<P> {
  colour: Styled<Path<P>, Rgba>;
  /** Width in pixels. Drive it by a flow's share to make a flow map. */
  width?: Styled<Path<P>, number>;
  /** A soft halo this many times the width, 0 for none. */
  glow?: number;
  /** Dash and gap in pixels. */
  dash?: readonly [number, number];
  /** Draw only this share of the line from its start, 0..1, for drawing a line in. */
  reveal?: Styled<Path<P>, number>;
  show?: (path: Path<P>) => boolean;
}

/** Draws lines. With `width` driven by a value this is a flow map; with `reveal` the lines draw themselves in. */
export function drawPaths<P>(view: View, paths: readonly Path<P>[], style: PathStyle<P>): void {
  const pen = view.pen;
  pen.lineCap = 'round';
  pen.lineJoin = 'round';
  pen.setLineDash(style.dash ? [style.dash[0] * view.detail, style.dash[1] * view.detail] : []);
  for (const path of paths) {
    if (style.show && !style.show(path)) continue;
    const width = resolve(style.width, path, 2) * view.detail;
    const reveal = clamp01(resolve(style.reveal, path, 1));
    if (width <= 0 || reveal <= 0 || path.points.length < 2) continue;
    const colour = resolve(style.colour, path, [255, 255, 255, 1] as Rgba);
    pen.beginPath();
    if (reveal >= 1) trace(view, path.points, false);
    else {
      const limit = path.length * reveal;
      for (let i = 0; i < path.points.length; i++) {
        if (path.stations[i]! <= limit) {
          const [x, y] = view.toPx(path.points[i]!);
          if (i === 0) pen.moveTo(x, y);
          else pen.lineTo(x, y);
        } else {
          const a = path.points[i - 1]!;
          const b = path.points[i]!;
          const span = path.stations[i]! - path.stations[i - 1]!;
          const t = span > 0 ? (limit - path.stations[i - 1]!) / span : 0;
          const [x, y] = view.toPx([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
          pen.lineTo(x, y);
          break;
        }
      }
    }
    if (style.glow) {
      pen.strokeStyle = css(colour, 0.25);
      pen.lineWidth = width * style.glow;
      pen.stroke();
    }
    pen.strokeStyle = css(colour);
    pen.lineWidth = width;
    pen.stroke();
  }
  pen.setLineDash([]);
}

// ---- Spots: markers, nodes, labels ------------------------------------------

export interface SpotStyle<P> {
  colour: Styled<Spot<P>, Rgba>;
  /** Radius in pixels. */
  radius?: Styled<Spot<P>, number>;
  /** A soft glow this many pixels wide around the marker, 0 for none. */
  halo?: Styled<Spot<P>, number>;
  /** A white centre, as a share of the radius. */
  core?: number;
  label?: Styled<Spot<P>, string | null>;
  /** Label size in pixels. Default 13. */
  labelSize?: number;
  show?: (spot: Spot<P>) => boolean;
}

/** Draws point markers with an optional glow, core and label. */
export function drawSpots<P>(view: View, spots: readonly Spot<P>[], style: SpotStyle<P>): void {
  const pen = view.pen;
  for (const spot of spots) {
    if (style.show && !style.show(spot)) continue;
    const colour = resolve(style.colour, spot, [255, 255, 255, 1] as Rgba);
    const radius = resolve(style.radius, spot, 5) * view.detail;
    const [x, y] = view.toPx(spot.point);
    const halo = resolve(style.halo, spot, 0) * view.detail;
    if (halo > 0) glow(view, x, y, radius + halo, colour, 0.75);
    if (radius > 0) {
      pen.fillStyle = css(colour);
      pen.beginPath();
      pen.arc(x, y, radius, 0, Math.PI * 2);
      pen.fill();
      if (style.core) {
        pen.fillStyle = css([255, 255, 255, 0.9 * colour[3]]);
        pen.beginPath();
        pen.arc(x, y, radius * style.core, 0, Math.PI * 2);
        pen.fill();
      }
    }
    const label = resolve(style.label, spot, null);
    if (label) drawLabel(view, spot.point, label, { colour, size: style.labelSize, offset: radius + 6 * view.detail });
  }
}

/** Text centred above a point, with a dark shadow so it reads on any layer. */
export function drawLabel(view: View, at: Point, text: string, options: { colour?: Rgba; size?: number; offset?: number } = {}): void {
  const pen = view.pen;
  const [x, y] = view.toPx(at);
  pen.save();
  pen.font = `600 ${(options.size ?? 13) * view.detail}px system-ui, sans-serif`;
  pen.textAlign = 'center';
  pen.textBaseline = 'bottom';
  pen.shadowColor = 'rgba(0,0,0,0.7)';
  pen.shadowBlur = 6 * view.detail;
  pen.fillStyle = css(options.colour ?? [255, 255, 255, 1]);
  pen.fillText(text, x, y - (options.offset ?? 8 * view.detail));
  pen.restore();
}

function glow(view: View, x: number, y: number, radius: number, colour: Rgba, strength: number): void {
  const pen = view.pen;
  const gradient = pen.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, css(colour, strength));
  gradient.addColorStop(0.6, css(colour, strength * 0.35));
  gradient.addColorStop(1, css(colour, 0));
  pen.fillStyle = gradient;
  pen.beginPath();
  pen.arc(x, y, radius, 0, Math.PI * 2);
  pen.fill();
}

/** A soft disc that fades to nothing at `radius_m`: a catchment, a gravity well, a spotlight. */
export function drawGlow(view: View, centre: Point, radius_m: number, colour: Rgba, strength = 0.35): void {
  const [x, y] = view.toPx(centre);
  glow(view, x, y, radius_m * view.scale, colour, strength);
}

// ---- Rings: pulses and ripples ----------------------------------------------

export interface RingStyle {
  colour: Rgba;
  /** Outer radius in metres. */
  radius_m: number;
  /** +1 rings travel outward (energy leaving), -1 inward (arriving), 0 stand still. */
  direction?: 1 | -1 | 0;
  /** 0..1: how strongly the rings show. 0 draws nothing. */
  level?: number;
  /** How many rings are in flight at once. Default 2. */
  count?: number;
  /** Seconds for a ring to cross the radius. Default 2.4. */
  period?: number;
  /** Ripple amplitude as a share of the radius; 0 is a clean circle. */
  wobble?: number;
  /** Line width in pixels. Default 1.5. */
  width?: number;
}

/**
 * Rings around a point. Travelling outward or inward they show which way something
 * flows through a node; with `wobble` and no direction they are the ripples of a
 * gravity well. `phase` offsets the animation so neighbours do not pulse together.
 */
export function drawRings(view: View, centre: Point, style: RingStyle, phase = 0): void {
  const level = clamp01(style.level ?? 1);
  if (level <= 0) return;
  const pen = view.pen;
  const [x, y] = view.toPx(centre);
  const count = style.count ?? 2;
  const period = style.period ?? 2.4;
  const direction = style.direction ?? 1;
  const outer = style.radius_m * view.scale;
  pen.lineWidth = (style.width ?? 1.5) * view.detail;
  for (let i = 0; i < count; i++) {
    let t = direction === 0 ? (i + 1) / count : (((view.time / period + i / count + phase) % 1) + 1) % 1;
    if (direction < 0) t = 1 - t;
    const radius = outer * (direction === 0 ? 0.55 + 0.45 * t : t);
    // Rings fade as they leave and, travelling inward, as they arrive.
    const fade = direction === 0 ? 1 - 0.25 * i : direction > 0 ? 1 - t : t;
    pen.strokeStyle = css(style.colour, level * fade);
    pen.beginPath();
    if (!style.wobble) pen.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
    else {
      const amplitude = radius * style.wobble * (1 + i * 0.22);
      const waves = 7 + i;
      const speed = 4.2 + i * 1.1;
      for (let k = 0; k <= 60; k++) {
        const a = (k / 60) * Math.PI * 2;
        const r = radius + amplitude * Math.sin(a * waves + (view.time + phase * 10) * speed + i * 1.7) + amplitude * 0.32 * Math.sin(a * waves * 0.5 - view.time * speed * 0.7);
        if (k === 0) pen.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        else pen.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      pen.closePath();
    }
    pen.stroke();
  }
}

// ---- Dots: particles and travelling lights ----------------------------------

export interface Dot {
  point: Point;
  colour: Rgba;
  /** 0..1, multiplied into the colour's alpha. */
  alpha?: number;
  /** Radius in pixels. */
  size?: number;
}

/** Draws many small lights additively, so a crowd of them brightens where it gathers. */
export function drawDots(view: View, dots: Iterable<Dot>, options: { core?: boolean } = {}): void {
  const pen = view.pen;
  pen.save();
  pen.globalCompositeOperation = 'lighter';
  for (const dot of dots) {
    const alpha = dot.alpha ?? 1;
    if (alpha <= 0) continue;
    const [x, y] = view.toPx(dot.point);
    const size = (dot.size ?? 3) * view.detail;
    pen.fillStyle = css(dot.colour, alpha);
    pen.beginPath();
    pen.arc(x, y, size, 0, Math.PI * 2);
    pen.fill();
    if (options.core !== false) {
      pen.fillStyle = css([255, 255, 255, 0.7], alpha);
      pen.beginPath();
      pen.arc(x, y, size * 0.42, 0, Math.PI * 2);
      pen.fill();
    }
  }
  pen.restore();
}
