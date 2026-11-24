// Place motions (#161, #162, #163): twenty-two ways to animate places on the table, from
// the Place Motions preview Sanjay approved. All are 2D, top-down and text-free; sizes are
// in table millimetres. They read the place data standard (places.ts, #160).
//
// Each motion is written in "design units" (du): one du is 1.25 table mm, which makes a
// motion look the same as in the preview on a table about two metres wide. Places, streets
// and buildings are turned into du once, and du become pixels only when drawn.

import { css } from './blocks/scale.ts';
import type { Rgba } from './blocks/scale.ts';
import { seeded } from './blocks/motion.ts';
import type { Pen, View } from './blocks/view.ts';
import type { PlaceData, PlaceDataKind } from './places.ts';
import { rampColour } from './palette.ts';
import type { ResolvedPalette } from './palette.ts';

/** One style knob of a motion, shown as a slider in the builder's Motion tab. */
export interface PlaceKnob {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
}

export type PlaceMotionGroup = 'Place motions' | 'Circular waves' | 'Cultural gravity';

export interface PlaceMotionDef {
  id: string;
  group: PlaceMotionGroup;
  label: string;
  about: string;
  /** The data setup the ? panel shows. */
  data: PlaceDataKind;
  columns: string[];
  /** A note for the ? panel. */
  extra?: string;
  /** Site datasets the motion needs besides the places. */
  uses?: ('streets' | 'buildings')[];
  knobs: PlaceKnob[];
  create(env: PlaceEnv): { draw(view: View, time: number, alpha: number): void };
}

export interface PlaceEnv {
  data: PlaceData;
  /** Knob values over their defaults, plus the shared `speed`, `glow` and `scale`. */
  props: Record<string, number>;
  /** Metres per design unit (1.25 table mm). */
  u: number;
  palette: ResolvedPalette;
  /**
   * Where Next is, when the motion steps (#341): 0 before the first Next (nothing yet), 1 while
   * the places appear one by one, 2 once the motion runs. `since` is the draw time it got there.
   * Without it the motion simply runs.
   */
  stage?: () => PlaceStage;
}

export interface PlaceStage {
  revealed: number;
  since: number;
}

/** The sub-steps of a place motion that steps (#341), for the controller's strip. */
export function placeStepTitles(motion: string): string[] {
  return ['The places', placeMotion(motion)?.label ?? 'The motion'];
}

/** Seconds between one place appearing and the next, and how long the motion takes to fade in. */
export const ARRIVAL_S = 0.6;
const MOTION_IN_S = 1.5;

/** Knobs every place motion has. */
export const SHARED_KNOBS: PlaceKnob[] = [
  { key: 'speed', label: 'Speed', min: 0.2, max: 2.5, step: 0.05, value: 1, unit: '×' },
  { key: 'glow', label: 'Glow', min: 0, max: 2, step: 0.05, value: 1 },
  { key: 'scale', label: 'Scale', min: 0.25, max: 4, step: 0.05, value: 1, unit: '×' },
];

// ---- Fitting a motion to the table (#341) ------------------------------------------
//
// The motions were drawn for the preview district: seven places about 330 du apart. On a real
// table the places can be far closer together (the twelve KultVis places on the 1 m Lindholmen
// table are about 75 du apart), so pull, reach and brightness tuned for the preview flood the
// map, and walkers the size of a preview's look like blobs. A motion is therefore drawn in its
// own units scaled to the places' spacing: everything that is a distance on the map (reach,
// pull, how far a pulse travels) follows the spacing, while marks (dots, line widths, glows)
// shrink only by its square root, and never below about half, so they stay visible.

/** How far apart the preview's places are, in du (see `placeSpacing`). */
export const PREVIEW_SPACING_DU = 326;
const FIT_MIN = 0.12;
const FIT_MAX = 3;

/** How a motion's units land on this table. */
export interface Fit {
  /** Metres per du for distances on the map. */
  u: number;
  /** Metres per du for the size of marks. */
  mark: number;
  /** The scale over the preview: `u` over the table's own du. */
  scale: number;
}

/**
 * A typical distance between places, in the units of `points`: the geometric mean of the median
 * nearest neighbour (how close places sit) and the spread (the side of the share of the places'
 * bounding box each one has). NaN for fewer than two places.
 */
export function placeSpacing(points: readonly (readonly [number, number])[]): number {
  if (points.length < 2) return Number.NaN;
  const nearest = points.map((a, i) => Math.min(...points.map((b, j) => (i === j ? Infinity : Math.hypot(a[0] - b[0], a[1] - b[1]))))).sort((a, b) => a - b);
  const n = nearest.length;
  const median = n % 2 ? nearest[(n - 1) / 2]! : (nearest[n / 2 - 1]! + nearest[n / 2]!) / 2;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  // Places in a line have no area: their spread is along the line.
  const spread = w * h > 0 ? Math.sqrt((w * h) / n) : Math.max(w, h) / n;
  return median > 0 ? Math.sqrt(median * Math.max(spread, median)) : spread;
}

/** The fit of the places in `data` on a table of `u` metres per du, times the author's `scale`. */
export function placeFit(data: Pick<PlaceData, 'places'>, u: number, scale = 1): Fit {
  const spacing = placeSpacing(data.places.map((p) => p.point)) / u;
  const auto = Number.isFinite(spacing) && spacing > 0 ? clamp(spacing / PREVIEW_SPACING_DU, FIT_MIN, FIT_MAX) : 1;
  const s = clamp(auto * (Number.isFinite(scale) && scale > 0 ? scale : 1), FIT_MIN / 2, FIT_MAX * 2);
  return { u: u * s, mark: u * clamp(Math.sqrt(s), 0.45, 1.3), scale: s };
}

const WHITE: Rgba = [255, 255, 255, 1];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (x: number) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const easeIO = (x: number) => {
  x = clamp(x, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const TAU = Math.PI * 2;

// ---- Drawing in design units -------------------------------------------------------

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A canvas to draw into off screen, or null where there is none (tests). */
export function makeCanvas(w: number, h: number): Canvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return null;
}

const sprites = new Map<string, Canvas | null>();
function sprite(c: Rgba): Canvas | null {
  const key = `${c[0]},${c[1]},${c[2]}`;
  if (!sprites.has(key)) {
    const s = makeCanvas(64, 64);
    const g = s?.getContext('2d') as Ctx2D | null | undefined;
    if (s && g) {
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, css(c, 1));
      gr.addColorStop(0.25, css(c, 0.45));
      gr.addColorStop(1, css(c, 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
    }
    sprites.set(key, s && g ? s : null);
  }
  return sprites.get(key)!;
}

/** Pixels for one frame, with the preview's helpers: everything in du. */
class Painter {
  readonly pen: Pen;
  readonly s: number;
  /** Pixels per du of a mark (a dot, a line's width, a glow). */
  readonly ms: number;
  readonly view: View;
  readonly u: number;
  readonly glowLevel: number;
  constructor(view: View, fit: Fit, glowLevel: number) {
    this.view = view;
    this.u = fit.u;
    this.glowLevel = glowLevel;
    this.pen = view.pen;
    this.s = fit.u * view.scale;
    this.ms = fit.mark * view.scale;
  }
  x(xd: number, yd: number): [number, number] {
    return this.view.toPx([xd * this.u, yd * this.u]);
  }
  /** du to pixels, for distances on the map: reach, radius, how far something travels. */
  l(d: number): number {
    return d * this.s;
  }
  /** du to pixels, for the size of a mark: a dot, a line's width, a glow. */
  m(d: number): number {
    return d * this.ms;
  }
  glow(xd: number, yd: number, rd: number, c: Rgba, a: number): void {
    const r = this.m(rd);
    if (r <= 0.5 || a <= 0) return;
    const [x, y] = this.x(xd, yd);
    const level = Math.min(1, a * this.glowLevel);
    const s = sprite(c);
    const pen = this.pen;
    if (s) {
      const keep = pen.globalAlpha;
      pen.globalAlpha = keep * level;
      pen.drawImage(s as CanvasImageSource, x - r, y - r, 2 * r, 2 * r);
      pen.globalAlpha = keep;
      return;
    }
    const gr = pen.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, css(c, level));
    gr.addColorStop(1, css(c, 0));
    pen.fillStyle = gr;
    pen.beginPath();
    pen.arc(x, y, r, 0, TAU);
    pen.fill();
  }
  dot(xd: number, yd: number, rd: number, c: Rgba, a = 1): void {
    const [x, y] = this.x(xd, yd);
    this.pen.fillStyle = css(c, a);
    this.pen.beginPath();
    this.pen.arc(x, y, Math.max(0.6, this.m(rd)), 0, TAU);
    this.pen.fill();
  }
  ring(xd: number, yd: number, rd: number, c: Rgba, a: number, widthD: number): void {
    const [x, y] = this.x(xd, yd);
    this.pen.strokeStyle = css(c, a);
    this.pen.lineWidth = Math.max(0.6, this.m(widthD));
    this.pen.beginPath();
    this.pen.arc(x, y, Math.max(0.1, this.l(rd)), 0, TAU);
    this.pen.stroke();
  }
  line(ax: number, ay: number, bx: number, by: number, c: Rgba, a: number, widthD: number): void {
    const [x0, y0] = this.x(ax, ay);
    const [x1, y1] = this.x(bx, by);
    this.pen.strokeStyle = css(c, a);
    this.pen.lineWidth = Math.max(0.6, this.m(widthD));
    this.pen.beginPath();
    this.pen.moveTo(x0, y0);
    this.pen.lineTo(x1, y1);
    this.pen.stroke();
  }
  /** Fills a footprint (rings in du), each point moved by `move` first. */
  footprint(rings: [number, number][][], fill: string, move?: (x: number, y: number) => [number, number]): void {
    const pen = this.pen;
    pen.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y], i) => {
        const [px, py] = move ? this.x(...move(x, y)) : this.x(x, y);
        if (i === 0) pen.moveTo(px, py);
        else pen.lineTo(px, py);
      });
      pen.closePath();
    }
    pen.fillStyle = fill;
    pen.fill();
  }
  /** Draws an off-screen raster over the whole table. */
  raster(canvas: Canvas, W: number, H: number): void {
    const [x0, y0] = this.x(0, 0);
    const [x1, y1] = this.x(W, H);
    this.pen.imageSmoothingEnabled = true;
    this.pen.drawImage(canvas as CanvasImageSource, x0, y0, x1 - x0, y1 - y0);
  }
}

