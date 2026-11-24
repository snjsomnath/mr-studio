// Drawings that animate by role (#300): a plan drawn in a standard way, its parts named by what
// they are, comes to life without code of its own. The roles and their motions are those of the
// Chalmers demo's Campus Vision:
//
//   boundary  traced once, then marching dashes with a slow glow
//   axis      grows from its middle out to both ends, then glows
//   route     drawn along its length, one after another, then a pulsing glow
//   arrow     appears as its route ends, then pulses
//   point     pops in with a bounce, one after another, then pulses
//   node      its rays grow out from its middle (a star, an asterisk), then glow
//   area      grows from its own middle, then breathes
//   label     fades in
//   shape     anything else in a phase: fades in with it
//
// A part's role is its `data-role`, else read from its name: an Inkscape or Illustrator layer
// name, a <title> inside it, or its id ("01_Primary Path", "Markers", "Gröna mötesplatser").
// A part inherits the role of the group it is in. `roleFrame` is plain numbers and tested in
// Node; `rolePieces` and `drawRolePiece` need a browser (Path2D).
import { IDENTITY, NOT_DRAWN, apply, inherited, multiply, parseTransform, shapePath } from './drawing-reveal.ts';
import type { Affine } from './drawing-reveal.ts';

export type DrawingRole = 'boundary' | 'axis' | 'route' | 'arrow' | 'point' | 'node' | 'area' | 'label' | 'shape';

export const DRAWING_ROLES: readonly DrawingRole[] = ['boundary', 'axis', 'route', 'arrow', 'point', 'node', 'area', 'label', 'shape'];

/** Words that name each role, English and Swedish, matched as whole words. Order matters: the first match wins. */
const ROLE_WORDS: [DrawingRole, RegExp][] = [
  ['arrow', /\b(arrows?|pil(ar)?|arrowheads?)\b/],
  ['boundary', /(\bboundar(y|ies)\b|gräns|\bsite limit\b|\bproject area\b|\bplan area\b|\bborder\b)/],
  ['axis', /\b(axis|axes|axel|axlar|spine|main street|huvudstråk)\b/],
  ['node', /\b(asterix|asterisks?|nodes?|noder|hubs?|stars?|activity nodes?)\b/],
  ['point', /\b(points?|markers?|punkt(er)?|pins?|dots?|places?|platser?)\b/],
  ['area', /\b(areas?|blobs?|green( spaces?)?|spaces?|parks?|yt(a|or)|gröna?|mötesplatser|zones?|squares?|torg)\b/],
  ['route', /\b(paths?|routes?|streets?|stråk|roads?|vägar?|links?|connections?|lines?|cycle ?ways?|footways?)\b/],
  ['label', /\b(labels?|texts?|etiketter?|names?|titles?)\b/],
];

/** The role a name says, or null. Leading numbers ("01_", "2 -") and punctuation are ignored. */
export function roleOfName(name: string | null | undefined): DrawingRole | null {
  if (!name) return null;
  const words = name
    .toLowerCase()
    .replace(/^[\s\d._:-]+/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!words) return null;
  if ((DRAWING_ROLES as readonly string[]).includes(words)) return words as DrawingRole;
  for (const [role, pattern] of ROLE_WORDS) if (pattern.test(words)) return role;
  return null;
}

/** The order a phase's name gives ("01_PROJECT BOUNDARY" is 1), or null. */
export function phaseNumber(name: string | null | undefined): number | null {
  const m = (name ?? '').trim().match(/^(\d+)\s*[._:)-]?\s*/);
  return m ? Number(m[1]) : null;
}

/** A phase's name as people read it: "01_PROJECT BOUNDARY:" becomes "Project boundary". */
export function phaseTitle(name: string): string {
  let text = name
    .trim()
    .replace(/^\d+\s*[._:)-]?\s*/, '')
    .replace(/[_]+/g, ' ')
    .replace(/[:\s]+$/, '')
    .trim();
  if (text && text === text.toUpperCase() && /[A-ZÅÄÖ]/.test(text)) text = text.charAt(0) + text.slice(1).toLowerCase().replace(/-/g, ' ');
  return text || name;
}

