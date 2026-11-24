// The attention cue (#105): one bright burst where something on the table just changed, so
// visitors who were looking at the controller or a phone look back at the right place.
// It plays once and settles (rule M5 in docs/visualisation.md: never a repeating blink), and it
// is the brightest thing on the table while it lasts (M9).
//
// Pure drawing: `drawCue(view, target, age)` draws the cue as it looks `age` seconds after it
// started, and says whether it is still playing. The runtime plays one automatically for a
// tool input from another surface; a layer can play one with `ctx.cue(...)`.

import type { Point } from './geo.ts';
import { clamp01, css } from './scale.ts';
import type { Rgba } from './scale.ts';
import type { View } from './view.ts';

/** Where the change is, in table metres: a place, a line or an area (an open or closed ring). */
export type CueTarget = { point: Point } | { line: Point[] } | { area: Point[] };

/** How long a cue plays, in seconds. */
export const CUE_SECONDS = 1.4;

export interface CueStyle {
  /** Default white. The palette accent also works; it should be the brightest colour on the table. */
  colour?: Rgba;
  /** The table, in metres, to tell whether the change is on it. Without it every cue is drawn in place. */
  frame?: { width: number; height: number };
}

const WHITE: Rgba = [255, 255, 255, 1];
/** Below this size on the surface, in pixels, a line or area is cued like a point. */
const TINY_PX = 6;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** The points of a target. */
export function cuePoints(target: CueTarget): Point[] {
  return 'point' in target ? [target.point] : 'line' in target ? target.line : target.area;
}

