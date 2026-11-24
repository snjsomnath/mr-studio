// A pad with the table's shape on the controller (#287, #288): the buildings drawn faintly, and
// whatever the layer marks on it (a glass, a line). Dragging on it gives places on the table, as
// fractions of its width and height, so a hero moves something on the table without a map.
import type { PanelContext } from './layer.ts';
import { geojsonPolygons, readSiteData, tableSpace } from './table-space.ts';

export interface TablePadBox {
  /** Where the table is on the pad's canvas, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TablePadOptions {
  /** Draws the layer's marks over the table, in the pad's CSS pixels. Called again by `redraw()`. */
  draw(g: CanvasRenderingContext2D, box: TablePadBox): void;
  /** A press, a drag and a release on the pad: where, as fractions of the table (0 to 1, left to right, top to bottom). */
  onDrag(at: [number, number], phase: 'down' | 'move' | 'up'): void;
  /** One line under the pad, such as "Drag to move the glass". */
  caption?: string;
  /** How the pad looks to a screen reader. */
  label?: string;
}

const STYLE = `
.mrs-pad { position: relative; border-radius: 1.125rem; overflow: hidden; color: #fff; user-select: none; touch-action: none;
  background: radial-gradient(120% 100% at 50% 0%, #1d2233 0%, #10131d 60%, #0a0c14 100%);
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); }
.mrs-pad canvas { display: block; width: 100%; height: clamp(14rem, 38vh, 28rem); cursor: grab; }
.mrs-pad canvas:active { cursor: grabbing; }
.mrs-pad canvas:focus-visible { outline: 3px solid rgb(255 255 255 / 0.6); outline-offset: -3px; }
.mrs-pad p { position: absolute; left: 0; right: 0; bottom: 0; margin: 0; padding: 0.9rem 1.5rem; font-size: 1rem; opacity: 0.85; text-align: center;
  background: linear-gradient(rgb(6 8 16 / 0), rgb(6 8 16 / 0.7)); pointer-events: none; }
`;

/**
 * Draws a table pad into a hero's element. The buildings come from the table's `buildings`
 * dataset when it has one. Returns `redraw()` for when the marks changed (params arrived).
 */
export function tablePad(ctx: Pick<PanelContext, 'site' | 'onCleanup'>, el: HTMLElement, options: TablePadOptions): { redraw(): void; canvas: HTMLCanvasElement } {
  el.innerHTML = `<style>${STYLE}</style>`;
  const root = document.createElement('div');
  root.className = 'mrs-pad';
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-label', options.label ?? 'The table');
  root.append(canvas);
  if (options.caption) {
    const caption = document.createElement('p');
    caption.textContent = options.caption;
    root.append(caption);
  }
  el.append(root);
  const g = canvas.getContext('2d')!;
  const { width_m, height_m } = ctx.site.extent;
  let buildings: [number, number][][][] = [];
  let frame = 0;

  const box = (): TablePadBox => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const scale = Math.min((w - 32) / width_m, (h - 48) / height_m);
    return { x: (w - width_m * scale) / 2, y: (h - 48 - height_m * scale) / 2 + 8, width: width_m * scale, height: height_m * scale };
  };

  const draw = () => {
    frame = 0;
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    const b = box();
    g.fillStyle = 'rgb(255 255 255 / 0.04)';
    g.strokeStyle = 'rgb(255 255 255 / 0.22)';
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(b.x, b.y, b.width, b.height, 6);
    g.fill();
    g.stroke();
    g.save();
    g.beginPath();
    g.rect(b.x, b.y, b.width, b.height);
    g.clip();
    g.fillStyle = 'rgb(255 255 255 / 0.16)';
    const sx = b.width / width_m;
    const sy = b.height / height_m;
    g.beginPath();
    for (const rings of buildings) {
      for (const ring of rings) {
        ring.forEach(([x, y], k) => (k === 0 ? g.moveTo(b.x + x * sx, b.y + y * sy) : g.lineTo(b.x + x * sx, b.y + y * sy)));
        g.closePath();
      }
    }
    g.fill('evenodd');
    g.restore();
    options.draw(g, b);
  };
  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  void readSiteData(ctx.site, 'buildings').then((geojson) => {
    if (!geojson) return;
    const space = tableSpace(ctx.site);
    buildings = geojsonPolygons(geojson, space).map((p) => p.geometry as [number, number][][]);
    redraw();
  });

  const at = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    const b = box();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [clamp((event.clientX - rect.left - b.x) / b.width), clamp((event.clientY - rect.top - b.y) / b.height)];
  };
  let pointer: number | null = null;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer !== null) return;
    pointer = event.pointerId;
    canvas.setPointerCapture(pointer);
    options.onDrag(at(event), 'down');
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointer) options.onDrag(at(event), 'move');
  });
  const end = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    options.onDrag(at(event), 'up');
    pointer = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  const observer = new ResizeObserver(redraw);
  observer.observe(canvas);
  ctx.onCleanup(() => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  });
  redraw();
  return { redraw, canvas };
}