/** The places and site in design units, shared by every motion of one setup. */
interface Scene {
  W: number;
  H: number;
  places: { x: number; y: number; w: number; c: Rgba }[];
  nodes: { x: number; y: number }[];
  edges: [number, number, number][];
  adj: [number, number][][];
  placeNode: number[];
  /** Street distance (du) from each place to every node. */
  pdist: Float64Array[];
  buildings: [number, number, number, number][];
  /** Each building's footprint rings, in du, matching `buildings`. */
  footprints: [number, number][][][];
  targets: { x: number; y: number }[];
}

const scenes = new WeakMap<PlaceData, Map<number, Scene>>();
function sceneOf(data: PlaceData, u: number): Scene {
  let byU = scenes.get(data);
  if (!byU) scenes.set(data, (byU = new Map()));
  const hit = byU.get(u);
  if (hit) return hit;
  const places = data.places.map((p) => ({ x: p.point[0] / u, y: p.point[1] / u, w: p.weight, c: p.colour }));
  const net = data.streets;
  const nodes = net ? net.nodes.map(([x, y]) => ({ x: x / u, y: y / u })) : [];
  const edges: [number, number, number][] = net ? net.links().map(([a, b, l]) => [a, b, l / u]) : [];
  const adj: [number, number][][] = nodes.map(() => []);
  for (const [a, b, l] of edges) {
    adj[a]!.push([b, l]);
    adj[b]!.push([a, l]);
  }
  const placeNode = net ? data.places.map((p) => net.nearest(p.point)) : [];
  const pdist = net ? data.places.map((p) => Float64Array.from(net.treeTo(p.point).cost, (c) => c / u)) : [];
  const scene: Scene = {
    W: data.frame.width / u,
    H: data.frame.height / u,
    places,
    nodes,
    edges,
    adj,
    placeNode,
    pdist,
    buildings: data.buildings.map((b) => [b.point[0] / u, b.point[1] / u, b.w / u, b.h / u]),
    targets: data.targets.map(([x, y]) => ({ x: x / u, y: y / u })),
    footprints: data.buildings.map((b) => b.outline.map((ring) => ring.map(([x, y]) => [x / u, y / u] as [number, number]))),
  };
  byU.set(u, scene);
  return scene;
}

/** Common setup: the scene, the props with defaults, and a painter per frame. */
function setup(def: Pick<PlaceMotionDef, 'knobs'>, env: PlaceEnv) {
  const k: Record<string, number> = {};
  for (const knob of [...SHARED_KNOBS, ...def.knobs]) k[knob.key] = Number.isFinite(env.props[knob.key]) ? env.props[knob.key]! : knob.value;
  const fit = placeFit(env.data, env.u, k.scale);
  const scene = sceneOf(env.data, fit.u);
  const frame = (view: View, time: number, alpha: number, body: (p: Painter, t: number) => void) => {
    if (scene.places.length === 0) return;
    const p = new Painter(view, fit, k.glow!);
    const pen = view.pen;
    const stage = env.stage?.();
    pen.save();
    pen.globalAlpha = alpha;
    // Light adds up, as on the preview's dark ground.
    pen.globalCompositeOperation = 'lighter';
    pen.lineCap = 'round';
    pen.lineJoin = 'round';
    if (stage && stage.revealed < 2) {
      // Stepping (#341): nothing before the first Next, then the places one by one.
      if (stage.revealed === 1) arrivals(p, scene, time - stage.since);
    } else {
      if (stage) {
        // The places stay lit while the motion comes in over them.
        const comeIn = ease((time - stage.since) / MOTION_IN_S);
        if (comeIn < 1) {
          pen.globalAlpha = alpha * (1 - comeIn);
          arrivals(p, scene, Infinity);
        }
        pen.globalAlpha = alpha * comeIn;
      }
      body(p, time * k.speed!);
    }
    pen.restore();
  };
  return { scene, k, frame, rnd: seeded(11), fit };
}

/** Places appearing one after another, `age` seconds after the first: a ring opens out and a glow stays. */
function arrivals(p: Painter, scene: Scene, age: number): void {
  scene.places.forEach((pl, i) => {
    const a = age - i * ARRIVAL_S;
    if (a < 0) return;
    const ring = clamp(a / 1.2, 0, 1);
    if (ring < 1) p.ring(pl.x, pl.y, ease(ring) * (60 + 60 * pl.w), pl.c, (1 - ring) * 0.9, 4);
    const settle = ease(a / 0.5);
    p.glow(pl.x, pl.y, 30 + 30 * pl.w, pl.c, 0.8 * settle);
    p.dot(pl.x, pl.y, 4 + 2 * pl.w, WHITE, settle);
  });
}

/** Event-driven mass: weight × an envelope that swells when something is on (activity). */
function massOf(env: PlaceEnv, scene: Scene) {
  return (i: number, t: number) => scene.places[i]!.w * (0.55 + 0.9 * env.data.activity(i, t));
}

// ---- The motions ---------------------------------------------------------------------

const M: PlaceMotionDef[] = [];
const knob = (key: string, label: string, min: number, max: number, step: number, value: number, unit?: string): PlaceKnob => ({ key, label, min, max, step, value, unit });

M.push({
  id: 'ripples', group: 'Place motions', label: 'Ripples and sonar', about: 'Rings pulse out from each place. Bigger, longer rings mean a more important place.',
  data: 'places', columns: ['weight', 'category'],
  knobs: [knob('rings', 'Rings', 1, 6, 1, 3), knob('period', 'Every', 1, 6, 0.1, 2.8, ' s'), knob('reach', 'Reach', 0.3, 2.5, 0.05, 1, '×'), knob('thickness', 'Thickness', 0.3, 3, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.places.forEach((pl, i) => {
            const rmax = (70 + pl.w * 190) * k.reach!;
            const n = Math.round(k.rings!);
            for (let r = 0; r < n; r++) {
              const ph = (((t + i * 0.37) / k.period! + r / n) % 1 + 1) % 1;
              p.ring(pl.x, pl.y, ph * rmax, pl.c, Math.pow(1 - ph, 1.6) * 0.95, (3 + 6 * (1 - ph)) * k.thickness!);
            }
          });
        }),
    };
  },
});

