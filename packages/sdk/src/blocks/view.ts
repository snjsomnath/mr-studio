// The drawing surface of the visual blocks. A block never touches the map library or
// the DOM: it draws with a `Pen` (the part of a 2D canvas context it needs) through a
// `View`, which is the one place table metres become pixels. The same block therefore
// draws on the table, inside a magnifier at another scale, and in a test.

import type { Point, TableFrame } from './geo.ts';

/** The subset of `CanvasRenderingContext2D` the blocks use. */
export type Pen = Pick<
  CanvasRenderingContext2D,
  | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'arc' | 'rect' | 'fill' | 'stroke' | 'clip' | 'save' | 'restore'
  | 'fillText' | 'setLineDash' | 'createRadialGradient' | 'clearRect'
  | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineCap' | 'lineJoin' | 'globalAlpha' | 'globalCompositeOperation'
  | 'font' | 'textAlign' | 'textBaseline' | 'shadowColor' | 'shadowBlur' | 'shadowOffsetX' | 'shadowOffsetY' | 'lineDashOffset'
>;

export interface View {
  readonly pen: Pen;
  /** Pixels per metre. Sizes given in metres are multiplied by this; sizes in pixels are not. */
  readonly scale: number;
  /** Table metres to pixels. */
  toPx(point: Point): [number, number];
  /** Seconds since the layer started, for anything that animates. */
  readonly time: number;
  /** Multiplies pixel sizes (line widths, radii, fonts), e.g. inside a magnifier. */
  readonly detail: number;
}

/**
 * How the table sits on a surface of `widthPx` by `heightPx`: as large as fits, centred.
 * This is the one place table metres become surface pixels. The runtime fits the map the
 * same way, and when calibration lands it changes here and nowhere else.
 */
export function fitTable(frame: Pick<TableFrame, 'width' | 'height'>, widthPx: number, heightPx: number): { scale: number; x: number; y: number } {
  const scale = Math.min(widthPx / frame.width, heightPx / frame.height);
  return { scale, x: (widthPx - frame.width * scale) / 2, y: (heightPx - frame.height * scale) / 2 };
}

/** A view that fits the whole table onto a surface. Without a height the table is taken to fill the width. */
export function tableView(pen: Pen, frame: Pick<TableFrame, 'width' | 'height'>, widthPx: number, time = 0, heightPx = (widthPx * frame.height) / frame.width): View {
  const fit = fitTable(frame, widthPx, heightPx);
  return { pen, scale: fit.scale, time, detail: 1, toPx: ([x, y]) => [fit.x + x * fit.scale, fit.y + y * fit.scale] };
}

/**
 * A view of the same scene magnified around a point, as a lens sees it: `centre`
 * stays where it is on the surface and everything around it is `zoom` times larger.
 */
export function zoomedView(view: View, centre: Point, zoom: number): View {
  const [cx, cy] = view.toPx(centre);
  return {
    pen: view.pen,
    scale: view.scale * zoom,
    time: view.time,
    detail: view.detail * Math.sqrt(zoom),
    toPx: (point) => {
      const [x, y] = view.toPx(point);
      return [cx + (x - cx) * zoom, cy + (y - cy) * zoom];
    },
  };
}

export interface CanvasSurface {
  /** A view for this frame. Resizes the backing store to the element and clears it. */
  begin(time: number): View;
  readonly canvas: HTMLCanvasElement;
}

/**
 * Puts a canvas inside a table decoration (`ctx.map.addElement()`) and returns views
 * onto it. The canvas follows the element's size and the screen's pixel density.
 */
export function canvasSurface(container: HTMLElement, frame: TableFrame): CanvasSurface {
  const canvas = container.ownerDocument.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  container.append(canvas);
  const context = canvas.getContext('2d')!;
  return {
    canvas,
    begin(time) {
      const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.clearRect(0, 0, width, height);
      const view = tableView(context, frame, width, time, height);
      return { ...view, detail: ratio };
    },
  };
}
