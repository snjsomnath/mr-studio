// Reveal shapes (#287, #288): the part of the table where a layer's items show. A layer that
// reveals (`reveals: true` in layer.json, the Magnifier and the Reveal line) sets one with
// `ctx.reveal.set(shape)`, and the runtime clips everything its items draw to it. The same
// shape answers "is this point inside" for pointers and draws as a clip on a canvas.

import type { Point } from './blocks/geo.ts';

/**
 * Where a revealing layer's items show, in table metres (x right, y down from the top left).
 * - `circle`: inside a circle, a magnifying glass; with `outside`, everywhere but the circle
 *   (the surface around an X-ray, #606).
 * - `side`: on one side of a straight line across the table, `before` the smaller coordinate
 *   (left of a vertical line, above a horizontal one) or `after` it.
 * - `none`: nowhere; the items are hidden.
 * `null` instead of a shape shows the items everywhere.
 */
export type RevealShape =
  | { kind: 'circle'; centre: Point; radius_m: number; outside?: boolean }
  | { kind: 'side'; axis: 'x' | 'y'; at_m: number; keep: 'before' | 'after' }
  | { kind: 'none' };

/** What a revealing layer's context offers: `ctx.reveal`. */
export interface LayerReveal {
  /** Shows the layer's items only inside `shape`; null shows them everywhere. Cheap to call every frame. */
  set(shape: RevealShape | null): void;
  /**
   * Gives one item, by its place among the layer's items (0 is the first), a shape of its own
   * instead of the layer's: the Reveal line's second map on the other side of the line (#349).
   * `undefined` hands the item back to the layer's shape.
   */
  item(index: number, shape: RevealShape | null | undefined): void;
}

/** The other side of a line; any other shape is returned as it is. */
export function otherSide(shape: RevealShape): RevealShape {
  return shape.kind === 'side' ? { ...shape, keep: shape.keep === 'before' ? 'after' : 'before' } : shape;
}

/**
 * Everywhere the shape is not (#606): stack 1 of a revealing layer, the surface, shows here while
 * stack 2 shows through the shape. Outside a glass, the other side of a line; everywhere for
 * nowhere, and nowhere for everywhere (`null`).
 */
export function revealComplement(shape: RevealShape | null): RevealShape | null {
  if (!shape) return { kind: 'none' };
  if (shape.kind === 'none') return null;
  if (shape.kind === 'circle') return { ...shape, outside: !shape.outside };
  return otherSide(shape);
}

/** Whether a point (table metres) is where the items show. */
export function revealContains(shape: RevealShape | null, point: Point): boolean {
  if (!shape) return true;
  if (shape.kind === 'none') return false;
  if (shape.kind === 'circle') return (Math.hypot(point[0] - shape.centre[0], point[1] - shape.centre[1]) <= shape.radius_m) !== Boolean(shape.outside);
  const v = shape.axis === 'x' ? point[0] : point[1];
  return shape.keep === 'before' ? v <= shape.at_m : v >= shape.at_m;
}

/**
 * The shape as a polygon in table metres, inside a table of `width` by `height` metres:
 * a circle as `segments` points, a side as the rectangle it keeps. Empty for `none`. Outside a
 * circle is one outline with a hole: far around the table, in to the circle by a seam and round
 * it the other way, so a non-zero fill (CSS `polygon()`) leaves the circle out.
 * The runtime projects it for the CSS clip of canvases and decorations.
 */
export function revealPolygon(shape: RevealShape, width: number, height: number, segments = 72): Point[] {
  if (shape.kind === 'none') return [];
  // A side reaches well past the table, so a calibrated view that shows a margin is clipped cleanly too.
  const far = 10 * Math.max(width, height);
  if (shape.kind === 'circle') {
    const [cx, cy] = shape.centre;
    const ring = Array.from({ length: segments }, (_, k) => {
      const a = (k / segments) * Math.PI * 2;
      return [cx + Math.cos(a) * shape.radius_m, cy + Math.sin(a) * shape.radius_m] as Point;
    });
    if (!shape.outside) return ring;
    // Clockwise round the far box (y down), then the circle anticlockwise, joined at its rightmost point.
    const start: Point = [width + far, cy];
    return [start, [width + far, height + far], [-far, height + far], [-far, -far], [width + far, -far], start, ring[0]!, ...ring.slice(1).reverse(), ring[0]!];
  }
  const at = shape.at_m;
  if (shape.axis === 'x') {
    return shape.keep === 'before'
      ? [[-far, -far], [at, -far], [at, height + far], [-far, height + far]]
      : [[at, -far], [width + far, -far], [width + far, height + far], [at, height + far]];
  }
  return shape.keep === 'before'
    ? [[-far, -far], [width + far, -far], [width + far, at], [-far, at]]
    : [[-far, at], [width + far, at], [width + far, height + far], [-far, height + far]];
}

/** Adds the shape to a canvas path in the context's own units (table metres on a drawing overlay). */
export function revealPath(pen: Pick<CanvasRenderingContext2D, 'beginPath' | 'arc' | 'moveTo' | 'lineTo' | 'closePath'>, shape: RevealShape, width: number, height: number): void {
  pen.beginPath();
  if (shape.kind === 'circle' && !shape.outside) {
    pen.arc(shape.centre[0], shape.centre[1], Math.max(0, shape.radius_m), 0, Math.PI * 2);
    return;
  }
  const polygon = revealPolygon(shape, width, height);
  polygon.forEach(([x, y], k) => (k === 0 ? pen.moveTo(x, y) : pen.lineTo(x, y)));
  pen.closePath();
}

/** The same shape, or two shapes that clip alike, so a caller can skip redrawing. */
export function sameReveal(a: RevealShape | null, b: RevealShape | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The shape as numbers for a shader: `kind` 0 everywhere, 1 circle (x, y, radius), 2 side
 * (axis 0 for x or 1 for y, at, +1 keeps after or -1 keeps before), 3 nowhere, 4 outside a
 * circle (x, y, radius). In metres.
 */
export function revealUniform(shape: RevealShape | null): { kind: number; values: [number, number, number] } {
  if (!shape) return { kind: 0, values: [0, 0, 0] };
  if (shape.kind === 'none') return { kind: 3, values: [0, 0, 0] };
  if (shape.kind === 'circle') return { kind: shape.outside ? 4 : 1, values: [shape.centre[0], shape.centre[1], shape.radius_m] };
  return { kind: 2, values: [shape.axis === 'x' ? 0 : 1, shape.at_m, shape.keep === 'after' ? 1 : -1] };
}