M.push({
  id: 'catchment', group: 'Place motions', label: 'Catchment bloom', about: 'Reach grows outward along the streets from one place at a time, in three distance bands.',
  data: 'places', columns: ['name'], uses: ['streets'], extra: 'Streets come from the site’s street network (OSM or your own lines). Nothing to author.',
  knobs: [knob('reach', 'Reach', 0.3, 2.5, 0.05, 1, '×'), knob('period', 'Each place', 3, 15, 0.5, 6.5, ' s')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    const bands: Rgba[] = [env.palette.slots.warm, env.palette.slots.warning, env.palette.slots.cat6].map((h) => hexRgba(h));
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          if (!scene.pdist.length) return;
          const per = k.period!;
          const i = Math.floor(t / per) % scene.places.length;
          const ph = (t % per) / per;
          const Rm = 760 * k.reach!;
          const reach = ease(ph / 0.7) * Rm;
          const fade = ph > 0.85 ? 1 - (ph - 0.85) / 0.15 : 1;
          const d = scene.pdist[i]!;
          const band = (x: number) => bands[x < Rm / 3 ? 0 : x < (2 * Rm) / 3 ? 1 : 2]!;
          for (const pass of [0, 1]) {
            for (const [a0, b0, len] of scene.edges) {
              let [a, b] = [a0, b0];
              if (d[a]! > d[b]!) [a, b] = [b, a];
              if (!(d[a]! < reach)) continue;
              const f = d[b]! <= reach ? 1 : Math.min(1, (reach - d[a]!) / len);
              const A = scene.nodes[a]!;
              const B = scene.nodes[b]!;
              const x = A.x + (B.x - A.x) * f;
              const y = A.y + (B.y - A.y) * f;
              const c = band(d[a]! + f * len * 0.5);
              if (pass === 0) p.line(A.x, A.y, x, y, c, 0.06 * fade, 28);
              else {
                p.line(A.x, A.y, x, y, c, 0.95 * fade, 6);
                if (f < 1) p.glow(x, y, 26, [255, 240, 220, 1], 0.9 * fade);
              }
            }
          }
          const P = scene.places[i]!;
          p.glow(P.x, P.y, 70, P.c, 0.9 * fade);
          p.dot(P.x, P.y, 12, WHITE, fade);
        }),
    };
  },
});

M.push({
  id: 'territories', group: 'Place motions', label: 'Territories', about: 'Each place claims the area closest to it. Cells breathe as each place’s pull rises and falls.',
  data: 'activity', columns: ['weight', 'activity'],
  knobs: [knob('fill', 'Fill', 0, 0.5, 0.01, 0.13), knob('border', 'Border', 0, 1, 0.05, 0.92), knob('breathing', 'Breathing', 0, 1, 0.05, 0.28)],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    const VW = 320;
    const VH = Math.max(20, Math.round((VW * scene.H) / scene.W));
    const canvas = makeCanvas(VW, VH);
    const g = canvas?.getContext('2d') as Ctx2D | null | undefined;
    const img = g?.createImageData(VW, VH);
    const own = new Int16Array(VW * VH);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          const ws = scene.places.map((pl, i) => (0.6 + pl.w * 0.6) * (1 + k.breathing! * (2 * env.data.activity(i, t) - 1)));
          if (canvas && g && img) {
            const cw = scene.W / VW;
            const ch = scene.H / VH;
            for (let y = 0; y < VH; y++)
              for (let x = 0; x < VW; x++) {
                const wx = (x + 0.5) * cw;
                const wy = (y + 0.5) * ch;
                let best = Infinity;
                let o = 0;
                scene.places.forEach((pl, i) => {
                  const v = Math.hypot(wx - pl.x, wy - pl.y) / ws[i]!;
                  if (v < best) [best, o] = [v, i];
                });
                own[y * VW + x] = o;
              }
            const D = img.data;
            for (let y = 0; y < VH; y++)
              for (let x = 0; x < VW; x++) {
                const i = y * VW + x;
                const o = own[i]!;
                const edge = (x < VW - 1 && own[i + 1] !== o) || (y < VH - 1 && own[i + VW] !== o) || (x > 0 && own[i - 1] !== o) || (y > 0 && own[i - VW] !== o);
                const c = scene.places[o]!.c;
                // Claims fade out far from every place, so empty parts of a real table stay dark.
                const far = Math.hypot((x + 0.5) * cw - scene.places[o]!.x, (y + 0.5) * ch - scene.places[o]!.y) / (REACH_DU * ws[o]!);
                D[i * 4] = c[0];
                D[i * 4 + 1] = c[1];
                D[i * 4 + 2] = c[2];
                D[i * 4 + 3] = 255 * (edge ? k.border! : k.fill!) * Math.exp(-far * far);
              }
            g.putImageData(img, 0, 0);
            p.raster(canvas, scene.W, scene.H);
          }
          scene.places.forEach((pl, i) => p.glow(pl.x, pl.y, 30 + 30 * ws[i]!, pl.c, 0.6));
        }),
    };
  },
});

M.push({
  id: 'constellations', group: 'Place motions', label: 'Constellations', about: 'Thin glowing lines draw themselves in to link related places, like a star chart.',
  data: 'links', columns: ['name', 'category'], extra: 'Without links.csv, places that share a category are linked; with neither, each place links to its two nearest.',
  knobs: [knob('period', 'Cycle', 5, 20, 0.5, 10, ' s'), knob('drawIn', 'Draw-in', 0.3, 2, 0.05, 0.7, ' s'), knob('twinkle', 'Twinkle', 0, 1, 0.05, 0.4)],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    // Links from data, else nearest two neighbours; targets are faint stars tied to their nearest place.
    let pairs = env.data.links.map((l) => [l.a, l.b] as [number, number]);
    if (pairs.length === 0) {
      const seen = new Set<string>();
      scene.places.forEach((a, i) =>
        scene.places.map((b, j) => [j, Math.hypot(a.x - b.x, a.y - b.y)] as const).filter(([j]) => j !== i).sort((x, y) => x[1] - y[1]).slice(0, 2).forEach(([j]) => {
          const key = i < j ? `${i}-${j}` : `${j}-${i}`;
          if (!seen.has(key)) seen.add(key), pairs.push([i, j]);
        }),
      );
    }
    const o = scene.places[0]!;
    pairs = pairs.sort((x, y) => Math.hypot(scene.places[x[0]]!.x - o.x, scene.places[x[0]]!.y - o.y) - Math.hypot(scene.places[y[0]]!.x - o.x, scene.places[y[0]]!.y - o.y));
    const stars = scene.targets.slice(0, 60).map((s) => {
      let best = 0;
      let bd = Infinity;
      scene.places.forEach((pl, i) => {
        const d = Math.hypot(pl.x - s.x, pl.y - s.y);
        if (d < bd) [bd, best] = [d, i];
      });
      return { s, p: best };
    });
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          const per = k.period!;
          const ph = ((t % per) + per) % per;
          const fade = ph > per - 1.4 ? 1 - (ph - (per - 1.4)) / 1.4 : 1;
          stars.forEach(({ s }, n) => p.glow(s.x, s.y, 10, [200, 220, 255, 1], (0.3 + k.twinkle! * Math.pow(0.5 + 0.5 * Math.sin(t * 2 + n), 2)) * fade));
          const all = [...pairs.map(([a, b]) => ({ A: scene.places[a]!, B: scene.places[b]!, c: scene.places[a]!.c, star: false })), ...stars.map(({ s, p: i }) => ({ A: scene.places[i]!, B: s, c: [170, 200, 255, 1] as Rgba, star: true }))];
          all.forEach((l, i) => {
            const u = ease((ph - i * 0.2) / k.drawIn!);
            if (u <= 0) return;
            const x = l.A.x + (l.B.x - l.A.x) * u;
            const y = l.A.y + (l.B.y - l.A.y) * u;
            p.line(l.A.x, l.A.y, x, y, l.c, 0.12 * fade, 14);
            p.line(l.A.x, l.A.y, x, y, l.c, (l.star ? 0.55 : 0.95) * fade, l.star ? 2 : 3.5);
            if (u < 1) p.glow(x, y, 22, WHITE, fade);
          });
          for (const pl of scene.places) {
            const r = 22 + 16 * pl.w;
            p.line(pl.x - r, pl.y, pl.x + r, pl.y, pl.c, 0.9 * fade, 2.5);
            p.line(pl.x, pl.y - r, pl.x, pl.y + r, pl.c, 0.9 * fade, 2.5);
          }
        }),
    };
  },
});

