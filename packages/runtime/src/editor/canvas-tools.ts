/**
 * The canvas toolbar (#60): which surface fills the middle of the editor (the map, the
 * controller or both), how big the map is drawn (fit, the projector's own pixels, or zoomed in),
 * and the table's outline and tile seams over the map. Panning a zoomed map is the scroll wheel,
 * space and drag, or the middle button.
 */
import type { SiteInfo } from '@mrstudio/sdk';

import { el } from '../controls.ts';
import { keys, mac } from './file-menu.ts';
import { icon } from './icons.ts';
import { typing } from './tree-tools.ts';

export type SurfaceView = 'map' | 'controller' | 'both';

const VIEW_KEY = 'mrs-canvas-view';
const OUTLINE_KEY = 'mrs-canvas-outline';
/** Zoom steps, as a share of the projector's own width. */
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Wider than this the browser cannot draw the map in one piece. */
const MAX_WIDTH = 4096;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage off: the choice lasts until the editor closes.
  }
}

export interface CanvasHost {
  site: () => SiteInfo;
  /** The element holding both surfaces; gets `is-map-only` or `is-controller-only`. */
  surfaces: HTMLElement;
  /** The map's element, holding the `.table-frame`. */
  canvas: HTMLElement;
}

export class CanvasTools {
  readonly element = el('div', 'ed-canvas-tools');
  view: SurfaceView;
  /** `fit`, or the map's width as a share of the projector's. */
  private zoom: number | 'fit' = 'fit';
  private outline: boolean;
  /** The context needs the controller alone (Controller, Table settings). */
  private forced = false;
  private readonly host: CanvasHost;
  private readonly views = new Map<SurfaceView, HTMLButtonElement>();
  private readonly zoomLabel = el('button', 'ed-zoom-label');
  private readonly outlineButton: HTMLButtonElement;
  private readonly mapTools = el('div', 'ed-canvas-group');
  private overlay: SVGSVGElement | null = null;

  constructor(host: CanvasHost) {
    this.host = host;
    const view = stored(VIEW_KEY);
    this.view = view === 'map' || view === 'controller' ? view : 'both';
    this.outline = stored(OUTLINE_KEY) === 'on';

    const views = el('div', 'segmented ed-canvas-views');
    views.setAttribute('role', 'radiogroup');
    views.ariaLabel = 'Show in the middle';
    const option = (value: SurfaceView, label: string, iconName: string, tip: string) => {
      const node = el('button', 'ed-canvas-view');
      node.type = 'button';
      node.setAttribute('role', 'radio');
      node.append(icon(iconName, 14), el('span', undefined, label));
      node.title = tip;
      node.addEventListener('click', () => this.setView(value));
      this.views.set(value, node);
      views.append(node);
    };
    option('map', 'Map', 'table', 'The map alone, as big as the window allows');
    option('controller', 'Controller', 'tv', 'The controller alone');
    option('both', 'Both', 'grid', 'The map and the controller together');

    const tool = (iconName: string, tip: string, run: () => void) => {
      const node = el('button', 'ed-icon-button ed-canvas-tool');
      node.type = 'button';
      node.title = tip;
      node.ariaLabel = tip;
      node.append(icon(iconName, 14));
      node.addEventListener('click', run);
      return node;
    };
    const out = tool('minus', `Zoom out (${keys('−')})`, () => this.step(-1));
    const into = tool('plus', `Zoom in (${keys('+')})`, () => this.step(1));
    this.zoomLabel.type = 'button';
    this.zoomLabel.title = `Fit the whole table (${keys('0')}). Click again for the projector's own pixels (${keys('1')}).`;
    this.zoomLabel.addEventListener('click', () => this.setZoom(this.zoom === 'fit' ? 1 : 'fit'));
    this.outlineButton = tool('grid', 'The table outline and tile seams over the map', () => this.setOutline(!this.outline));
    this.outlineButton.classList.add('is-toggle');
    this.mapTools.append(out, this.zoomLabel, into, this.outlineButton);
    this.element.append(views, this.mapTools);

    this.listen();
    this.apply();
  }

