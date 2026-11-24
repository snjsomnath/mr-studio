// A ready map of the site for a layer's own stage on the controller (#283). It draws the table's
// outline and the site's datasets in the table's own orientation, and turns taps into points,
// lines or areas for tool inputs. A layer adds its own visual on top in `draw`, so a team builds
// on a map rather than a map app. The table stays the picture: this map is for choosing.

import type { PanelContext } from './layer.ts';
import { geojsonLines, geojsonPoints, geojsonPolygons, readSiteData, tableSpace } from './table-space.ts';
import type { Placed, TableSpace, XY } from './table-space.ts';
import type { Position, ToolGeometry } from './types.ts';

/** A site dataset drawn under the layer's own drawing. Colours are CSS; default from the controller's theme. */
export interface ControllerMapData {
  name: string;
  fill?: string;
  stroke?: string;
  /** Line width in CSS pixels. Default 1.5. */
  width?: number;
  /** Point radius in CSS pixels. Default 3. */
  radius?: number;
}

/** What a tap does: `pick` gives a point, `line` and `polygon` add corners until `points` are placed or `finish()`. */
export type ControllerMapMode = 'pick' | 'line' | 'polygon' | 'none';

export interface ControllerMapOptions {
  /** Datasets drawn bottom first. Default: the site's `roads` and `buildings`, when it has them. */
  data?: ControllerMapData[];
  mode?: ControllerMapMode;
  /** For `line` and `polygon`: finish by itself once this many corners are placed, such as 2 for a route from A to B. */
  points?: number;
  /** A tap in `pick` mode, in WGS84 and table metres. */
  onPick?(at: Position, xy: XY): void;
  /** A finished line or area, as a tool input's geometry. */
  onDraw?(geometry: ToolGeometry): void;
  /** Draws the layer's own visual over the data, in CSS pixels; use `map.toScreen` and `map.project`. Called on every redraw. */
  draw?(g: CanvasRenderingContext2D, map: ControllerMap): void;
}

export interface ControllerMap {
  readonly canvas: HTMLCanvasElement;
  /** The table in metres: what `toScreen` takes. */
  readonly space: TableSpace;
  /** Corners placed so far in `line` or `polygon` mode, in WGS84. */
  readonly drawing: readonly Position[];
  /** Table metres to canvas CSS pixels. */
  toScreen(xy: XY): [number, number];
  /** WGS84 to canvas CSS pixels. */
  project(at: Position | readonly number[]): [number, number];
  /** Canvas CSS pixels to WGS84. */
  unproject(x: number, y: number): Position;
  setMode(mode: ControllerMapMode, points?: number): void;
  /** Ends a line or area being drawn and hands it to `onDraw`. Nothing happens with too few corners. */
  finish(): void;
  /** Drops the corners placed so far. */
  cancel(): void;
  /** Draws again on the next frame, after the layer's own state changed. */
  redraw(): void;
  remove(): void;
}

/** A press shorter and smaller than this is a tap. */
const TAP_MS = 500;
const TAP_PX = 10;

/**
 * A map of the site in `el`, filling it, for a layer's `stage` (or hero) on the controller. Released
 * with `ctx.onCleanup`. Taps reach the table through the layer: send them on with `ctx.sendTool`.
 */