M.push({
  id: 'comets', group: 'Place motions', label: 'Comet arcs', about: 'Curved trails fly from origin to destination, landing with a small flash. Good for trips and flows.',
  data: 'flows', columns: ['name', 'volume'], extra: 'Without flows.csv, comets fly between places picked by weight, as an illustration.',
  knobs: [knob('bend', 'Bend', 0, 0.8, 0.02, 0.3), knob('tail', 'Tail', 0.05, 0.6, 0.01, 0.25), knob('perFlow', 'Comets per flow', 1, 6, 1, 2)],
  create(env) {
    const { scene, k, frame, rnd } = setup(this, env);
    const total = scene.places.reduce((s, p) => s + p.w, 0) || 1;
    const pick = () => {
      let r = rnd() * total;
      for (let i = 0; i < scene.places.length; i++) if ((r -= scene.places[i]!.w) <= 0) return i;
      return 0;
    };
    const flows = env.data.flows.length ? env.data.flows : scene.places.length > 1 ? Array.from({ length: 8 }, () => {
      const a = pick();
      let b = pick();
      for (let n = 0; b === a && n < 20; n++) b = pick();
      return { from: a, to: b === a ? (a + 1) % scene.places.length : b, volume: 0.5 + rnd() * 0.5 };
    }) : [];
    const comets = flows.flatMap((f, n) => Array.from({ length: Math.max(1, Math.round(k.perFlow! * (0.4 + 0.6 * f.volume))) }, (_, j) => ({ a: f.from, b: f.to, per: 3.2 + rnd() * 1.6, off: rnd() * 5 + j * 1.3, s: (n + j) % 2 ? 1 : -1, v: f.volume })));
    const bez = (A: { x: number; y: number }, C: { x: number; y: number }, B: { x: number; y: number }, u: number) => {
      const v = 1 - u;
      return [v * v * A.x + 2 * v * u * C.x + u * u * B.x, v * v * A.y + 2 * v * u * C.y + u * u * B.y] as const;
    };
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          for (const c of comets) {
            const A = scene.places[c.a]!;
            const B = scene.places[c.b]!;
            const C = { x: (A.x + B.x) / 2 - (B.y - A.y) * k.bend! * c.s, y: (A.y + B.y) / 2 + (B.x - A.x) * k.bend! * c.s };
            const ph = (((t + c.off) / c.per) % 1 + 1) % 1;
            if (ph < 0.7) {
              const u = easeIO(ph / 0.7);
              const u0 = Math.max(0, u - k.tail!);
              const N = 20;
              let prev = bez(A, C, B, u0);
              for (let s = 1; s <= N; s++) {
                const q = bez(A, C, B, u0 + ((u - u0) * s) / N);
                const f = s / N;
                p.line(prev[0], prev[1], q[0], q[1], A.c, f * f * 0.95, (1 + 7 * f) * (0.6 + 0.4 * c.v));
                prev = q;
              }
              p.glow(prev[0], prev[1], 26, [255, 245, 230, 1], 1);
            } else if (ph < 0.9) {
              const q = (ph - 0.7) / 0.2;
              p.ring(B.x, B.y, 20 + q * 60, A.c, (1 - q) * 0.9, 4 * (1 - q) + 1);
            }
          }
        }),
    };
  },
});

M.push({
  id: 'metaballs', group: 'Place motions', label: 'Metaballs', about: 'Soft blobs drift and melt together when places sit close, so clusters read as one shape.',
  data: 'places', columns: ['weight', 'category'],
  knobs: [knob('size', 'Size', 0.3, 2.5, 0.05, 1, '×'), knob('drift', 'Drift', 0, 2, 0.05, 1, '×'), knob('rim', 'Rim', 0, 1.5, 0.05, 0.85)],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    const GW = 240;
    const GH = Math.max(20, Math.round((GW * scene.H) / scene.W));
    const canvas = makeCanvas(GW, GH);
    const g = canvas?.getContext('2d') as Ctx2D | null | undefined;
    const img = g?.createImageData(GW, GH);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          const C = scene.places.map((pl, i) => ({ x: pl.x + 110 * k.drift! * Math.sin(t * 0.35 + i * 1.7), y: pl.y + 80 * k.drift! * Math.cos(t * 0.28 + i * 2.3), r: (55 + 80 * pl.w) * k.size!, c: pl.c }));
          if (canvas && g && img) {
            const D = img.data;
            const sx = scene.W / GW;
            const sy = scene.H / GH;
            for (let y = 0; y < GH; y++)
              for (let x = 0; x < GW; x++) {
                const wx = (x + 0.5) * sx;
                const wy = (y + 0.5) * sy;
                let f = 0, r = 0, gg = 0, b = 0;
                for (const c of C) {
                  const v = (c.r * c.r) / ((wx - c.x) ** 2 + (wy - c.y) ** 2 + 1);
                  f += v; r += c.c[0] * v; gg += c.c[1] * v; b += c.c[2] * v;
                }
                const i = (y * GW + x) * 4;
                const a = clamp((f - 0.7) / 0.3, 0, 1) * 0.42 + Math.exp(-(((f - 1) / 0.08) ** 2)) * k.rim!;
                D[i] = r / f; D[i + 1] = gg / f; D[i + 2] = b / f; D[i + 3] = Math.min(255, a * 255);
              }
            g.putImageData(img, 0, 0);
            p.raster(canvas, scene.W, scene.H);
          }
          for (const c of C) p.dot(c.x, c.y, 5, WHITE, 0.8);
        }),
    };
  },
});

M.push({
  id: 'orbiters', group: 'Place motions', label: 'Orbiters', about: 'Small particles circle each place. They speed up when the place gets busier.',
  data: 'activity', columns: ['weight', 'activity'],
  knobs: [knob('count', 'How many', 0.3, 3, 0.1, 1, '×'), knob('spread', 'Spread', 0.3, 2.5, 0.05, 1, '×'), knob('trail', 'Trail', 0, 1, 0.05, 1)],
  create(env) {
    const { scene, k, frame, rnd } = setup(this, env);
    const orbs = scene.places.map((pl) => Array.from({ length: Math.round((5 + pl.w * 12) * k.count!) }, () => ({ r: (34 + rnd() * (45 + 80 * pl.w)) * k.spread!, e: 0.55 + rnd() * 0.45, phi: rnd() * Math.PI, th: rnd() * 7, dir: rnd() < 0.85 ? 1 : -1 })));
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.places.forEach((pl, i) => {
            const busy = 0.4 + 1.2 * env.data.activity(i, t);
            p.glow(pl.x, pl.y, 40 + 40 * busy * pl.w, pl.c, 0.35 * busy);
            for (const o of orbs[i]!) {
              const om = (150 / o.r) * o.dir * busy * 0.5;
              const pos = (th: number) => {
                const cx = o.r * Math.cos(th);
                const cy = o.r * o.e * Math.sin(th);
                return [pl.x + cx * Math.cos(o.phi) - cy * Math.sin(o.phi), pl.y + cx * Math.sin(o.phi) + cy * Math.cos(o.phi)] as const;
              };
              const th = o.th + om * t;
              const step = om * 0.035;
              const n = Math.round(10 * k.trail!);
              let prev = pos(th - step * n);
              for (let s = n - 1; s >= 0; s--) {
                const q = pos(th - step * s);
                const f = 1 - s / Math.max(1, n);
                p.line(prev[0], prev[1], q[0], q[1], pl.c, f * 0.8, 1 + 4 * f);
                prev = q;
              }
              p.dot(prev[0], prev[1], 4.5, WHITE, 0.95);
            }
          });
        }),
    };
  },
});

M.push({
  id: 'spokes', group: 'Place motions', label: 'Spokes', about: 'Lines reach out from a place to everything within a set radius, nearest first.',
  data: 'targets', columns: ['weight'], extra: 'Without a targets dataset, spokes reach the other places.',
  knobs: [knob('radius', 'Radius', 0.3, 2.5, 0.05, 1, '×'), knob('period', 'Each place', 2, 12, 0.5, 5.5, ' s'), knob('width', 'Line', 0.3, 3, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    const SR = 430 * k.radius!;
    const targets = scene.places.map((pl, i) => [...scene.targets, ...scene.places.filter((_, j) => j !== i)].map((q) => ({ q, d: Math.hypot(q.x - pl.x, q.y - pl.y) })).filter((o) => o.d < SR && o.d > 5).sort((a, b) => a.d - b.d));
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          const per = k.period!;
          const i = Math.floor(t / per) % scene.places.length;
          const ph = (t % per) / per;
          const P = scene.places[i]!;
          const reach = ease(ph / 0.6) * SR;
          const fade = ph > 0.85 ? 1 - (ph - 0.85) / 0.15 : 1;
          for (const { q, d } of targets[i]!) {
            if (d > reach) continue;
            const a = (1 - (0.6 * d) / SR) * fade;
            const pop = Math.min(1, (reach - d) / 50);
            p.line(P.x, P.y, q.x, q.y, P.c, a * 0.75, 2.5 * k.width!);
            p.glow(q.x, q.y, 16 * pop, P.c, a);
            p.dot(q.x, q.y, 4.5 * pop, WHITE, a);
          }
          p.pen.setLineDash([p.m(10), p.m(12)]);
          p.ring(P.x, P.y, reach, P.c, 0.35 * fade, 2);
          p.pen.setLineDash([]);
          p.glow(P.x, P.y, 70, P.c, 0.9 * fade);
          p.dot(P.x, P.y, 12, WHITE, fade);
        }),
    };
  },
});