  /** The Controller and Table settings contexts show the controller alone, whatever the choice. */
  force(controllerOnly: boolean): void {
    this.forced = controllerOnly;
    this.apply();
  }

  setView(view: SurfaceView): void {
    this.view = view;
    this.forced = false;
    store(VIEW_KEY, view);
    this.apply();
  }

  private setOutline(on: boolean): void {
    this.outline = on;
    store(OUTLINE_KEY, on ? 'on' : 'off');
    this.drawOutline();
  }

  /** The projector's width in pixels, which 100 % shows the map at. */
  private projectorWidth(): number {
    return this.host.site().calibration?.window?.width_px ?? 1920;
  }

  private fitWidth(): number {
    return this.surface()?.getBoundingClientRect().width || this.projectorWidth() / 2;
  }

  private step(direction: 1 | -1): void {
    const now = this.zoom === 'fit' ? this.fitWidth() / this.projectorWidth() : this.zoom;
    const next = direction > 0 ? STEPS.find((s) => s > now * 1.01) : [...STEPS].reverse().find((s) => s < now * 0.99);
    if (next === undefined) return;
    // Zooming out past the window's size is the same as fitting.
    if (direction < 0 && next * this.projectorWidth() <= this.fitArea().width) this.setZoom('fit');
    else this.setZoom(next);
  }

  setZoom(zoom: number | 'fit', around?: { x: number; y: number }): void {
    const frame = this.frame();
    const before = frame && around ? { left: frame.scrollLeft, top: frame.scrollTop, width: this.surface()!.offsetWidth } : null;
    this.zoom = zoom === 'fit' ? 'fit' : Math.min(zoom, MAX_WIDTH / this.projectorWidth());
    this.apply();
    // Zooming with the wheel keeps the spot under the pointer where it was.
    if (frame && before && around && this.zoom !== 'fit') {
      const ratio = this.surface()!.offsetWidth / before.width;
      frame.scrollLeft = (before.left + around.x) * ratio - around.x;
      frame.scrollTop = (before.top + around.y) * ratio - around.y;
    }
  }

  private frame(): HTMLElement | null {
    return this.host.canvas.querySelector<HTMLElement>('.table-frame');
  }
  private surface(): HTMLElement | null {
    return this.host.canvas.querySelector<HTMLElement>('.table-surface');
  }
  private fitArea(): DOMRect {
    return this.host.canvas.getBoundingClientRect();
  }

  /** Shows the chosen surfaces and draws the map at the chosen size. */
  apply(): void {
    const view = this.forced ? 'controller' : this.view;
    this.host.surfaces.classList.toggle('is-controller-only', view === 'controller');
    this.host.surfaces.classList.toggle('is-map-only', view === 'map');
    for (const [value, node] of this.views) node.setAttribute('aria-checked', String(value === view));
    this.mapTools.hidden = view === 'controller';
    const frame = this.frame();
    const surface = this.surface();
    if (frame && surface) {
      const zoomed = this.zoom !== 'fit';
      frame.classList.toggle('is-zoomed', zoomed);
      if (zoomed) {
        const width = Math.round((this.zoom as number) * this.projectorWidth());
        surface.style.setProperty('--zoom-width', `${width}px`);
      } else surface.style.removeProperty('--zoom-width');
    }
    this.zoomLabel.textContent = this.zoom === 'fit' ? 'Fit' : `${Math.round((this.zoom as number) * 100)} %`;
    this.outlineButton.setAttribute('aria-pressed', String(this.outline));
    const table = this.host.site().table;
    this.outlineButton.disabled = !table;
    this.outlineButton.title = table
      ? `The table's outline${table.tile_cm ? ` and its ${table.tile_cm} cm tiles` : ''} over the map`
      : 'The table has no size yet. Set it in Table settings to see its outline and tiles.';
    this.drawOutline();
  }

