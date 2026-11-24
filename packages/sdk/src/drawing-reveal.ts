// Drawing reveal (#286): the pieces of the Lindholmen artwork's opening, for any drawing.
//
//   line trace   the drawing's strokes come in batch by batch in a spatial rhythm, each traced
//                along its length with a warm glint, then settle to the drawing itself
//   colour turn  a timed cross-fade from the line drawing to a colour version, and back
//   phase grow   a part comes in inside a circle growing from a point
//   placement    a drawing stretched over the table, or placed by three corners on the map
//
// The plain parts (transforms, ordering, timing, placement) are tested in Node; `traceDrawing`
// and `drawTrace` need a browser (DOMParser, Path2D). The Masterplan layer puts them together.

/** A 2D affine transform as SVG and canvases write it: x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `m` applied after `n`: a point goes through `n` first. */
export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Affine, [x, y]: readonly [number, number]): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return IDENTITY;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** An SVG `transform` attribute as one matrix: matrix, translate, scale, rotate, skewX and skewY, in order. */
export function parseTransform(text: string | null | undefined): Affine {
  let m: Affine = IDENTITY;
  if (!text) return m;
  for (const [, name, args] of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = (args ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
    let t: Affine = IDENTITY;
    switch (name) {
      case 'matrix':
        if (v.length === 6) t = v as Affine;
        break;
      case 'translate':
        t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case 'scale':
        t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const r: Affine = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
        t = multiply(multiply([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    if (t.some((n) => !Number.isFinite(n))) continue;
    m = multiply(m, t);
  }
  return m;
}

/** The outline of an SVG shape element as path data, or null for a tag that has none. */
export function shapePath(tag: string, attr: (name: string) => string | null): string | null {
  const n = (name: string) => Number(attr(name) ?? 0) || 0;
  switch (tag.toLowerCase()) {
    case 'path':
      return attr('d');
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    case 'polyline':
    case 'polygon': {
      const v = (attr('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      if (v.length < 4) return null;
      let d = `M${v[0]} ${v[1]}`;
      for (let k = 2; k + 1 < v.length; k += 2) d += `L${v[k]} ${v[k + 1]}`;
      return tag.toLowerCase() === 'polygon' ? `${d}Z` : d;
    }
    case 'rect': {
      const [x, y, w, h] = [n('x'), n('y'), n('width'), n('height')];
      return w > 0 && h > 0 ? `M${x} ${y}h${w}v${h}h${-w}Z` : null;
    }
    case 'circle':
    case 'ellipse': {
      const [cx, cy] = [n('cx'), n('cy')];
      const rx = tag.toLowerCase() === 'circle' ? n('r') : n('rx');
      const ry = tag.toLowerCase() === 'circle' ? n('r') : n('ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;
    }
    default:
      return null;
  }
}

/**
 * Which batch of the trace a stroke starting at `(x, y)` belongs to, 0 first, in a drawing of
 * `width` by `height`. Batches spread out from the middle with a fixed grain, so neighbouring
 * strokes come in together and the drawing wakes from its heart outwards, the same on every table.
 */
export function traceBucket(x: number, y: number, width: number, height: number, buckets = 24): number {
  const reach = Math.hypot(width, height) / 2 || 1;
  const distance = Math.min(1, Math.hypot(x - width / 2, y - height / 2) / reach);
  const grain = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
  return Math.max(0, Math.min(buckets - 1, Math.floor((distance * 0.68 + grain * 0.32) * buckets)));
}

/** How far a batch is traced at overall progress `t` (0 to 1): batches start one after another and each takes the last 38%. */
export function batchProgress(t: number, bucket: number, buckets = 24): number {
  const start = (bucket / buckets) * 0.62;
  return Math.max(0, Math.min(1, (t - start) / 0.38));
}

export interface OpeningTiming {
  /** Seconds the drawing takes to come in. */
  in_s: number;
  /** Seconds it stays as lines before it turns, and how long the turn takes. Null never turns. */
  colour_after_s: number | null;
  colour_s: number;
}

/**
 * Where the opening is `t` seconds after the layer started: how far the drawing has come in, and
 * how far it has turned to colour, both 0 to 1 and eased.
 */
export function openingAt(t: number, timing: OpeningTiming): { drawn: number; colour: number } {
  const ease = (v: number) => {
    const c = Math.max(0, Math.min(1, v));
    return c * c * (3 - 2 * c);
  };
  const drawn = timing.in_s > 0 ? Math.max(0, Math.min(1, t / timing.in_s)) : 1;
  if (timing.colour_after_s === null) return { drawn, colour: 0 };
  const since = t - timing.in_s - timing.colour_after_s;
  return { drawn, colour: timing.colour_s > 0 ? ease(since / timing.colour_s) : since >= 0 ? 1 : 0 };
}

/**
 * Where a drawing lands on the table. Without corners it is stretched over the table; with them
 * it is placed by its top left, top right and bottom left corners, given in table metres (turn
 * WGS84 into metres with `tableFrame(site).toTable`). The result takes a drawing's unit square
 * (0 to 1 across and down) to table metres.
 */
export function placement(table: { width: number; height: number }, corners?: readonly [readonly [number, number], readonly [number, number], readonly [number, number]] | null): Affine {
  if (!corners) return [table.width, 0, 0, table.height, 0, 0];
  const [tl, tr, bl] = corners;
  return [tr[0] - tl[0], tr[1] - tl[1], bl[0] - tl[0], bl[1] - tl[1], tl[0], tl[1]];
}

/**
 * Reads "lon,lat; lon,lat; lon,lat" (top left, top right, bottom left of the drawing) from a
 * text param. Null when it is empty or not three points.
 */
export function parseCorners(text: string | null | undefined): [[number, number], [number, number], [number, number]] | null {
  if (!text?.trim()) return null;
  const points = text
    .split(/[;|]/)
    .map((p) => p.trim().split(/[\s,]+/).filter(Boolean).map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite));
  return points.length === 3 ? (points as [[number, number], [number, number], [number, number]]) : null;
}

/** The radius a part needs to be fully shown when it grows from `from`: to its bounds' farthest corner. */
export function growRadius(from: readonly [number, number], bounds: readonly [number, number, number, number]): number {
  const [x0, y0, x1, y1] = bounds;
  return Math.max(...[x0, x1].flatMap((x) => [y0, y1].map((y) => Math.hypot(x - from[0], y - from[1]))));
}

// ---- In the browser ----------------------------------------------------------

/** Strokes of one style that come in together. Paths are already in the target's units. */
export interface TraceBatch {
  path: Path2D;
  bucket: number;
  width: number;
  colour: string;
  alpha: number;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
}

export const NOT_DRAWN = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker', 'style', 'script', 'lineargradient', 'radialgradient', 'filter', 'metadata', 'title', 'desc']);

/** An inherited presentation attribute: the element's own, its style, or its nearest ancestor's. */
export function inherited(el: Element, name: string): string | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const own = n.getAttribute(name);
    if (own !== null) return own;
    const style = n.getAttribute('style')?.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`))?.[1];
    if (style) return style.trim();
  }
  return null;
}

/**
 * A drawing's stroked shapes as trace batches. `root` is the drawing's `<svg>`; `toTarget` takes
 * its viewBox units to the units the batches are drawn in (table metres on a drawing overlay).
 * Shapes without a stroke are left to the drawing's own picture, which the trace settles into.
 */
export function traceDrawing(root: Element, toTarget: Affine, buckets = 24): TraceBatch[] {
  const box = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const [vx, vy, vw, vh] = box.length === 4 && box.every(Number.isFinite) ? box : [0, 0, Number(root.getAttribute('width')) || 1, Number(root.getAttribute('height')) || 1];
  const base = multiply(toTarget, [1, 0, 0, 1, -(vx ?? 0), -(vy ?? 0)]);
  const unit = Math.sqrt(Math.abs(toTarget[0] * toTarget[3] - toTarget[1] * toTarget[2]));
  const batches = new Map<string, TraceBatch>();
  const walk = (el: Element, m: Affine) => {
    const tag = el.localName.toLowerCase();
    if (NOT_DRAWN.has(tag)) return;
    if (inherited(el, 'display') === 'none' || inherited(el, 'visibility') === 'hidden') return;
    const here = multiply(m, parseTransform(el.getAttribute('transform')));
    const d = shapePath(tag, (name) => el.getAttribute(name));
    if (d) {
      const colour = inherited(el, 'stroke');
      if (colour && colour !== 'none' && !colour.startsWith('url(')) {
        let path: Path2D;
        try {
          path = new Path2D(d);
        } catch {
          return;
        }
        // The stroke's width in viewBox units; times `unit` it is in the target's.
        const width = (parseFloat(inherited(el, 'stroke-width') ?? '') || 1) * Math.sqrt(Math.abs(here[0] * here[3] - here[1] * here[2]));
        const alpha = (Number(inherited(el, 'stroke-opacity') ?? 1) || 1) * (Number(inherited(el, 'opacity') ?? 1) || 1);
        const cap = (inherited(el, 'stroke-linecap') ?? 'butt') as CanvasLineCap;
        const join = (inherited(el, 'stroke-linejoin') ?? 'miter') as CanvasLineJoin;
        const first = d.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.slice(0, 2).map(Number) ?? [0, 0];
        const [px, py] = apply(here, [first[0] ?? 0, first[1] ?? 0]);
        const bucket = traceBucket(px - (vx ?? 0), py - (vy ?? 0), vw ?? 1, vh ?? 1, buckets);
        const key = [bucket, colour, width.toFixed(3), alpha.toFixed(2), cap, join].join('|');
        let batch = batches.get(key);
        if (!batch) batches.set(key, (batch = { path: new Path2D(), bucket, width: width * unit, colour, alpha, cap, join }));
        const t = multiply(base, here);
        batch.path.addPath(path, new DOMMatrix(t));
      }
    }
    for (const child of el.children) walk(child, here);
  };
  walk(root, IDENTITY);
  return [...batches.values()].sort((a, b) => a.bucket - b.bucket);
}

export interface TraceStyle {
  /** The length of one dash of the trace, in the target's units: about a tenth of the drawing's diagonal. */
  dash: number;
  /** Thinnest line drawn, in the target's units, so hair lines still show on a projector. */
  minWidth: number;
  /** The glint a stroke flashes as it is traced. Default warm white. */
  glint?: string;
  buckets?: number;
}

/**
 * Draws the trace at progress `t` (0 to 1): each batch traced along its length as its turn comes,
 * flashing a warm glint at the height of it. The strokes keep their own colour once traced.
 */
export function drawTrace(g: CanvasRenderingContext2D, batches: readonly TraceBatch[], t: number, style: TraceStyle): void {
  const buckets = style.buckets ?? 24;
  g.save();
  for (const batch of batches) {
    const p = batchProgress(t, batch.bucket, buckets);
    if (p <= 0) continue;
    const ink = p * p * (3 - 2 * p);
    const flash = Math.sin(p * Math.PI);
    g.lineCap = batch.cap;
    g.lineJoin = batch.join;
    const width = Math.max(style.minWidth, batch.width);
    g.setLineDash(p < 1 ? [Math.max(style.dash * 0.002, ink * style.dash), style.dash * (1 - ink)] : []);
    g.lineDashOffset = (-style.dash * (1 - ink)) / 7;
    if (flash > 0.7) {
      g.globalAlpha = flash * 0.22;
      g.strokeStyle = style.glint ?? '#fff0d3';
      g.lineWidth = width + style.minWidth * 3;
      g.stroke(batch.path);
    }
    g.globalAlpha = ink * batch.alpha;
    g.strokeStyle = flash > 0.45 ? (style.glint ?? '#fff0d3') : batch.colour;
    g.lineWidth = width;
    g.stroke(batch.path);
  }
  g.restore();
}

export interface StagedWeights {
  /** What the overview (before the first Next) shows: every part, or none of them. */
  overview: 'all' | 'none';
  /** How strongly the parts before the newest one show. 1 keeps them (a masterplan), lower dims them (viewpoints). */
  earlier: number;
  /** How faintly the parts still to come show, so the whole can be read ahead. 0 hides them. */
  later: number;
  /** Whether a last step shows every part together, and how strongly. */
  finale: number | null;
}

/**
 * How strongly part `k` (0 first) of `count` shows when `revealed` steps are revealed: 0 is the
 * overview, 1 to `count` bring the parts in one by one, and `count + 1` is the finale when there is one.
 */
export function stagedWeight(k: number, revealed: number, count: number, weights: StagedWeights): number {
  if (revealed <= 0) return weights.overview === 'all' ? 1 : 0;
  if (revealed > count) return weights.finale ?? 1;
  if (k === revealed - 1) return 1;
  return k < revealed - 1 ? weights.earlier : weights.later;
}