M.push({
  id: 'fireflies', group: 'Place motions', label: 'Fireflies', about: 'Sparkles drift and blink around each place. More of them light up when it is livelier.',
  data: 'activity', columns: ['weight', 'activity'],
  knobs: [knob('count', 'How many', 40, 600, 10, 240), knob('drift', 'Drift', 0.3, 2.5, 0.05, 1, '×'), knob('blink', 'Blink', 0.3, 3, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame, rnd } = setup(this, env);
    const total = scene.places.reduce((s, p) => s + p.w, 0) || 1;
    const flies = Array.from({ length: Math.round(k.count!) }, () => {
      let r = rnd() * total;
      let pi = 0;
      for (let i = 0; i < scene.places.length; i++) if ((r -= scene.places[i]!.w) <= 0) { pi = i; break; }
      const pl = scene.places[pi]!;
      return { pi, rho: (30 + rnd() * 150 * (0.5 + pl.w)) * k.drift!, f1: 0.15 + rnd() * 0.35, f2: 0.15 + rnd() * 0.35, f3: 0.6 + rnd(), p1: rnd() * 7, p2: rnd() * 7, p3: rnd() * 7, ft: 1 + rnd() * 2.5, pt: rnd() * 7, rank: rnd(), warm: rnd() < 0.6 };
    });
    const warm = hexRgba(env.palette.slots.warm);
    const green = hexRgba(env.palette.slots.green);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          const act = scene.places.map((_, i) => 0.2 + 0.8 * env.data.activity(i, t));
          for (const f of flies) {
            if (f.rank > act[f.pi]!) continue;
            const pl = scene.places[f.pi]!;
            const x = pl.x + f.rho * Math.sin(t * f.f1 + f.p1) + 22 * Math.sin(t * f.f3 + f.p3);
            const y = pl.y + f.rho * 0.75 * Math.cos(t * f.f2 + f.p2) + 22 * Math.cos(t * f.f3 * 1.3 + f.p3);
            const b = Math.pow(Math.max(0, Math.sin(t * f.ft * k.blink! + f.pt)), 3);
            p.glow(x, y, 24, f.warm ? warm : green, b * 0.7);
            p.dot(x, y, 3.4, [255, 252, 235, 1], 0.15 + 0.85 * b);
          }
        }),
    };
  },
});

M.push({
  id: 'contours', group: 'Place motions', label: 'Contour rise', about: 'Density contours ripple up out of the ground, ring by ring, like a heat map coming alive.',
  data: 'raster', columns: ['weight'],
  knobs: [knob('levels', 'Levels', 3, 12, 1, 8), knob('spread', 'Smoothing', 0.3, 3, 0.05, 1, '×'), knob('period', 'Rise every', 3, 20, 0.5, 8, ' s')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    const GW = 128;
    const GH = Math.max(12, Math.round((GW * scene.H) / scene.W));
    const dens = new Float32Array(GW * GH);
    const sources = [...scene.places.map((p) => ({ x: p.x, y: p.y, w: 1 + 3 * p.w })), ...scene.targets.map((q) => ({ ...q, w: 1 }))];
    const sig = 85 * k.spread!;
    let most = 0;
    for (let y = 0; y < GH; y++)
      for (let x = 0; x < GW; x++) {
        const wx = (x / (GW - 1)) * scene.W;
        const wy = (y / (GH - 1)) * scene.H;
        let s = 0;
        for (const q of sources) s += q.w * Math.exp(-((wx - q.x) ** 2 + (wy - q.y) ** 2) / (2 * sig * sig));
        dens[y * GW + x] = s;
        most = Math.max(most, s);
      }
    for (let i = 0; i < dens.length; i++) dens[i]! /= most || 1;
    const canvas = makeCanvas(GW, GH);
    const g = canvas?.getContext('2d') as Ctx2D | null | undefined;
    const img = g?.createImageData(GW, GH);
    const val = new Float32Array(GW * GH);
    const ramp = env.palette.ramps.glow ?? env.palette.ramps.sun ?? [];
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          const per = k.period!;
          const ph = (t % per) / per;
          const s = easeIO(ph / 0.75);
          const fade = ph > 0.88 ? 1 - (ph - 0.88) / 0.12 : 1;
          for (let i = 0; i < val.length; i++) val[i] = dens[i]! * s * (1 + 0.06 * Math.sin(t * 3 - dens[i]! * 12));
          if (canvas && g && img) {
            const D = img.data;
            for (let i = 0; i < val.length; i++) {
              const c = rampColour(ramp, val[i]!);
              D[i * 4] = c[0]; D[i * 4 + 1] = c[1]; D[i * 4 + 2] = c[2]; D[i * 4 + 3] = val[i]! * 95 * fade;
            }
            g.putImageData(img, 0, 0);
            p.raster(canvas, scene.W, scene.H);
          }
          const sx = scene.W / (GW - 1);
          const sy = scene.H / (GH - 1);
          const L = Math.round(k.levels!);
          for (let l = 1; l <= L; l++) {
            const lv = l / (L + 1);
            const c = rampColour(ramp, lv);
            p.pen.strokeStyle = css(c, 0.9 * fade);
            p.pen.lineWidth = p.m(2 + l * 0.35);
            p.pen.beginPath();
            for (let y = 0; y < GH - 1; y++)
              for (let x = 0; x < GW - 1; x++) {
                const a = val[y * GW + x]!, b = val[y * GW + x + 1]!, cc = val[(y + 1) * GW + x + 1]!, d = val[(y + 1) * GW + x]!;
                const pts: [number, number][] = [];
                const e = (v1: number, v2: number, x1: number, y1: number, x2: number, y2: number) => {
                  if (v1 < lv !== v2 < lv) {
                    const f = (lv - v1) / (v2 - v1);
                    pts.push(p.x((x1 + (x2 - x1) * f) * sx, (y1 + (y2 - y1) * f) * sy));
                  }
                };
                e(a, b, x, y, x + 1, y); e(b, cc, x + 1, y, x + 1, y + 1); e(d, cc, x, y + 1, x + 1, y + 1); e(a, d, x, y, x, y + 1);
                for (let n = 0; n + 1 < pts.length; n += 2) {
                  p.pen.moveTo(pts[n]![0], pts[n]![1]);
                  p.pen.lineTo(pts[n + 1]![0], pts[n + 1]![1]);
                }
              }
            p.pen.stroke();
          }
        }),
    };
  },
});

// ---- Circular waves (#162) -------------------------------------------------------

function ringDots(p: Painter, x: number, y: number, r: number, n: number, rot: number, size: number, c: Rgba, a: number): void {
  for (let k = 0; k < n; k++) {
    const th = rot + (k / n) * TAU;
    p.dot(x + r * Math.cos(th), y + r * Math.sin(th), size, c, a);
  }
}

M.push({
  id: 'dot-pulse', group: 'Circular waves', label: 'Dot pulse', about: 'Rings made of dots expand out of each place and fade, like a sonar ping drawn in dots.',
  data: 'places', columns: ['weight'],
  knobs: [knob('rings', 'Rings', 2, 10, 1, 6), knob('dots', 'Dots', 0.3, 2.5, 0.05, 1, '×'), knob('period', 'Every', 1, 8, 0.1, 2.9, ' s'), knob('size', 'Dot size', 0.3, 2.5, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.places.forEach((pl, i) => {
            const rmax = 80 + 160 * pl.w;
            const n = Math.round(k.rings!);
            for (let r = 0; r < n; r++) {
              const ph = ((t / k.period! + i * 0.13 + r / n) % 1 + 1) % 1;
              ringDots(p, pl.x, pl.y, ph * rmax, Math.round((10 + ph * 18 * (0.6 + pl.w)) * k.dots!), ph * 1.2 + i, 4.5 * (1 - 0.5 * ph) * k.size!, pl.c, Math.pow(1 - ph, 1.2));
            }
            p.glow(pl.x, pl.y, 26, pl.c, 0.6);
          });
        }),
    };
  },
});

