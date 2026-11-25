// Snap a drawing to the buildings (#379): fit a Masterplan's frame to the table's footprints, as
// the 3D model import's "Snap to buildings" does (#56). The drawing's lines are compared with
// the footprints' outlines: the frame is moved, turned (a few degrees) and scaled (±15 %) until
// as many points of the outlines as it can land on the drawing's lines.
import { geojsonPolygons, readSiteData, siteDataUrl, tableSpace } from '@mrstudio/sdk';
import type { SiteInfo } from '@mrstudio/sdk';

type Point = [number, number];
/** The drawing's top left, top right and bottom left, in table metres. */
export type Frame = [Point, Point, Point];

/** Where a drawing has lines: `edges[y * width + x]` is 1 on a line, the picture as the frame shows it. */
export interface Ink {
  width: number;
  height: number;
  edges: Uint8Array;
}

export interface FrameFit {
  frame: Frame;
  /** Share of the outline points on the drawing's lines, before and after. */
  before: number;
  after: number;
}

/** Turns, in degrees, and scale the search may go to from where the frame is now. */
const TURN_DEG = 3;
const SCALE = 0.15;

/** Share of `points` (table metres) that land on the drawing's lines inside `frame`; points outside it don't count. */
export function frameScore(ink: Ink, frame: Frame, points: readonly Point[]): number {
  const [tl, tr, bl] = frame;
  const ax = tr[0] - tl[0];
  const ay = tr[1] - tl[1];
  const bx = bl[0] - tl[0];
  const by = bl[1] - tl[1];
  const det = ax * by - ay * bx;
  if (Math.abs(det) < 1e-9) return 0;
  let inside = 0;
  let hit = 0;
  for (const [x, y] of points) {
    const dx = x - tl[0];
    const dy = y - tl[1];
    const u = (dx * by - dy * bx) / det;
    const v = (ax * dy - ay * dx) / det;
    if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
    inside++;
    if (ink.edges[Math.floor(v * ink.height) * ink.width + Math.floor(u * ink.width)]) hit++;
  }
  // Too few points inside: a frame shrunk off the buildings is no fit.
  return inside < Math.max(20, points.length * 0.05) ? 0 : hit / inside;
}

const middleOf = ([tl, tr, bl]: Frame): Point => [(tr[0] + bl[0]) / 2, (tr[1] + bl[1]) / 2];

/** `frame` moved by (dx, dy), turned by `degrees` and grown by `factor`, about its middle. */
function adjust(frame: Frame, dx: number, dy: number, degrees: number, factor: number): Frame {
  const [mx, my] = middleOf(frame);
  const [c, s] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
  return frame.map(([x, y]) => {
    const [px, py] = [(x - mx) * factor, (y - my) * factor];
    return [mx + dx + px * c - py * s, my + dy + px * s + py * c] as Point;
  }) as Frame;
}

/**
 * Searches near `start` for the frame that puts the most outline points on the drawing's lines:
 * a coarse grid of moves first, then smaller and smaller steps of move, turn and scale.
 */
export function fitFrame(ink: Ink, start: Frame, points: readonly Point[]): FrameFit {
  const before = frameScore(ink, start, points);
  const [tl, tr, bl] = start;
  const size = Math.max(Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), Math.hypot(bl[0] - tl[0], bl[1] - tl[1]));
  // The state is relative to the start: move, turn, scale.
  let best = { dx: 0, dy: 0, turn: 0, scale: 1, score: before };
  const consider = (dx: number, dy: number, turn: number, scale: number) => {
    if (Math.abs(turn) > TURN_DEG || Math.abs(scale - 1) > SCALE) return;
    const score = frameScore(ink, adjust(start, dx, dy, turn, scale), points);
    if (score > best.score + 1e-9) best = { dx, dy, turn, scale, score };
  };
  // Moves up to a tenth of the drawing's size, at each of a few scales.
  const reach = size * 0.1;
  const coarse = reach / 6;
  for (const scale of [0.9, 1, 1.1]) {
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) consider(i * coarse, j * coarse, 0, scale);
  }
  let step = { move: coarse / 2, turn: 1, scale: 0.02 };
  for (let round = 0; round < 7; round++) {
    let moved = true;
    while (moved) {
      moved = false;
      const was = best;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) consider(was.dx + dx * step.move, was.dy + dy * step.move, was.turn, was.scale);
      for (const d of [1, -1]) {
        consider(was.dx, was.dy, was.turn + d * step.turn, was.scale);
        consider(was.dx, was.dy, was.turn, was.scale + d * step.scale);
      }
      moved = best !== was;
    }
    step = { move: step.move / 2, turn: step.turn / 2, scale: step.scale / 2 };
  }
  return { frame: adjust(start, best.dx, best.dy, best.turn, best.scale), before, after: best.score };
}