  /** The table's edge and its tile seams, drawn over the map, so the author sees where they fall. */
  private drawOutline(): void {
    const surface = this.surface();
    const table = this.host.site().table;
    if (!surface || !table || !this.outline) {
      this.overlay?.remove();
      this.overlay = null;
      this.outlineButton.setAttribute('aria-pressed', String(this.outline && Boolean(table)));
      return;
    }
    this.outlineButton.setAttribute('aria-pressed', 'true');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = (this.overlay ??= document.createElementNS(ns, 'svg'));
    svg.setAttribute('class', 'ed-outline');
    svg.setAttribute('viewBox', `0 0 ${table.width_cm} ${table.height_cm}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.replaceChildren();
    const line = (x1: number, y1: number, x2: number, y2: number, edge = false) => {
      const node = document.createElementNS(ns, 'line');
      for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) node.setAttribute(k, String(v));
      node.setAttribute('class', edge ? 'is-edge' : 'is-seam');
      node.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(node);
    };
    const tile = table.tile_cm;
    if (tile && tile > 0) {
      for (let x = tile; x < table.width_cm - 0.5; x += tile) line(x, 0, x, table.height_cm);
      for (let y = tile; y < table.height_cm - 0.5; y += tile) line(0, y, table.width_cm, y);
    }
    const rect = document.createElementNS(ns, 'rect');
    for (const [k, v] of Object.entries({ x: 0, y: 0, width: table.width_cm, height: table.height_cm })) rect.setAttribute(k, String(v));
    rect.setAttribute('class', 'is-edge');
    rect.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(rect);
    if (!svg.isConnected) surface.append(svg);
  }

  private listen(): void {
    const { canvas } = this.host;
    // Zoom keys, unless a field has the focus or a dialog is open.
    window.addEventListener('keydown', (event) => {
      if (typing(event) || document.querySelector('dialog[open]')) return;
      const mod = mac ? event.metaKey : event.ctrlKey;
      if (event.code === 'Space') {
        if (canvas.matches(':hover') && this.zoom !== 'fit') {
          event.preventDefault();
          canvas.classList.add('is-panning');
        }
        return;
      }
      if (!mod || event.altKey) return;
      if (event.key === '=' || event.key === '+') this.step(1);
      else if (event.key === '-') this.step(-1);
      else if (event.key === '0') this.setZoom('fit');
      else if (event.key === '1' && !event.shiftKey) this.setZoom(1);
      else return;
      event.preventDefault();
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space') canvas.classList.remove('is-panning');
    });
    // Cmd/Ctrl and the wheel (or a pinch on a trackpad) zoom around the pointer.
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        const frame = this.frame();
        if (!frame) return;
        const now = this.zoom === 'fit' ? this.fitWidth() / this.projectorWidth() : this.zoom;
        const next = Math.max(STEPS[0]!, Math.min(STEPS.at(-1)!, now * Math.exp(-event.deltaY * 0.01)));
        const box = frame.getBoundingClientRect();
        if (next * this.projectorWidth() <= this.fitArea().width) this.setZoom('fit');
        else this.setZoom(next, { x: event.clientX - box.left, y: event.clientY - box.top });
      },
      { passive: false },
    );
    // Drag to pan with space held or the middle button. A plain click goes to the layers, as on the table.
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        const frame = this.frame();
        if (!frame) return;
        if (event.button !== 1 && !canvas.classList.contains('is-panning')) return;
        drag = { x: event.clientX, y: event.clientY, left: frame.scrollLeft, top: frame.scrollTop };
        event.preventDefault();
        event.stopPropagation();
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add('is-grabbing');
      },
      { capture: true },
    );
    canvas.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const frame = this.frame();
      if (!frame) return;
      frame.scrollLeft = drag.left - (event.clientX - drag.x);
      frame.scrollTop = drag.top - (event.clientY - drag.y);
    });
    canvas.addEventListener('pointerup', () => {
      drag = null;
      canvas.classList.remove('is-grabbing');
    });
    canvas.addEventListener('auxclick', (event) => event.button === 1 && event.preventDefault());
  }
}