M.push({
  id: 'counter-rings', group: 'Circular waves', label: 'Counter-rotating rings', about: 'Concentric rings of dots turn in opposite directions. More rings for bigger places.',
  data: 'places', columns: ['weight'],
  knobs: [knob('rings', 'Rings', 0.3, 2.5, 0.05, 1, '×'), knob('spacing', 'Spacing', 0.5, 2.5, 0.05, 1, '×'), knob('spin', 'Spin', 0, 2, 0.05, 0.45), knob('size', 'Dot size', 0.3, 2.5, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.places.forEach((pl, i) => {
            const nr = Math.max(1, Math.round((2 + pl.w * 4) * k.rings!));
            for (let r = 1; r <= nr; r++) {
              const rad = r * 24 * k.spacing! + 3 * Math.sin(t * 2 + r + i);
              const pul = 0.6 + 0.4 * Math.sin(t * 1.6 - r * 0.7 + i);
              p.ring(pl.x, pl.y, rad, pl.c, 0.12, 1.5);
              ringDots(p, pl.x, pl.y, rad, 6 * r, (r % 2 ? 1 : -1) * t * k.spin! + i, (3.2 + 1.3 * pul) * k.size!, pl.c, 0.5 + 0.5 * pul);
            }
          });
        }),
    };
  },
});

M.push({
  id: 'sound-ring', group: 'Circular waves', label: 'Sound ring', about: 'A closed waveform wraps each place, like a circular audio visualiser. Livelier places wobble harder.',
  data: 'activity', columns: ['level', 'weight'], extra: 'With audio files (#150), the level will come from the sound itself.',
  knobs: [knob('layers', 'Layers', 1, 6, 1, 4), knob('amplitude', 'Wobble', 0.2, 2.5, 0.05, 1, '×'), knob('radius', 'Radius', 0.4, 2.5, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.places.forEach((pl, i) => {
            const lvl = (0.35 + 0.65 * pl.w) * (0.6 + 0.4 * env.data.activity(i, t));
            const r0 = (40 + 55 * pl.w) * k.radius!;
            for (let L = 0; L < Math.round(k.layers!); L++) {
              const r = r0 + L * 14;
              const amp = Math.max(2, 16 - L * 3) * lvl * k.amplitude!;
              p.pen.beginPath();
              for (let s = 0; s <= 180; s++) {
                const th = (s / 180) * TAU;
                const w = Math.sin(th * 6 + t * 3 + L * 0.6 + i) * 0.5 + Math.sin(th * 11 - t * 4.3 + i * 2) * 0.3 + Math.sin(th * 3 + t * 1.7 + L) * 0.4;
                const [x, y] = p.x(pl.x + (r + amp * w) * Math.cos(th), pl.y + (r + amp * w) * Math.sin(th));
                if (s) p.pen.lineTo(x, y);
                else p.pen.moveTo(x, y);
              }
              p.pen.closePath();
              p.pen.strokeStyle = css(pl.c, 0.14);
              p.pen.lineWidth = p.m(10);
              p.pen.stroke();
              p.pen.strokeStyle = css(L ? pl.c : WHITE, L ? Math.max(0.2, 0.75 - L * 0.15) : 0.85);
              p.pen.lineWidth = Math.max(0.8, p.m(L ? 2 : 2.5));
              p.pen.stroke();
            }
            p.glow(pl.x, pl.y, r0, pl.c, 0.4 * lvl);
          });
        }),
    };
  },
});

M.push({
  id: 'spectrum', group: 'Circular waves', label: 'Spectrum bars', about: 'Bars around each place rise and fall like an equaliser. Made for the bird-sound idea, one ring per sound.',
  data: 'audio', columns: ['sound', 'weight'],
  knobs: [knob('bars', 'Bars', 12, 72, 1, 36), knob('width', 'Bar width', 0.3, 2.5, 0.05, 1, '×'), knob('height', 'Height', 0.3, 2.5, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.places.forEach((pl, i) => {
            const n = Math.round(k.bars!);
            const r0 = 34 + 30 * pl.w;
            const live = 0.5 + 0.5 * env.data.activity(i, t);
            for (let b = 0; b < n; b++) {
              const th = (b / n) * TAU;
              const v = Math.pow(Math.abs(Math.sin(b * 1.7 + t * (2.2 + (b % 5) * 0.4) + i) * Math.sin(b * 0.45 - t * 1.1 + i * 3)), 0.8) * live;
              const h = (6 + v * (30 + 70 * pl.w)) * k.height!;
              p.line(pl.x + r0 * Math.cos(th), pl.y + r0 * Math.sin(th), pl.x + (r0 + h) * Math.cos(th), pl.y + (r0 + h) * Math.sin(th), v > 0.7 ? WHITE : pl.c, 0.35 + 0.6 * v, 5 * k.width!);
            }
            p.glow(pl.x, pl.y, r0, pl.c, 0.5);
          });
        }),
    };
  },
});

M.push({
  id: 'bulge', group: 'Circular waves', label: 'Travelling bulge', about: 'Dots on a ring joined to the centre by spokes. A swell runs around the ring, like a clock hand or a scan.',
  data: 'places', columns: ['weight', 'heading'],
  knobs: [knob('dots', 'Dots', 6, 40, 1, 16), knob('width', 'Bulge width', 0.3, 3, 0.05, 1, '×'), knob('sweep', 'Sweep', 0.2, 4, 0.05, 1.4), knob('spokes', 'Spokes', 0, 1, 0.05, 0.55)],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.places.forEach((pl, i) => {
            const n = Math.round(k.dots!);
            const r0 = 50 + 60 * pl.w;
            const head = (t * k.sweep! + i) % TAU;
            for (let d = 0; d < n; d++) {
              const th = (d / n) * TAU;
              let dd = Math.abs(th - head);
              dd = Math.min(dd, TAU - dd);
              const b = Math.exp((-dd * dd * 3) / (k.width! * k.width!));
              const r = r0 + 14 * b;
              const x = pl.x + r * Math.cos(th);
              const y = pl.y + r * Math.sin(th);
              p.line(pl.x, pl.y, x, y, pl.c, (0.12 + 0.55 * b) * (k.spokes! / 0.55), 1.5 + 2 * b);
              p.glow(x, y, 10 + 14 * b, pl.c, 0.4 + 0.6 * b);
              p.dot(x, y, 2.5 + 3.5 * b, WHITE, 0.5 + 0.5 * b);
            }
          });
        }),
    };
  },
});

M.push({
  id: 'galaxy', group: 'Circular waves', label: 'Spiral galaxy', about: 'Particles swirl on spiral arms around a place. Inner ones turn faster, so the arms wind up.',
  data: 'places', columns: ['weight'],
  knobs: [knob('arms', 'Arms', 1, 6, 1, 3), knob('count', 'Particles', 0.3, 3, 0.1, 1, '×'), knob('winding', 'Winding', 0.3, 3, 0.05, 1.6), knob('spin', 'Spin', 0.2, 3, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame, rnd } = setup(this, env);
    const arms = Math.round(k.arms!);
    const gal = scene.places.map((pl) => Array.from({ length: Math.round((40 + pl.w * 90) * k.count!) }, (_, n) => ({ arm: n % arms, r: 8 + Math.pow(rnd(), 0.7) * (70 + 90 * pl.w), j: (rnd() - 0.5) * 0.5, s: 1 + rnd() * 2.2 })));
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.places.forEach((pl, i) => {
            p.glow(pl.x, pl.y, 40 + 30 * pl.w, pl.c, 0.5);
            const dir = i % 2 ? 1 : -1;
            for (const g of gal[i]!) {
              const base = (g.arm * TAU) / arms + Math.log(g.r) * k.winding! + g.j;
              const om = (26 / Math.sqrt(g.r)) * k.spin!;
              const th = base + t * om * dir;
              const x = pl.x + g.r * Math.cos(th);
              const y = pl.y + g.r * Math.sin(th);
              if (g.s > 2.4) {
                const th2 = th - om * 0.12 * dir;
                p.line(pl.x + g.r * Math.cos(th2), pl.y + g.r * Math.sin(th2), x, y, pl.c, 0.5, g.s);
              }
              p.dot(x, y, g.s, g.s > 2.4 ? WHITE : pl.c, 0.85);
            }
          });
        }),
    };
  },
});