/** How a part looks at one moment of its motion. */
export interface RoleFrame {
  /** How much of its outline is drawn, 0 to 1. */
  draw: number;
  /** Where the drawn part starts: 'start' along the path, or 'middle' growing out both ways. */
  from: 'start' | 'middle';
  /** Scale about the part's middle. */
  scale: number;
  /** Opacity, times the part's own. */
  alpha: number;
  /** Glow, 0 none to 1 strong. */
  glow: number;
  /** Marching dashes: seconds they have been marching, or null for a solid line. */
  march: number | null;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => {
  const t = clamp(v);
  return t * t * (3 - 2 * t);
};
/** Overshoots a little before settling: a pop. */
const backOut = (v: number) => {
  const t = clamp(v);
  const s = 1.70158;
  return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
};
/** Where a part's turn starts in its phase: parts come one after another over `spread` of it. */
const startOf = (index: number, count: number, spread: number) => (count > 1 ? (index / (count - 1)) * spread : 0);
/** How far one part's own turn has come: it starts at its place in the spread and takes the rest of the phase. */
const turnOf = (p: number, index: number, count: number, spread: number) => clamp((p - startOf(index, count, spread)) / (1 - spread));

/**
 * A part's motion: `p` is how far its phase has come in (0 to 1), `time` seconds since the layer
 * started (for the steady motion after), `index` and `count` its place among the parts of the same
 * role in its phase. Shared by the table and anything that previews a drawing.
 */
export function roleFrame(role: DrawingRole, p: number, time: number, index = 0, count = 1): RoleFrame {
  const wave = (speed: number, offset = 0) => 0.5 + 0.5 * Math.sin(time * speed + offset);
  switch (role) {
    case 'boundary': {
      const draw = smooth(p * 1.2);
      return { draw, from: 'start', scale: 1, alpha: 1, glow: draw * (0.45 + 0.55 * wave(2.5)), march: draw >= 1 ? time : null };
    }
    case 'axis': {
      const draw = smooth(turnOf(p, index, count, 0.3));
      return { draw, from: 'middle', scale: 1, alpha: 1, glow: draw * (0.5 + 0.5 * wave(2, index)), march: null };
    }
    case 'route': {
      const draw = smooth(turnOf(p, index, count, 0.45));
      return { draw, from: 'start', scale: 1, alpha: 1, glow: draw * (0.35 + 0.45 * wave(2.5, index * 0.3)), march: null };
    }
    case 'arrow': {
      const alpha = smooth((p - 0.7) / 0.3);
      return { draw: 1, from: 'start', scale: 0.6 + 0.4 * alpha, alpha, glow: alpha * (0.5 + 0.5 * wave(3)), march: null };
    }
    case 'point': {
      const local = turnOf(p, index, count, 0.6);
      const pulse = local >= 1 ? 1 + 0.08 * Math.sin(time * 3 + index * 0.5) : 1;
      return { draw: 1, from: 'start', scale: backOut(local) * pulse, alpha: clamp(local * 3), glow: local * (0.4 + 0.6 * wave(3, index * 0.5)), march: null };
    }
    case 'node': {
      const local = turnOf(p, index, count, 0.55);
      return { draw: 1, from: 'start', scale: smooth(local), alpha: clamp(local * 2), glow: local * (0.5 + 0.5 * wave(2.5, index)), march: null };
    }
    case 'area': {
      const local = smooth(turnOf(p, index, count, 0.5));
      const breathe = wave(0.6, index * 0.5);
      return { draw: 1, from: 'start', scale: local * (1 + 0.05 * breathe), alpha: local * (0.85 + 0.15 * breathe), glow: local * (0.3 + 0.5 * breathe), march: null };
    }
    case 'label':
    case 'shape':
    default:
      return { draw: 1, from: 'start', scale: 1, alpha: smooth(p * 1.5), glow: 0, march: null };
  }
}

/** Whether a role keeps moving after its phase is in, so the table must keep drawing it. */
export function roleMoves(role: DrawingRole): boolean {
  return role !== 'label' && role !== 'shape';
}

/** One part of a drawing to animate: a shape, or for a node the shapes of the whole node. */
export interface RolePiece {
  role: DrawingRole;
  path: Path2D;
  /** Fill and stroke colours, or null. */
  fill: string | null;
  stroke: string | null;
  /** Stroke width and dashes in the target's units. */
  width: number;
  dash: number[] | null;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
  alpha: number;
  /** Its middle and its length (for a stroke), in the target's units. */
  centre: [number, number];
  length: number;
  /** Its place among the pieces of its role in its group of pieces, and how many there are. */
  index: number;
  count: number;
}

/** The name a drawing element goes by: its role, its layer name, its own <title> or its id. */
export function elementName(el: Element): string | null {
  const own = el.getAttribute('data-role') ?? el.getAttribute('inkscape:label') ?? el.getAttribute('data-name') ?? el.getAttribute('data-mrs-name');
  if (own) return own;
  for (const child of el.children) if (child.localName.toLowerCase() === 'title') return child.textContent?.trim() || null;
  return el.getAttribute('id');
}

/** Whether any part of a drawing names a role, so it animates by role. */
export function hasRoles(root: Element): boolean {
  const walk = (el: Element): boolean => {
    if (NOT_DRAWN.has(el.localName.toLowerCase())) return false;
    if (el !== root && roleOfName(elementName(el)) !== null) return true;
    for (const child of el.children) if (walk(child)) return true;
    return false;
  };
  return walk(root);
}

/** A hidden SVG on the page for measuring path data, made when first needed. */
let ruler: SVGPathElement | null = null;

/** The length and box of path data in its own units: measured on the page, else roughly from its numbers. */
function measurePath(d: string): { length: number; box: [number, number, number, number] | null } {
  if (typeof document !== 'undefined') {
    try {
      if (!ruler || !ruler.isConnected) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
        ruler = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        svg.append(ruler);
        document.documentElement.append(svg);
      }
      ruler.setAttribute('d', d);
      const length = ruler.getTotalLength();
      const b = ruler.getBBox();
      if (Number.isFinite(length)) return { length, box: [b.x, b.y, b.x + b.width, b.y + b.height] };
    } catch {
      // Measured below.
    }
  }
  const n = d.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  let length = 0;
  for (let k = 2; k + 1 < n.length; k += 2) length += Math.hypot((n[k] ?? 0) - (n[k - 2] ?? 0), (n[k + 1] ?? 0) - (n[k - 1] ?? 0));
  return { length, box: null };
}

