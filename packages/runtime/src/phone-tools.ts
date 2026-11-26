import { lonLatToTable, tableToLonLat } from '@mrstudio/sdk';
import type { Connection, LayerManifest, Position, SiteInfo, ToolGeometry, ToolSpec } from '@mrstudio/sdk';

import { t } from './i18n.ts';
import type { Store } from './store.ts';

/**
 * Milliseconds between a phone's repeated requests (a dragged slider, a dragged point).
 * The host accepts 20 requests a second from a phone; this keeps one stream at about 12.
 */
export const PHONE_SEND_INTERVAL = 80;

const SVG = 'http://www.w3.org/2000/svg';
const NOUN: Record<ToolSpec['type'], string> = { point: 'Point', line: 'Line', polygon: 'Area' };
const HINT: Record<ToolSpec['type'], string> = {
  point: 'Tap or drag on the map. Two fingers move the map.',
  line: 'Tap to add points along the line, then send. Two fingers move the map.',
  polygon: 'Tap the corners of the area, then send. Two fingers move the map.',
};
/** Corners a line or an area needs before it can be sent. */
const LEAST: Record<ToolSpec['type'], number> = { point: 1, line: 2, polygon: 3 };
/** The most corners the pad lets one drawing have. The host's own limit is higher. */
const MOST = 60;

/** The field for an action's words (#462). */
export function wordsField(words: { prompt?: string; max?: number }): HTMLInputElement {
  const input = el('input', 'words');
  Object.assign(input, { type: 'text', maxLength: words.max ?? 120, placeholder: t(words.prompt ?? 'A few words'), enterKeyHint: 'send', autocomplete: 'off' });
  input.setAttribute('aria-label', t(words.prompt ?? 'A few words'));
  return input;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/** The site's building footprints as rings in table coordinates. Fetched once per page. */
let footprints: Promise<[number, number][][]> | null = null;
export function loadFootprints(site: SiteInfo): Promise<[number, number][][]> {
  if (!site.data.buildings) return Promise.resolve([]);
  footprints ??= fetch(`/site/${site.data.buildings}`)
    .then((response) => response.json())
    .then((collection: { features?: { geometry?: { type: string; coordinates: unknown } }[] }) => {
      const rings: [number, number][][] = [];
      for (const feature of collection.features ?? []) {
        const geometry = feature.geometry;
        if (!geometry) continue;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        for (const polygon of polygons as Position[][][]) {
          for (const ring of polygon) rings.push(ring.map(([lon, lat]) => lonLatToTable(site, lon, lat)));
        }
      }
      return rings;
    })
    .catch(() => []);
  return footprints;
}

/** The geometry a tool sends for corners given in table coordinates. */
export function toolGeometry(site: SiteInfo, type: ToolSpec['type'], corners: [number, number][]): ToolGeometry {
  const positions = corners.map(([u, v]) => tableToLonLat(site, u, v).map((value) => Math.round(value * 1e7) / 1e7) as Position);
  if (type === 'point') return { type: 'Point', coordinates: positions[0]! };
  if (type === 'line') return { type: 'LineString', coordinates: positions };
  return { type: 'Polygon', coordinates: [[...positions, positions[0]!]] };
}

/** The light base map under a phone's map (#335), from the host's tile cache. */
const TILES = 'osm';
/** A view of the phone's map: the part of the table shown, in metres. */
interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function tileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}
function tileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z;
}
function tileLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}
function tileLat(y: number, z: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
}

/**
 * Thins a finger's stroke to at most `most` corners, keeping its ends (#335: the pen).
 * Corners closer than `gap` to the last one kept are dropped first.
 */
export function thin(points: [number, number][], most: number, gap = 0): [number, number][] {
  if (points.length <= 2) return points;
  let kept = [points[0]!];
  for (const point of points.slice(1, -1)) {
    const last = kept[kept.length - 1]!;
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= gap) kept.push(point);
  }
  kept.push(points[points.length - 1]!);
  if (kept.length > most) {
    const step = (kept.length - 1) / (most - 1);
    kept = Array.from({ length: most }, (_, i) => kept[Math.round(i * step)]!);
  }
  return kept;
}

/**
 * A phone's map of the table (#335). It draws a light base map, the buildings and the table's
 * edge, and the shape being drawn. Two fingers pan and zoom; Fit table goes back to the whole
 * table; the corner button opens it full screen. One finger uses the layer's tool: finger
 * positions become table coordinates and, through the site's corners, WGS84.
 */