/** Points along the footprints' outlines, in table metres, about `spacing` apart (at most `limit`). */
export function outlinePoints(rings: readonly (readonly Point[])[], spacing: number, limit = 6000): Point[] {
  const points: Point[] = [];
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1]!, ring[i]!];
      const steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing));
      for (let k = 0; k < steps; k++) points.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]);
    }
  }
  if (points.length <= limit) return points;
  return Array.from({ length: limit }, (_, k) => points[Math.floor(((k + 0.5) * points.length) / limit)]!);
}

/** Where a picture has lines: pixels whose opacity or brightness changes sharply, grown by one pixel. */
export function inkEdges(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const value = (i: number) => (data[i * 4 + 3]! / 255) * (1 - (data[i * 4]! + data[i * 4 + 1]! + data[i * 4 + 2]!) / 765 / 2);
  const edge = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const here = value(i);
      if (Math.abs(here - value(i + 1)) > 0.12 || Math.abs(here - value(i + width)) > 0.12 || Math.abs(here - value(i - 1)) > 0.12 || Math.abs(here - value(i - width)) > 0.12) edge[i] = 1;
    }
  }
  const grown = new Uint8Array(edge);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!edge[y * width + x]) continue;
      grown[y * width + x - 1] = grown[y * width + x + 1] = grown[(y - 1) * width + x] = grown[(y + 1) * width + x] = 1;
    }
  }
  return grown;
}

/** The drawing's lines, read in a browser: the SVG pictured `width` across and turned `turn` quarter turns, as the frame shows it. */
export async function loadInk(site: SiteInfo, dataset: string, turn: number, width = 900): Promise<Ink> {
  const name = dataset || Object.entries(site.data ?? {}).find(([, path]) => String(path).toLowerCase().endsWith('.svg'))?.[0];
  const url = name ? siteDataUrl(site, name) : null;
  if (!url) throw new Error('the table has no drawing');
  const text = await (await fetch(url)).text();
  const image = new Image();
  const blob = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    image.src = blob;
    await image.decode();
  } finally {
    URL.revokeObjectURL(blob);
  }
  const quarters = ((Math.round(turn / 90) % 4) + 4) % 4;
  const [w0, h0] = [image.naturalWidth || 1000, image.naturalHeight || 1000];
  const odd = quarters % 2 === 1;
  const shownAspect = odd ? h0 / w0 : w0 / h0;
  const height = Math.max(1, Math.round(width / shownAspect));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.translate(width / 2, height / 2);
  g.rotate((quarters * Math.PI) / 2);
  const [dw, dh] = odd ? [height, width] : [width, height];
  g.drawImage(image, -dw / 2, -dh / 2, dw, dh);
  return { width, height, edges: inkEdges(g.getImageData(0, 0, width, height).data, width, height) };
}

/** The table's footprint outlines in table metres. */
export async function loadOutlines(site: SiteInfo): Promise<Point[][]> {
  const polygons = geojsonPolygons(await readSiteData(site, 'buildings'), tableSpace(site));
  return polygons.flatMap((p) => p.geometry as Point[][]);
}