/**
 * The pieces of `group` (a phase), with their roles. `toTarget` takes the drawing's viewBox
 * units (already offset by its origin) to the units drawn in, as for `traceDrawing`. Shapes
 * outside any named role become `fallback`.
 */
export function rolePieces(group: Element, toTarget: Affine, fallback: DrawingRole = 'shape'): RolePiece[] {
  // The transforms of the groups around this one, up to the drawing itself.
  let start: Affine = IDENTITY;
  for (let n = group.parentElement; n && n.localName.toLowerCase() !== 'svg'; n = n.parentElement) start = multiply(parseTransform(n.getAttribute('transform')), start);
  const pieces: RolePiece[] = [];
  const scaleOf = (m: Affine) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  /** A node gathers its shapes into one piece. */
  let node: { path: Path2D; points: [number, number][]; first: RolePiece | null } | null = null;

  const walk = (el: Element, m: Affine, role: DrawingRole) => {
    const tag = el.localName.toLowerCase();
    if (NOT_DRAWN.has(tag)) return;
    if (inherited(el, 'display') === 'none' || inherited(el, 'visibility') === 'hidden') return;
    const here = multiply(m, parseTransform(el.getAttribute('transform')));
    const named = el === group ? null : roleOfName(elementName(el));
    const mine = named ?? role;
    // A node starts here: everything inside it grows together from its middle.
    const opensNode = named === 'node' && el.children.length > 0 && !shapePath(tag, (n) => el.getAttribute(n));
    const outer = node;
    if (opensNode) node = { path: new Path2D(), points: [], first: null };

    const d = shapePath(tag, (name) => el.getAttribute(name));
    if (d) {
      let shape: Path2D | null = null;
      try {
        shape = new Path2D(d);
      } catch {
        shape = null;
      }
      if (shape) {
        const t = multiply(toTarget, here);
        const placed = new Path2D();
        placed.addPath(shape, new DOMMatrix(t));
        const measured = measurePath(d);
        const points: [number, number][] = [];
        if (measured.box) {
          const [x0, y0, x1, y1] = measured.box;
          for (const corner of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as [number, number][]) points.push(apply(t, corner));
        } else {
          // Without a page to measure on, the path's numbers give a rough middle.
          const nums = d.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
          for (let k = 0; k + 1 < Math.min(nums.length, 400); k += 2) points.push(apply(t, [nums[k]!, nums[k + 1]!]));
        }
        const fill = inherited(el, 'fill');
        const stroke = inherited(el, 'stroke');
        const dashText = inherited(el, 'stroke-dasharray');
        const unit = scaleOf(t);
        const dash = dashText && dashText !== 'none' ? dashText.split(/[\s,]+/).map((v) => parseFloat(v) * unit).filter((v) => Number.isFinite(v) && v >= 0) : null;
        const piece: RolePiece = {
          role: mine,
          path: placed,
          fill: fill === null ? (tag === 'line' ? null : '#000') : fill !== 'none' && !fill.startsWith('url(') ? fill : null,
          stroke: stroke && stroke !== 'none' && !stroke.startsWith('url(') ? stroke : null,
          width: (parseFloat(inherited(el, 'stroke-width') ?? '') || 1) * unit,
          dash: dash && dash.length ? dash : null,
          cap: (inherited(el, 'stroke-linecap') ?? 'butt') as CanvasLineCap,
          join: (inherited(el, 'stroke-linejoin') ?? 'miter') as CanvasLineJoin,
          alpha: (Number(inherited(el, 'opacity') ?? 1) || 1) * (Number((fill && fill !== 'none' ? inherited(el, 'fill-opacity') : inherited(el, 'stroke-opacity')) ?? 1) || 1),
          centre: middleOf(points),
          length: measured.length * unit,
          index: 0,
          count: 1,
        };
        if (node) {
          node.path.addPath(placed);
          node.points.push(...points);
          if (!node.first) node.first = piece;
        } else pieces.push(piece);
      }
    }
    for (const child of el.children) walk(child, here, mine);

    if (opensNode && node) {
      if (node.first) pieces.push({ ...node.first, role: 'node', path: node.path, centre: middleOf(node.points) });
      node = outer;
    }
  };
  walk(group, start, fallback);

  // Number the pieces of each role, so they come in one after another.
  const counts = new Map<DrawingRole, number>();
  for (const piece of pieces) {
    piece.index = counts.get(piece.role) ?? 0;
    counts.set(piece.role, piece.index + 1);
  }
  for (const piece of pieces) piece.count = counts.get(piece.role) ?? 1;
  return pieces;
}