// ---- Cultural gravity (#163): places that act on the map ----------------------------

const GX = 'These react to the site’s own streets and buildings, so there is nothing extra to author. Events are optional: without activity.csv, each place swells slowly on its own.';

/** How far, in du, a place's motion reaches: about a preview's place spacing and a half. */
const REACH_DU = 480;

/** The street edges within reach of a place, or all of them when none are. */
function nearEdges(scene: Scene): [number, number, number][] {
  const near = scene.edges.filter(([a]) => {
    const n = scene.nodes[a]!;
    return scene.places.some((p) => Math.hypot(p.x - n.x, p.y - n.y) < REACH_DU * 1.5);
  });
  return near.length ? near : scene.edges;
}

/** Pull of all places at a point: the strongest place, its pull and the sum. */
function pullAt(scene: Scene, mass: (i: number, t: number) => number, x: number, y: number, t: number, strength = 1) {
  let best = 0, bv = 0, sum = 0;
  for (let i = 0; i < scene.places.length; i++) {
    const p = scene.places[i]!;
    const v = (mass(i, t) * 1e5 * strength) / ((x - p.x) ** 2 + (y - p.y) ** 2 + 9000);
    sum += v;
    if (v > bv) [bv, best] = [v, i];
  }
  return { best, bv, sum };
}

M.push({
  id: 'gravity-well', group: 'Cultural gravity', label: 'Gravity well', about: 'Heavy places bend the streets and blocks around them. When an event swells a place, the city sinks toward it.',
  data: 'activity', columns: ['weight', 'activity'], extra: GX, uses: ['streets', 'buildings'],
  knobs: [knob('bend', 'Bend', 0, 2, 0.05, 0.85), knob('reach', 'Reach', 0.3, 2.5, 0.05, 1, '×'), knob('shrink', 'Blocks shrink', 0, 1, 0.05, 0.6), knob('streets', 'Street glow', 0, 2, 0.05, 1)],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    const mass = massOf(env, scene);
    const sig = 210 * k.reach!;
    const warp = (x: number, y: number, t: number): [number, number] => {
      let dx = 0, dy = 0, total = 0;
      for (let i = 0; i < scene.places.length; i++) {
        const p = scene.places[i]!;
        const ex = p.x - x, ey = p.y - y;
        const s = mass(i, t) * k.bend! * Math.exp(-(ex * ex + ey * ey) / (2 * sig * sig));
        dx += ex * s; dy += ey * s; total += s;
      }
      // Close places add up; never pull a point past them, or the streets fold over.
      const cap = total > 0.6 ? 0.6 / total : 1;
      return [x + dx * cap, y + dy * cap];
    };
    const ground: Rgba = [40, 56, 76, 1];
    const dim: Rgba = [60, 80, 100, 1];
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          // Blocks as faint footprints over the base map, shrinking as they are pulled in.
          scene.buildings.forEach(([x, y], n) => {
            const [a, b] = warp(x, y, t);
            const { sum } = pullAt(scene, mass, x, y, t);
            const s = 1 - Math.min(k.shrink!, sum * 0.03);
            // Only pulled blocks are drawn again: the base map already shows the rest, and light adds up.
            const shown = Math.min(0.9, sum * 0.08);
            if (shown < 0.03) return;
            // The footprint moves with its centre and shrinks around it.
            p.footprint(scene.footprints[n]!, css(ground, shown), (vx, vy) => [a + (vx - x) * s, b + (vy - y) * s]);
          });
          for (const [a0, b0] of scene.edges) {
            const A = scene.nodes[a0]!, B = scene.nodes[b0]!;
            let prev = warp(A.x, A.y, t);
            for (let s = 1; s <= 8; s++) {
              const x = A.x + ((B.x - A.x) * s) / 8, y = A.y + ((B.y - A.y) * s) / 8;
              const q = warp(x, y, t);
              const { best, sum } = pullAt(scene, mass, x, y, t);
              const g = Math.min(1, Math.max(0, (sum - 0.8) * 0.16)) * k.streets!;
              p.line(prev[0], prev[1], q[0], q[1], g > 0.25 ? scene.places[best]!.c : dim, Math.min(1, 0.25 + 0.7 * g), 3 + 3 * Math.min(1, g));
              prev = q;
            }
          }
          scene.places.forEach((pl, i) => p.glow(pl.x, pl.y, 30 + 60 * mass(i, t), pl.c, 0.8));
        }),
    };
  },
});

M.push({
  id: 'pilgrims', group: 'Cultural gravity', label: 'Pilgrims', about: 'Walkers move along the real streets and drift toward whichever place pulls hardest. Places flash as people arrive.',
  data: 'activity', columns: ['weight', 'activity'], extra: `${GX} Walkers use the street network.`, uses: ['streets'],
  knobs: [knob('count', 'Walkers', 40, 800, 10, 320), knob('pace', 'Pace', 0.3, 3, 0.05, 1, '×'), knob('follow', 'Follow the pull', 0, 3, 0.05, 1), knob('trail', 'Trail', 0, 3, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame, rnd } = setup(this, env);
    const mass = massOf(env, scene);
    // Walkers start and restart on the streets around the places, not out where nothing pulls.
    const near = nearEdges(scene);
    const walkers = near.length ? Array.from({ length: Math.round(k.count!) }, () => {
      const e = near[Math.floor(rnd() * near.length)]!;
      return { a: e[0], b: e[1], u: rnd(), sp: (60 + rnd() * 50) * k.pace! };
    }) : [];
    const arrive = scene.places.map(() => 0);
    const nodePlace = new Map(scene.placeNode.map((n, i) => [n, i]));
    let last: number | null = null;
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          let dt = last === null ? 0 : t - last;
          last = t;
          if (dt < 0 || dt > 0.25) dt = 0.016;
          for (const w of walkers) {
            const A = scene.nodes[w.a]!, B = scene.nodes[w.b]!;
            const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
            w.u += (w.sp * dt) / len;
            let guard = 0;
            while (w.u >= 1 && guard++ < 8) {
              w.u -= 1;
              const pi = nodePlace.get(w.b);
              if (pi !== undefined && rnd() < 0.7) {
                arrive[pi] = 1;
                const e = near[Math.floor(rnd() * near.length)]!;
                [w.a, w.b, w.u] = [e[0], e[1], 0];
                break;
              }
              let best = w.a, bs = -Infinity;
              for (const [n] of scene.adj[w.b]!) {
                if (n === w.a && scene.adj[w.b]!.length > 1) continue;
                const s = pullAt(scene, mass, scene.nodes[n]!.x, scene.nodes[n]!.y, t).sum * k.follow! + rnd() * 18;
                if (s > bs) [bs, best] = [s, n];
              }
              [w.a, w.b] = [w.b, best];
            }
          }
          for (let i = 0; i < arrive.length; i++) arrive[i] = Math.max(0, arrive[i]! - dt * 1.5);
          scene.places.forEach((pl, i) => p.glow(pl.x, pl.y, 30 + 50 * mass(i, t) + 40 * arrive[i]!, pl.c, 0.5 + 0.5 * arrive[i]!));
          for (const w of walkers) {
            const A = scene.nodes[w.a]!, B = scene.nodes[w.b]!;
            const x = A.x + (B.x - A.x) * w.u, y = A.y + (B.y - A.y) * w.u;
            const u0 = Math.max(0, w.u - (30 * k.trail!) / (Math.hypot(B.x - A.x, B.y - A.y) || 1));
            const c = scene.places[pullAt(scene, mass, x, y, t).best]!.c;
            if (k.trail! > 0) p.line(A.x + (B.x - A.x) * u0, A.y + (B.y - A.y) * u0, x, y, c, 0.5, 3);
            p.dot(x, y, 3.6, [255, 250, 240, 1], 0.95);
          }
        }),
    };
  },
});