export function controllerMap(el: HTMLElement, ctx: Pick<PanelContext, 'site' | 'onCleanup'>, options: ControllerMapOptions = {}): ControllerMap {
  const space = tableSpace(ctx.site);
  const [tl, tr, , bl] = ctx.site.corners;
  const canvas = document.createElement('canvas');
  canvas.className = 'controller-map';
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' });
  el.append(canvas);
  const g = canvas.getContext('2d')!;

  let mode: ControllerMapMode = options.mode ?? 'pick';
  let points = options.points;
  let drawing: Position[] = [];
  let scale = 1;
  let offset: XY = [0, 0];
  let cssWidth = 0;
  let cssHeight = 0;
  let queued = false;
  let removed = false;

  const layers: { spec: ControllerMapData; polygons: Placed<XY[][]>[]; lines: Placed<XY[]>[]; points: Placed<XY>[] }[] = [];
  const wanted = options.data ?? ['roads', 'buildings'].filter((name) => ctx.site.data?.[name]).map((name) => ({ name }));
  void Promise.all(
    wanted.map(async (spec) => {
      const json = await readSiteData(ctx.site, spec.name);
      return { spec, polygons: geojsonPolygons(json, space), lines: geojsonLines(json, space), points: geojsonPoints(json, space) };
    }),
  ).then((loaded) => {
    layers.push(...loaded);
    map.redraw();
  });

  const toScreen = (xy: XY): [number, number] => [offset[0] + xy[0] * scale, offset[1] + xy[1] * scale];
  const fromScreen = (x: number, y: number): XY => [(x - offset[0]) / scale, (y - offset[1]) / scale];
  const toLonLat = ([x, y]: XY): Position => {
    const u = x / space.width;
    const v = y / space.height;
    return [tl[0] + u * (tr[0] - tl[0]) + v * (bl[0] - tl[0]), tl[1] + u * (tr[1] - tl[1]) + v * (bl[1] - tl[1])];
  };

  const theme = () => {
    const style = getComputedStyle(el);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return { text: read('--text', '#e6e9ef'), muted: read('--muted', '#9aa4b2'), line: read('--line', 'rgba(127,127,127,0.35)'), accent: read('--accent', '#ffb84d'), card: read('--card', 'rgba(127,127,127,0.08)') };
  };

  const paint = () => {
    queued = false;
    if (removed) return;
    const rect = el.getBoundingClientRect();
    cssWidth = Math.max(1, rect.width);
    cssHeight = Math.max(1, rect.height);
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
      canvas.width = Math.round(cssWidth * ratio);
      canvas.height = Math.round(cssHeight * ratio);
    }
    // The table fits with a margin, upright as it stands.
    const margin = 16;
    scale = Math.min((cssWidth - 2 * margin) / space.width, (cssHeight - 2 * margin) / space.height);
    offset = [(cssWidth - space.width * scale) / 2, (cssHeight - space.height * scale) / 2];
    const colours = theme();
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, cssWidth, cssHeight);
    const [x0, y0] = toScreen([0, 0]);
    g.save();
    g.beginPath();
    g.roundRect(x0, y0, space.width * scale, space.height * scale, 6);
    g.fillStyle = colours.card;
    g.fill();
    g.clip();
    for (const { spec, polygons, lines, points: dots } of layers) {
      g.lineWidth = spec.width ?? 1.5;
      g.fillStyle = spec.fill ?? colours.line;
      g.strokeStyle = spec.stroke ?? colours.line;
      for (const { geometry } of polygons) {
        g.beginPath();
        for (const ring of geometry) ring.forEach((p, i) => (i ? g.lineTo(...toScreen(p)) : g.moveTo(...toScreen(p))));
        g.fill('evenodd');
      }
      for (const { geometry } of lines) {
        g.beginPath();
        geometry.forEach((p, i) => (i ? g.lineTo(...toScreen(p)) : g.moveTo(...toScreen(p))));
        g.stroke();
      }
      for (const { geometry } of dots) {
        g.beginPath();
        g.arc(...toScreen(geometry), spec.radius ?? 3, 0, Math.PI * 2);
        g.fill();
      }
    }
    try {
      options.draw?.(g, map);
    } catch (error) {
      console.error('controller map draw', error);
    }
    g.restore();
    g.lineWidth = 1.5;
    g.strokeStyle = colours.muted;
    g.beginPath();
    g.roundRect(x0, y0, space.width * scale, space.height * scale, 6);
    g.stroke();
    // Corners being placed: a line through them and a dot at each.
    if (drawing.length > 0) {
      g.strokeStyle = colours.accent;
      g.fillStyle = colours.accent;
      g.lineWidth = 3;
      g.setLineDash([8, 6]);
      g.beginPath();
      drawing.forEach((p, i) => (i ? g.lineTo(...map.project(p)) : g.moveTo(...map.project(p))));
      if (mode === 'polygon' && drawing.length > 2) g.closePath();
      g.stroke();
      g.setLineDash([]);
      for (const p of drawing) {
        g.beginPath();
        g.arc(...map.project(p), 7, 0, Math.PI * 2);
        g.fill();
      }
    }
  };

  const map: ControllerMap = {
    canvas,
    space,
    get drawing() {
      return drawing;
    },
    toScreen,
    project: (at) => toScreen(space.toTable(at[0]!, at[1]!)),
    unproject: (x, y) => toLonLat(fromScreen(x, y)),
    setMode(next, count) {
      mode = next;
      points = count;
      drawing = [];
      map.redraw();
    },
    finish() {
      const least = mode === 'polygon' ? 3 : 2;
      if ((mode !== 'line' && mode !== 'polygon') || drawing.length < least) return;
      const done = drawing;
      drawing = [];
      map.redraw();
      options.onDraw?.(mode === 'line' ? { type: 'LineString', coordinates: done } : { type: 'Polygon', coordinates: [[...done, done[0]!]] });
    },
    cancel() {
      drawing = [];
      map.redraw();
    },
    redraw() {
      if (queued || removed) return;
      queued = true;
      requestAnimationFrame(paint);
    },
    remove() {
      removed = true;
      observer.disconnect();
      canvas.remove();
    },
  };

  let press: { x: number; y: number; time: number } | null = null;
  canvas.addEventListener('pointerdown', (event) => {
    press = { x: event.offsetX, y: event.offsetY, time: performance.now() };
  });
  canvas.addEventListener('pointerup', (event) => {
    const start = press;
    press = null;
    if (!start || performance.now() - start.time > TAP_MS || Math.hypot(event.offsetX - start.x, event.offsetY - start.y) > TAP_PX) return;
    const xy = fromScreen(event.offsetX, event.offsetY);
    if (xy[0] < 0 || xy[1] < 0 || xy[0] > space.width || xy[1] > space.height) return;
    const at = toLonLat(xy);
    if (mode === 'pick') options.onPick?.(at, xy);
    if (mode === 'line' || mode === 'polygon') {
      drawing = [...drawing, at];
      if (points !== undefined && drawing.length >= points) map.finish();
      else map.redraw();
    }
  });

  const observer = new ResizeObserver(() => map.redraw());
  observer.observe(el);
  ctx.onCleanup(() => map.remove());
  map.redraw();
  return map;
}