function middleOf(points: [number, number][]): [number, number] {
  if (!points.length) return [0, 0];
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

export interface RoleDrawStyle {
  /** How strongly the phase shows (an earlier phase dimmed, a later one faint). */
  weight: number;
  /** Device pixels of glow at full strength. */
  glowPx: number;
  /** Thinnest line, in the target's units. */
  minWidth: number;
  /** Length of a marching dash and its gap, in the target's units. */
  dash: [number, number];
}

/** Draws one piece at one frame of its motion. */
export function drawRolePiece(g: CanvasRenderingContext2D, piece: RolePiece, frame: RoleFrame, style: RoleDrawStyle): void {
  const alpha = frame.alpha * piece.alpha * style.weight;
  if (alpha <= 0.002 || frame.scale <= 0.001 || frame.draw <= 0) return;
  g.save();
  if (frame.scale !== 1) {
    const [cx, cy] = piece.centre;
    g.translate(cx, cy);
    g.scale(frame.scale, frame.scale);
    g.translate(-cx, -cy);
  }
  g.globalAlpha = alpha;
  g.lineCap = piece.cap;
  g.lineJoin = piece.join;
  const glowColour = piece.stroke ?? piece.fill ?? '#ffffff';
  if (frame.glow > 0 && style.glowPx > 0) {
    g.shadowColor = glowColour;
    g.shadowBlur = frame.glow * style.glowPx;
  }
  if (piece.fill) {
    g.fillStyle = piece.fill;
    g.fill(piece.path);
  }
  if (piece.stroke) {
    g.strokeStyle = piece.stroke;
    // A boundary is drawn bold enough to read across the table, as the demo did.
    g.lineWidth = piece.role === 'boundary' ? Math.max(style.minWidth * 3, piece.width * 2) : Math.max(style.minWidth, piece.width);
    const length = Math.max(piece.length, 1e-6);
    if (frame.draw < 1) {
      // Drawn along its length: from its start, or out from its middle both ways.
      const shown = length * frame.draw;
      g.setLineDash([shown, length * 2]);
      g.lineDashOffset = frame.from === 'middle' ? -(length - shown) / 2 : 0;
    } else if (frame.march !== null) {
      // The dashes march a little more than one dash and gap a second.
      const period = style.dash[0] + style.dash[1];
      g.setLineDash(style.dash);
      g.lineDashOffset = -((frame.march * period * 1.4) % period);
    } else {
      g.setLineDash(piece.dash ?? []);
    }
    g.stroke(piece.path);
  }
  g.restore();
}