/** The middle of a target's bounding box: where a point cue goes for a line or area too small to see. */
function middle(points: Point[]): Point {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/**
 * Where a change off the table should be pointed at: the nearest point on the table's edge,
 * and the direction out to the change. `null` when some of it is on the table.
 */
export function offTable(points: Point[], frame: { width: number; height: number }): { at: Point; towards: Point } | null {
  const inside = (p: Point) => p[0] >= 0 && p[0] <= frame.width && p[1] >= 0 && p[1] <= frame.height;
  if (points.length === 0 || points.some(inside)) return null;
  const [mx, my] = middle(points);
  const at: Point = [Math.min(frame.width, Math.max(0, mx)), Math.min(frame.height, Math.max(0, my))];
  const dx = mx - at[0];
  const dy = my - at[1];
  const length = Math.hypot(dx, dy) || 1;
  return { at, towards: [dx / length, dy / length] };
}

/** Draws the cue `age` seconds after it started. Returns false once it has finished (and draws nothing). */
export function drawCue(view: View, target: CueTarget, age: number, style: CueStyle = {}): boolean {
  if (age < 0) return true;
  if (age >= CUE_SECONDS) return false;
  const colour = style.colour ?? WHITE;
  const t = age / CUE_SECONDS;
  const points = cuePoints(target);
  if (points.length === 0) return false;
  const away = style.frame ? offTable(points, style.frame) : null;
  const pen = view.pen;
  pen.save();
  pen.globalCompositeOperation = 'lighter';
  if (away) arrow(view, away.at, away.towards, t, colour);
  else if ('point' in target || size(view, points) < TINY_PX) burst(view, 'point' in target ? target.point : middle(points), t, colour);
  else if ('line' in target) drawIn(view, points, t, colour);
  else outline(view, points, t, colour);
  pen.restore();
  return true;
}

function size(view: View, points: Point[]): number {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    const [x, y] = view.toPx(p);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return Math.max(x1 - x0, y1 - y0);
}

function flare(view: View, x: number, y: number, radius: number, colour: Rgba, strength: number): void {
  const pen = view.pen;
  const gradient = pen.createRadialGradient(x, y, 0, x, y, radius);
  // A white-hot core, whatever the colour: the cue is the brightest thing on the table.
  gradient.addColorStop(0, css(WHITE, strength));
  gradient.addColorStop(0.12, css(colour, strength));
  gradient.addColorStop(0.35, css(colour, strength * 0.55));
  gradient.addColorStop(1, css(colour, 0));
  pen.fillStyle = gradient;
  pen.beginPath();
  pen.arc(x, y, radius, 0, Math.PI * 2);
  pen.fill();
}

/** A point: a flare that shrinks onto the spot while three rings travel out and fade. */
function burst(view: View, at: Point, t: number, colour: Rgba): void {
  const [x, y] = view.toPx(at);
  const d = view.detail;
  // The flare is at its brightest at once and shrinks onto the item.
  flare(view, x, y, (70 - 46 * easeOut(t)) * d, colour, 1 - 0.7 * t);
  const pen = view.pen;
  for (let i = 0; i < 3; i++) {
    const ring = clamp01((t - i * 0.12) / 0.7);
    if (ring <= 0 || ring >= 1) continue;
    pen.strokeStyle = css(colour, (1 - ring) * 0.95);
    pen.lineWidth = (4 - ring * 2.5) * d;
    pen.beginPath();
    pen.arc(x, y, (14 + 130 * easeOut(ring)) * d, 0, Math.PI * 2);
    pen.stroke();
  }
}

function polyline(view: View, points: Point[], upTo: number, closed: boolean): Point | null {
  const pen = view.pen;
  const px = points.map((p) => view.toPx(p));
  const segments: number[] = [];
  let total = 0;
  for (let i = 1; i < px.length; i++) {
    const length = Math.hypot(px[i]![0] - px[i - 1]![0], px[i]![1] - px[i - 1]![1]);
    segments.push(length);
    total += length;
  }
  let left = total * clamp01(upTo);
  pen.beginPath();
  pen.moveTo(px[0]![0], px[0]![1]);
  let head: Point = [px[0]![0], px[0]![1]];
  for (let i = 1; i < px.length; i++) {
    const length = segments[i - 1]!;
    if (left >= length) {
      pen.lineTo(px[i]![0], px[i]![1]);
      head = [px[i]![0], px[i]![1]];
      left -= length;
      continue;
    }
    const k = length > 0 ? left / length : 0;
    head = [px[i - 1]![0] + (px[i]![0] - px[i - 1]![0]) * k, px[i - 1]![1] + (px[i]![1] - px[i - 1]![1]) * k];
    pen.lineTo(head[0], head[1]);
    return head;
  }
  if (closed) pen.closePath();
  return head;
}

/** A line: drawn in with a bright head, then a glow along it that fades. */
function drawIn(view: View, points: Point[], t: number, colour: Rgba): void {
  const pen = view.pen;
  const d = view.detail;
  const drawn = easeOut(clamp01(t / 0.55));
  const fade = 1 - clamp01((t - 0.55) / 0.45);
  pen.lineCap = 'round';
  pen.lineJoin = 'round';
  pen.strokeStyle = css(colour, 0.35 * fade);
  pen.lineWidth = 16 * d;
  polyline(view, points, drawn, false);
  pen.stroke();
  pen.strokeStyle = css(colour, 0.95 * fade);
  pen.lineWidth = 5 * d;
  const head = polyline(view, points, drawn, false);
  pen.stroke();
  if (head && drawn < 1) flare(view, head[0], head[1], 34 * d, colour, 1);
}

/** An area: its outline flashes once, wide and bright, with a light fill, then narrows and fades. */
function outline(view: View, points: Point[], t: number, colour: Rgba): void {
  const pen = view.pen;
  const d = view.detail;
  const pulse = Math.sin(Math.PI * clamp01(t / 0.5));
  const fade = 1 - clamp01((t - 0.35) / 0.65);
  pen.lineJoin = 'round';
  pen.fillStyle = css(colour, 0.28 * fade);
  polyline(view, points, 1, true);
  pen.fill();
  pen.strokeStyle = css(colour, 0.4 * fade);
  pen.lineWidth = (10 + 18 * pulse) * d;
  polyline(view, points, 1, true);
  pen.stroke();
  pen.strokeStyle = css(colour, fade);
  pen.lineWidth = 4 * d;
  polyline(view, points, 1, true);
  pen.stroke();
}

/** A change off the table: a chevron at the nearest edge that pushes out towards it, twice. */
function arrow(view: View, at: Point, towards: Point, t: number, colour: Rgba): void {
  const pen = view.pen;
  const d = view.detail;
  const [x, y] = view.toPx(at);
  const fade = 1 - clamp01((t - 0.6) / 0.4);
  flare(view, x, y, 60 * d, colour, 0.8 * fade);
  // The direction on the surface, which may be turned against table metres.
  const [ex, ey] = view.toPx([at[0] + towards[0], at[1] + towards[1]]);
  const length = Math.hypot(ex - x, ey - y) || 1;
  const [ux, uy] = [(ex - x) / length, (ey - y) / length];
  const push = Math.sin(Math.PI * 2 * clamp01(t / 0.7)) ** 2 * 10 * d;
  const tipX = x - ux * (14 * d) + ux * push;
  const tipY = y - uy * (14 * d) + uy * push;
  const back = 26 * d;
  const wide = 18 * d;
  pen.strokeStyle = css(colour, fade);
  pen.lineWidth = 6 * d;
  pen.lineCap = 'round';
  pen.lineJoin = 'round';
  pen.beginPath();
  pen.moveTo(tipX - ux * back - uy * wide, tipY - uy * back + ux * wide);
  pen.lineTo(tipX, tipY);
  pen.lineTo(tipX - ux * back + uy * wide, tipY - uy * back - ux * wide);
  pen.stroke();
}