class ToolPad {
  readonly element: HTMLElement;
  private tool: ToolSpec;
  private corners: [number, number][] = [];
  private dragging = false;
  private lastSent = -Infinity;
  private trailing: number | undefined;
  private readonly width: number;
  private readonly height: number;
  private view: ViewBox;
  private readonly map: SVGSVGElement;
  private readonly tiles: SVGGElement;
  private readonly drawing: SVGGElement;
  private readonly hint: HTMLElement;
  private readonly undo: HTMLButtonElement;
  private readonly clear: HTMLButtonElement;
  private readonly done: HTMLButtonElement;
  private readonly actions: HTMLElement;
  private readonly site: SiteInfo;
  private readonly colour: () => string;
  private readonly send: (tool: ToolSpec, geometry: ToolGeometry) => Promise<void>;
  /** Fingers on the map, for two-finger pan and zoom. */
  private readonly fingers = new Map<number, [number, number]>();
  private gesture: { view: ViewBox; mid: [number, number]; spread: number } | null = null;
  private tilesDue = 0;
  private shownTiles = '';

  constructor(site: SiteInfo, tool: ToolSpec, colour: () => string, send: (tool: ToolSpec, geometry: ToolGeometry) => Promise<void>) {
    this.site = site;
    this.tool = tool;
    this.colour = colour;
    this.send = send;
    // One unit is one metre, so shapes keep their proportions.
    this.width = site.extent.width_m;
    this.height = site.extent.height_m;
    this.view = this.whole();

    this.element = el('div', 'tool-pad');
    const frame = el('div', 'tool-frame');
    const map = svg('svg', { class: 'tool-map', role: 'application' });
    this.map = map;
    map.setAttribute('aria-label', t('Map of the table'));
    map.style.aspectRatio = `${this.width} / ${this.height}`;
    this.tiles = svg('g', { class: 'tool-tiles' });
    const outside = svg('path', { class: 'tool-outside', 'fill-rule': 'evenodd' });
    const k = Math.max(this.width, this.height) * 20;
    outside.setAttribute('d', `M${-k} ${-k}H${k}V${k}H${-k}Z M0 0H${this.width}V${this.height}H0Z`);
    const edge = svg('rect', { class: 'tool-edge', x: 0, y: 0, width: this.width, height: this.height });
    const buildings = svg('path', { class: 'tool-buildings' });
    this.drawing = svg('g');
    map.append(this.tiles, outside, buildings, edge, this.drawing);
    void loadFootprints(site).then((rings) => {
      const path = rings.map((ring) => `M${ring.map(([u, v]) => `${(u * this.width).toFixed(1)} ${(v * this.height).toFixed(1)}`).join('L')}Z`);
      buildings.setAttribute('d', path.join(''));
    });

    // The map's own buttons float in its corners: full screen, and back to the whole table.
    const corner = el('div', 'tool-map-buttons');
    const fit = el('button', 'tool-map-button', t('Fit table'));
    const full = el('button', 'tool-map-button tool-map-full');
    for (const button of [fit, full]) button.type = 'button';
    full.setAttribute('aria-label', t('Full screen map'));
    full.setAttribute('aria-pressed', 'false');
    full.textContent = '⤢';
    fit.addEventListener('click', () => this.look(this.whole()));
    full.addEventListener('click', () => {
      const on = !this.element.classList.contains('is-full');
      this.element.classList.toggle('is-full', on);
      document.body.classList.toggle('has-full-map', on);
      full.setAttribute('aria-pressed', String(on));
      full.textContent = on ? '✕' : '⤢';
      full.setAttribute('aria-label', on ? t('Close the full screen map') : t('Full screen map'));
      this.scheduleTiles();
    });
    corner.append(fit, full);
    frame.append(map, corner);

    this.hint = el('p', 'tool-hint');
    this.actions = el('div', 'tool-actions');
    this.undo = el('button', 'action', t('Undo'));
    this.clear = el('button', 'action', t('Clear'));
    this.done = el('button', 'action primary', t('Send'));
    for (const button of [this.undo, this.clear, this.done]) button.type = 'button';
    this.undo.addEventListener('click', () => {
      this.corners.pop();
      this.render();
    });
    this.clear.addEventListener('click', () => this.reset());
    this.done.addEventListener('click', () => this.finish());
    this.actions.append(this.undo, this.clear, this.done);
    this.element.append(frame, this.hint, this.actions);

    const at = (event: { clientX: number; clientY: number }): [number, number] => {
      const matrix = map.getScreenCTM();
      if (!matrix) return [0, 0];
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const clamp = (value: number) => Math.min(1, Math.max(0, value));
      return [clamp(point.x / this.width), clamp(point.y / this.height)];
    };
    map.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      map.setPointerCapture(event.pointerId);
      this.fingers.set(event.pointerId, [event.clientX, event.clientY]);
      if (this.fingers.size === 2) {
        // A second finger: the map moves instead, and the corner the first finger placed goes.
        if (this.dragging && this.tool.type !== 'point') this.corners.pop();
        this.dragging = false;
        this.startGesture();
        this.render();
        return;
      }
      if (this.fingers.size > 2 || this.gesture) return;
      this.dragging = true;
      if (this.tool.type === 'point') this.corners = [at(event)];
      else if (this.tool.freehand) this.corners = [at(event)];
      else if (this.corners.length < MOST) this.corners.push(at(event));
      this.render();
      if (this.tool.type === 'point') this.sendPoint();
    });
    map.addEventListener('pointermove', (event) => {
      if (!this.fingers.has(event.pointerId)) return;
      this.fingers.set(event.pointerId, [event.clientX, event.clientY]);
      if (this.gesture) {
        this.moveGesture();
        return;
      }
      if (!this.dragging || this.corners.length === 0) return;
      const here = at(event);
      if (this.tool.freehand) {
        // A pen stroke follows the finger, a corner every few screen pixels.
        const last = this.corners[this.corners.length - 1]!;
        const gap = (this.view.w / this.width) * 0.008;
        if (Math.hypot(here[0] - last[0], here[1] - last[1]) >= gap) this.corners.push(here);
      } else {
        // Until the finger lifts, the corner just placed follows it.
        this.corners[this.corners.length - 1] = here;
      }
      this.render();
      if (this.tool.type === 'point') this.sendPoint();
    });
    const lift = (event: PointerEvent) => {
      this.fingers.delete(event.pointerId);
      if (this.gesture) {
        // The map stays put until every finger is off, so the last one does not draw.
        if (this.fingers.size === 0) this.gesture = null;
        return;
      }
      const drew = this.dragging && this.tool.freehand;
      this.dragging = false;
      if (drew && event.type === 'pointerup') this.finish();
    };
    for (const type of ['pointerup', 'pointercancel'] as const) map.addEventListener(type, lift);
    // A mouse wheel or a trackpad zooms too, about where it points.
    map.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const [u, v] = at(event);
        this.zoomAbout(u * this.width, v * this.height, Math.exp(event.deltaY * 0.002));
      },
      { passive: false },
    );
    new ResizeObserver(() => this.scheduleTiles()).observe(map);
    this.look(this.view);
  }

  setTool(tool: ToolSpec): void {
    this.tool = tool;
    this.reset();
  }

  /** Redraws in the phone's current colour, which changes if it is given a new slot. */
  refresh(): void {
    this.render();
  }

  /** The whole table with a little room around it. */
  private whole(): ViewBox {
    const pad = Math.max(this.width, this.height) * 0.02;
    return { x: -pad, y: -pad, w: this.width + 2 * pad, h: this.height + 2 * pad };
  }

  private look(view: ViewBox): void {
    // No closer than 1/16 of the table, no further than three tables across.
    const most = this.whole().w * 3;
    const least = this.whole().w / 16;
    const w = Math.min(most, Math.max(least, view.w));
    const h = (view.h * w) / view.w;
    const cx = Math.min(this.width * 1.5, Math.max(-this.width * 0.5, view.x + view.w / 2));
    const cy = Math.min(this.height * 1.5, Math.max(-this.height * 0.5, view.y + view.h / 2));
    this.view = { x: cx - w / 2, y: cy - h / 2, w, h };
    this.map.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
    this.scheduleTiles();
    this.render();
  }

  private zoomAbout(x: number, y: number, factor: number): void {
    const { view } = this;
    const w = view.w * factor;
    const h = view.h * factor;
    this.look({ x: x - ((x - view.x) / view.w) * w, y: y - ((y - view.y) / view.h) * h, w, h });
  }

  private startGesture(): void {
    const [a, b] = [...this.fingers.values()] as [[number, number], [number, number]];
    this.gesture = { view: { ...this.view }, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], spread: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])) };
  }

  /** Two fingers: the place under their middle stays under it, and their spread zooms. */
  private moveGesture(): void {
    const gesture = this.gesture;
    if (!gesture || this.fingers.size < 2) return;
    const [a, b] = [...this.fingers.values()] as [[number, number], [number, number]];
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const spread = Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]));
    const box = this.map.getBoundingClientRect();
    const start = gesture.view;
    // Metres per screen pixel when the gesture started (the map keeps its aspect ratio).
    const perPx = Math.max(start.w / box.width, start.h / box.height);
    const scale = gesture.spread / spread;
    const w = start.w * scale;
    const h = start.h * scale;
    // The map point under the first middle, then put under the new middle.
    const ox = start.x + start.w / 2 + (gesture.mid[0] - (box.left + box.width / 2)) * perPx;
    const oy = start.y + start.h / 2 + (gesture.mid[1] - (box.top + box.height / 2)) * perPx;
    const x = ox - (mid[0] - (box.left + box.width / 2)) * perPx * scale - w / 2;
    const y = oy - (mid[1] - (box.top + box.height / 2)) * perPx * scale - h / 2;
    this.look({ x, y, w, h });
  }

  private scheduleTiles(): void {
    cancelAnimationFrame(this.tilesDue);
    this.tilesDue = requestAnimationFrame(() => this.drawTiles());
  }

  /** The base map tiles under the part of the table shown, at a zoom that fits the screen. */
  private drawTiles(): void {
    const box = this.map.getBoundingClientRect();
    if (box.width === 0) return;
    const { site, width, height, view } = this;
    const lonlat = (x: number, y: number) => tableToLonLat(site, x / width, y / height);
    const seen = [lonlat(view.x, view.y), lonlat(view.x + view.w, view.y), lonlat(view.x + view.w, view.y + view.h), lonlat(view.x, view.y + view.h)];
    const lons = seen.map((p) => p[0]!);
    const lats = seen.map((p) => p[1]!);
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const perPx = Math.max(view.w / box.width, view.h / box.height) / Math.min(2, devicePixelRatio || 1);
    let z = Math.round(Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / perPx));
    z = Math.min(19, Math.max(12, z));
    let range = () => [Math.floor(tileX(Math.min(...lons), z)), Math.floor(tileX(Math.max(...lons), z)), Math.floor(tileY(Math.max(...lats), z)), Math.floor(tileY(Math.min(...lats), z))] as const;
    let [x0, x1, y0, y1] = range();
    while (z > 12 && (x1 - x0 + 1) * (y1 - y0 + 1) > 48) {
      z--;
      [x0, x1, y0, y1] = range();
    }
    const key = `${z}/${x0}-${x1}/${y0}-${y1}`;
    if (key === this.shownTiles) return;
    this.shownTiles = key;
    const table = (lon: number, la: number) => {
      const [u, v] = lonLatToTable(site, lon, la);
      return [u * width, v * height] as const;
    };
    const images: SVGImageElement[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        // A tile is a little square of the world; on the table it is turned and scaled, near enough flat.
        const [ax, ay] = table(tileLon(x, z), tileLat(y, z));
        const [bx, by] = table(tileLon(x + 1, z), tileLat(y, z));
        const [cx, cy] = table(tileLon(x, z), tileLat(y + 1, z));
        const image = svg('image', { href: `/api/basemap/${TILES}/${z}/${x}/${y}.png`, width: 1.004, height: 1.004, preserveAspectRatio: 'none' });
        image.setAttribute('transform', `matrix(${bx - ax} ${by - ay} ${cx - ax} ${cy - ay} ${ax} ${ay})`);
        image.addEventListener('error', () => image.remove());
        images.push(image);
      }
    }
    this.tiles.replaceChildren(...images);
  }

  private reset(): void {
    this.corners = [];
    this.render();
  }

  /** A dragged point is sent as it moves, spaced out, and always ends on the last position. */
  private sendPoint(): void {
    clearTimeout(this.trailing);
    const wait = this.lastSent + PHONE_SEND_INTERVAL - performance.now();
    if (wait > 0) {
      this.trailing = window.setTimeout(() => this.sendPoint(), wait);
      return;
    }
    this.lastSent = performance.now();
    this.send(this.tool, toolGeometry(this.site, 'point', this.corners)).catch((error) => (this.hint.textContent = t('Not sent: {reason}.', { reason: error.message })));
  }

  private finish(): void {
    if (this.tool.freehand) this.corners = thin(this.corners, MOST);
    if (this.corners.length < LEAST[this.tool.type]) {
      this.reset();
      return;
    }
    const { tool } = this;
    const geometry = toolGeometry(this.site, tool.type, this.corners);
    this.done.disabled = true;
    this.send(tool, geometry).then(
      () => {
        this.reset();
        this.hint.textContent = t('Sent to the table.');
      },
      (error) => {
        this.render();
        this.hint.textContent = t('Not sent: {reason}.', { reason: error.message });
      },
    );
  }

  private render(): void {
    const { tool, corners, width, height } = this;
    const colour = this.colour();
    // Sizes in map units that come out the same on screen whatever the site's size and zoom.
    const unit = this.view.w / 340;
    const xy = corners.map(([u, v]) => [u * width, v * height] as const);
    const nodes: SVGElement[] = [];
    const path = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    if (tool.type === 'polygon' && xy.length >= 3) nodes.push(svg('polygon', { points: path, fill: colour, 'fill-opacity': 0.25, stroke: 'none' }));
    if (tool.type !== 'point' && xy.length >= 2) {
      const closed = tool.type === 'polygon' && xy.length >= 3;
      nodes.push(svg(closed ? 'polygon' : 'polyline', { points: path, fill: 'none', stroke: colour, 'stroke-width': 2.5 * unit, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    // A pen stroke shows as a line only; tapped corners show as dots.
    const dots = tool.freehand ? [] : xy;
    for (const [x, y] of dots) {
      nodes.push(svg('circle', { cx: x, cy: y, r: (tool.type === 'point' ? 7 : 4.5) * unit, fill: colour, stroke: '#000', 'stroke-width': 1.2 * unit }));
    }
    this.drawing.replaceChildren(...nodes);
    this.map.style.setProperty('--unit', String(unit));

    const tapped = tool.type !== 'point' && !tool.freehand;
    this.actions.hidden = !tapped;
    this.undo.disabled = this.clear.disabled = corners.length === 0;
    this.done.disabled = corners.length < LEAST[tool.type];
    this.done.textContent = t(`Send ${NOUN[tool.type].toLowerCase()}`);
    this.hint.textContent = tool.freehand ? t('Draw with one finger; it goes to the table when you lift it. Two fingers move the map.') : t(HINT[tool.type]);
  }
}

/** The tools part of a layer's card on a phone: a tool picker and the map pad. */
export function toolSection(layer: string, manifest: LayerManifest, store: Store, connection: Connection): { element: HTMLElement; presses: string[]; sync(active: boolean): void } {
  const tools = manifest.tools ?? [];
  const element = el('div', 'tools');
  const colour = () => store.me()?.colour ?? '#ffffff';
  const send = (tool: ToolSpec, geometry: ToolGeometry) => connection.request<void>('tool.input', { layer, tool: tool.id, geometry });
  let pad: ToolPad | null = null;
  let current = tools[0]!;

  const picker = el('div', 'segmented');
  picker.setAttribute('role', 'radiogroup');
  picker.setAttribute('aria-label', t('Tool'));
  const buttons = tools.map((tool) => {
    const button = el('button', undefined, tool.label ?? t(NOUN[tool.type]));
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.addEventListener('click', () => {
      current = tool;
      pad?.setTool(tool);
      mark();
    });
    picker.append(button);
    return [tool, button] as const;
  });
  const mark = () => {
    for (const [tool, button] of buttons) button.setAttribute('aria-checked', String(tool === current));
  };
  mark();
  if (tools.length > 1) element.append(picker);
  store.onParticipants(() => pad?.refresh());

  // The layer's buttons a phone may press sit under the map, beside what they act on (the sketch's
  // "Take back my last mark", #335).
  const presses = (manifest.controls ?? []).filter((control) => control.type === 'action' && control.phone === true);
  const row = el('div', 'tool-presses');
  for (const control of presses) {
    const button = el('button', 'action', t(control.label));
    button.type = 'button';
    if (control.type === 'action' && control.words) {
      // Words with the press (#462): a comment on this phone's last mark.
      const words = wordsField(control.words);
      const form = el('form', 'action-words');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!words.value.trim()) return;
        void connection.request('layer.action', { layer, action: control.id, words: words.value }).then(() => (words.value = '')).catch(() => {});
      });
      button.type = 'submit';
      form.append(words, button);
      row.append(form);
      continue;
    }
    button.addEventListener('click', () => void connection.request('layer.action', { layer, action: control.id }).catch(() => {}));
    row.append(button);
  }

  return {
    element,
    presses: presses.map((control) => control.id),
    // The pad is built the first time the layer is on, so idle layers cost nothing.
    sync(active) {
      if (!active || pad) return;
      pad = new ToolPad(store.state.site, current, colour, send);
      element.append(pad.element);
      if (presses.length > 0) element.append(row);
    },
  };
}