M.push({
  id: 'lit-blocks', group: 'Cultural gravity', label: 'Lit blocks', about: 'Buildings light up in the colour of the place that pulls them hardest. An event sends a wave of light across the blocks.',
  data: 'activity', columns: ['weight', 'activity'], extra: GX, uses: ['buildings'],
  knobs: [knob('reach', 'Reach', 0.3, 3, 0.05, 1, '×'), knob('wave', 'Wave speed', 0, 3, 0.05, 1, '×'), knob('base', 'Brightness', 0, 2, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    const mass = massOf(env, scene);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.buildings.forEach(([x, y], n) => {
            const { best, bv } = pullAt(scene, mass, x, y, t, k.reach! * k.reach!);
            const pl = scene.places[best]!;
            const d = Math.hypot(x - pl.x, y - pl.y);
            const wave = k.wave! > 0 ? Math.exp(-(((d - ((t * 260 * k.wave! + best * 300) % 900)) / 60) ** 2)) * mass(best, t) : 0;
            const a = clamp((bv - 1.2) / 7, 0, 0.8) * k.base! + wave * 0.8;
            if (a < 0.04) return;
            // The building's own footprint lights up, not a box around it.
            p.footprint(scene.footprints[n]!, css(pl.c, Math.min(1, a)));
          });
          scene.places.forEach((pl, i) => p.glow(pl.x, pl.y, 40 + 40 * mass(i, t), pl.c, 0.6));
        }),
    };
  },
});

M.push({
  id: 'field-lines', group: 'Cultural gravity', label: 'Field lines', about: 'Light dust is swept across the whole map by the places’ pull, curving between them and falling into the strongest.',
  data: 'places', columns: ['weight'],
  knobs: [knob('count', 'Dust', 100, 1500, 20, 520), knob('trail', 'Trail', 2, 40, 1, 14), knob('pull', 'Pull', 0.3, 3, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame, rnd } = setup(this, env);
    const mass = massOf(env, scene);
    const spawn = (): [number, number] => {
      // Dust rises within reach of the places (on a real table they may fill only part of it).
      const pl = scene.places[Math.floor(rnd() * scene.places.length)]!;
      const r = REACH_DU * 1.6 * Math.sqrt(rnd());
      const a = rnd() * TAU;
      return [clamp(pl.x + r * Math.cos(a), 0, scene.W), clamp(pl.y + r * Math.sin(a), 0, scene.H)];
    };
    const tracers = Array.from({ length: Math.round(k.count!) }, () => ({ x: 0, y: 0, tr: [] as [number, number][], age: rnd() * 4 }));
    for (const q of tracers) [q.x, q.y] = spawn();
    let last: number | null = null;
    const field = (x: number, y: number, t: number): [number, number] => {
      let fx = 0, fy = 0;
      for (let i = 0; i < scene.places.length; i++) {
        const p = scene.places[i]!;
        const ex = p.x - x, ey = p.y - y;
        const d2 = ex * ex + ey * ey + 2500;
        const s = (mass(i, t) * 9e6 * k.pull!) / (d2 * Math.sqrt(d2));
        fx += ex * s; fy += ey * s;
      }
      return [fx, fy];
    };
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          let dt = last === null ? 0 : t - last;
          last = t;
          if (dt < 0 || dt > 0.25) dt = 0.016;
          for (const q of tracers) {
            const [fx, fy] = field(q.x, q.y, t);
            const m = Math.hypot(fx, fy) || 1;
            const sp = Math.min(260, 30 + m);
            q.x += (fx / m) * sp * dt;
            q.y += (fy / m) * sp * dt;
            q.age += dt;
            q.tr.push([q.x, q.y]);
            if (q.tr.length > k.trail!) q.tr.shift();
            const best = pullAt(scene, mass, q.x, q.y, t).best;
            const P = scene.places[best]!;
            if (Math.hypot(q.x - P.x, q.y - P.y) < 18 || q.age > 7) {
              [q.x, q.y] = spawn();
              [q.tr, q.age] = [[], 0];
              continue;
            }
            if (q.tr.length > 1) {
              p.pen.strokeStyle = css(P.c, 0.55);
              p.pen.lineWidth = Math.max(0.8, p.m(2));
              p.pen.beginPath();
              q.tr.forEach(([x, y], n) => {
                const [px, py] = p.x(x, y);
                if (n) p.pen.lineTo(px, py);
                else p.pen.moveTo(px, py);
              });
              p.pen.stroke();
            }
          }
          scene.places.forEach((pl, i) => p.glow(pl.x, pl.y, 30 + 40 * mass(i, t), pl.c, 0.7));
        }),
    };
  },
});

M.push({
  id: 'street-pulses', group: 'Cultural gravity', label: 'Street pulses', about: 'Each place sends pulses down the streets. Where two places’ pulses meet, the street flares.',
  data: 'places', columns: ['weight'], extra: GX, uses: ['streets'],
  knobs: [knob('interval', 'Every', 0.8, 6, 0.1, 2.4, ' s'), knob('pace', 'Pace', 0.3, 3, 0.05, 1, '×'), knob('length', 'Length', 0.3, 3, 0.05, 1, '×'), knob('travel', 'Travel', 0.3, 3, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          if (!scene.pdist.length) return;
          const sp = 230 * k.pace!;
          const per = k.interval!;
          const far = 750 * k.travel!;
          scene.places.forEach((pl, i) => {
            const d = scene.pdist[i]!;
            for (let n = 0; n < Math.ceil(far / (sp * per)) + 1; n++) {
              const age = ((t + i * 0.5) % per) + n * per;
              const rho = age * sp;
              const str = pl.w * Math.max(0, 1 - rho / far);
              if (str <= 0) continue;
              for (const [a0, b0, len] of scene.edges) {
                let [a, b] = [a0, b0];
                if (d[a]! > d[b]!) [a, b] = [b, a];
                if (!(d[a]! <= rho && rho < d[b]!)) continue;
                const f = Math.min(1, (rho - d[a]!) / len);
                const f0 = Math.max(0, f - (70 * k.length!) / len);
                const A = scene.nodes[a]!, B = scene.nodes[b]!;
                p.line(A.x + (B.x - A.x) * f0, A.y + (B.y - A.y) * f0, A.x + (B.x - A.x) * f, A.y + (B.y - A.y) * f, pl.c, 0.9 * str, 6);
                p.glow(A.x + (B.x - A.x) * f, A.y + (B.y - A.y) * f, 18, pl.c, str);
              }
            }
            p.glow(pl.x, pl.y, 34 + 20 * pl.w, pl.c, 0.7);
          });
        }),
    };
  },
});

M.push({
  id: 'threads', group: 'Cultural gravity', label: 'Threads of belonging', about: 'Every building hangs a thread to the place it belongs to. When an event swells a place, threads switch over to it.',
  data: 'activity', columns: ['weight', 'activity'], extra: GX, uses: ['buildings'],
  knobs: [knob('opacity', 'Opacity', 0.2, 2, 0.05, 1, '×'), knob('sag', 'Sag', 0, 3, 0.05, 1, '×'), knob('reach', 'Reach', 0.3, 3, 0.05, 1, '×')],
  create(env) {
    const { scene, k, frame } = setup(this, env);
    const mass = massOf(env, scene);
    return {
      draw: (view, time, alpha) =>
        frame(view, time, alpha, (p, t) => {
          scene.buildings.forEach(([x, y], n) => {
            const { best, bv } = pullAt(scene, mass, x, y, t, k.reach! * k.reach!);
            const pl = scene.places[best]!;
            const a = clamp((bv - 0.5) / 5, 0, 0.7) * k.opacity!;
            if (a < 0.05) return;
            const sag = 12 * k.sag! * Math.sin(t * 1.5 + n);
            const [x0, y0] = p.x(x, y);
            const [cx, cy] = p.x((x + pl.x) / 2 + sag, (y + pl.y) / 2 + sag);
            const [x1, y1] = p.x(pl.x, pl.y);
            p.pen.strokeStyle = css(pl.c, Math.min(1, a));
            p.pen.lineWidth = Math.max(0.6, p.m(1.4));
            p.pen.beginPath();
            p.pen.moveTo(x0, y0);
            p.pen.quadraticCurveTo(cx, cy, x1, y1);
            p.pen.stroke();
            p.dot(x, y, 2.6, pl.c, Math.min(1, a * 1.8));
          });
          scene.places.forEach((pl, i) => p.glow(pl.x, pl.y, 30 + 50 * mass(i, t), pl.c, 0.8));
        }),
    };
  },
});

function hexRgba(hex: string): Rgba {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? 'ffffff';
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

/** Every place motion, in the preview's order. */
export const PLACE_MOTIONS: readonly PlaceMotionDef[] = M;
export const PLACE_MOTION_IDS = M.map((m) => m.id);
export function placeMotion(id: string): PlaceMotionDef | undefined {
  return M.find((m) => m.id === id);
}

/** Design units: metres per du on this table (1.25 table mm). */
export function placeUnit(metresPerTableMm: number): number {
  return 1.25 * metresPerTableMm;
}
