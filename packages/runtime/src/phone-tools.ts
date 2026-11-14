import { lonLatToTable, tableToLonLat } from '@mrstudio/sdk';
import type { Connection, LayerManifest, Position, SiteInfo, ToolGeometry, ToolSpec } from '@mrstudio/sdk';

import type { Store } from './store.ts';

/**
 * Milliseconds between a phone's repeated requests (a dragged slider, a dragged point).
 * The host accepts 20 requests a second from a phone; this keeps one stream at about 12.
 */
export const PHONE_SEND_INTERVAL = 80;

const SVG = 'http://www.w3.org/2000/svg';
const NOUN: Record<ToolSpec['type'], string> = { point: 'Point', line: 'Line', polygon: 'Area' };
const HINT: Record<ToolSpec['type'], string> = {
  point: 'Tap or drag on the map.',
  line: 'Tap to add points along the line, then send.',
  polygon: 'Tap the corners of the area, then send.',
};
/** Corners a line or an area needs before it can be sent. */
const LEAST: Record<ToolSpec['type'], number> = { point: 1, line: 2, polygon: 3 };
/** The most corners the pad lets one drawing have. The host's own limit is higher. */
const MOST = 60;

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
function loadFootprints(site: SiteInfo): Promise<[number, number][][]> {
  if (!site.buildings) return Promise.resolve([]);
  footprints ??= fetch(`/site/${site.buildings}`)
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

/**
 * A small map of the table area. Finger positions become table coordinates and,
 * through the site's corners, WGS84. It draws the buildings for orientation and
 * the shape being drawn; what the table does with it is the layer's business.
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
  private readonly drawing: SVGGElement;
  private readonly hint: HTMLElement;
  private readonly undo: HTMLButtonElement;
  private readonly clear: HTMLButtonElement;
  private readonly done: HTMLButtonElement;
  private readonly actions: HTMLElement;
  private readonly site: SiteInfo;
  private readonly colour: () => string;
  private readonly send: (tool: ToolSpec, geometry: ToolGeometry) => Promise<void>;

  constructor(site: SiteInfo, tool: ToolSpec, colour: () => string, send: (tool: ToolSpec, geometry: ToolGeometry) => Promise<void>) {
    this.site = site;
    this.tool = tool;
    this.colour = colour;
    this.send = send;
    // One unit is one metre, so shapes keep their proportions.
    this.width = site.extent.width_m;
    this.height = site.extent.height_m;

    this.element = el('div', 'tool-pad');
    const map = svg('svg', { viewBox: `0 0 ${this.width} ${this.height}`, class: 'tool-map', role: 'application' });
    map.setAttribute('aria-label', 'Map of the table');
    map.style.aspectRatio = `${this.width} / ${this.height}`;
    const buildings = svg('path', { class: 'tool-buildings' });
    this.drawing = svg('g');
    map.append(buildings, this.drawing);
    void loadFootprints(site).then((rings) => {
      const path = rings.map((ring) => `M${ring.map(([u, v]) => `${(u * this.width).toFixed(1)} ${(v * this.height).toFixed(1)}`).join('L')}Z`);
      buildings.setAttribute('d', path.join(''));
    });

    this.hint = el('p', 'tool-hint');
    this.actions = el('div', 'tool-actions');
    this.undo = el('button', 'action', 'Undo');
    this.clear = el('button', 'action', 'Clear');
    this.done = el('button', 'action primary', 'Send');
    for (const button of [this.undo, this.clear, this.done]) button.type = 'button';
    this.undo.addEventListener('click', () => {
      this.corners.pop();
      this.render();
    });
    this.clear.addEventListener('click', () => this.reset());
    this.done.addEventListener('click', () => this.finish());
    this.actions.append(this.undo, this.clear, this.done);
    this.element.append(map, this.hint, this.actions);

    const at = (event: PointerEvent): [number, number] => {
      const box = map.getBoundingClientRect();
      const clamp = (value: number) => Math.min(1, Math.max(0, value));
      return [clamp((event.clientX - box.left) / box.width), clamp((event.clientY - box.top) / box.height)];
    };
    map.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary) return;
      event.preventDefault();
      map.setPointerCapture(event.pointerId);
      this.dragging = true;
      if (this.tool.type === 'point') this.corners = [at(event)];
      else if (this.corners.length < MOST) this.corners.push(at(event));
      this.render();
      if (this.tool.type === 'point') this.sendPoint();
    });
    // Until the finger lifts, the corner just placed follows it.
    map.addEventListener('pointermove', (event) => {
      if (!this.dragging || !event.isPrimary || this.corners.length === 0) return;
      this.corners[this.corners.length - 1] = at(event);
      this.render();
      if (this.tool.type === 'point') this.sendPoint();
    });
    for (const type of ['pointerup', 'pointercancel'] as const) map.addEventListener(type, () => (this.dragging = false));
    this.render();
  }

  setTool(tool: ToolSpec): void {
    this.tool = tool;
    this.reset();
  }

  /** Redraws in the phone's current colour, which changes if it is given a new slot. */
  refresh(): void {
    this.render();
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
    this.send(this.tool, toolGeometry(this.site, 'point', this.corners)).catch((error) => (this.hint.textContent = `Not sent: ${error.message}.`));
  }

  private finish(): void {
    if (this.corners.length < LEAST[this.tool.type]) return;
    const { tool } = this;
    const geometry = toolGeometry(this.site, tool.type, this.corners);
    this.done.disabled = true;
    this.send(tool, geometry).then(
      () => {
        this.reset();
        this.hint.textContent = 'Sent to the table.';
      },
      (error) => {
        this.render();
        this.hint.textContent = `Not sent: ${error.message}.`;
      },
    );
  }

  private render(): void {
    const { tool, corners, width, height } = this;
    const colour = this.colour();
    // Sizes in map units that come out the same on screen whatever the site's size.
    const unit = width / 340;
    const xy = corners.map(([u, v]) => [u * width, v * height] as const);
    const nodes: SVGElement[] = [];
    const path = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    if (tool.type === 'polygon' && xy.length >= 3) nodes.push(svg('polygon', { points: path, fill: colour, 'fill-opacity': 0.25, stroke: 'none' }));
    if (tool.type !== 'point' && xy.length >= 2) {
      const closed = tool.type === 'polygon' && xy.length >= 3;
      nodes.push(svg(closed ? 'polygon' : 'polyline', { points: path, fill: 'none', stroke: colour, 'stroke-width': 2.5 * unit, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    for (const [x, y] of xy) {
      nodes.push(svg('circle', { cx: x, cy: y, r: (tool.type === 'point' ? 7 : 4.5) * unit, fill: colour, stroke: '#000', 'stroke-width': 1.2 * unit }));
    }
    this.drawing.replaceChildren(...nodes);

    const drawn = tool.type !== 'point';
    this.actions.hidden = !drawn;
    this.undo.disabled = this.clear.disabled = corners.length === 0;
    this.done.disabled = corners.length < LEAST[tool.type];
    this.done.textContent = `Send ${NOUN[tool.type].toLowerCase()}`;
    this.hint.textContent = HINT[tool.type];
  }
}

/** The tools part of a layer's card on a phone: a tool picker and the map pad. */
export function toolSection(manifest: LayerManifest, store: Store, connection: Connection): { element: HTMLElement; sync(active: boolean): void } {
  const tools = manifest.tools ?? [];
  const element = el('div', 'tools');
  const colour = () => store.me()?.colour ?? '#ffffff';
  const send = (tool: ToolSpec, geometry: ToolGeometry) => connection.request<void>('tool.input', { layer: manifest.id, tool: tool.id, geometry });
  let pad: ToolPad | null = null;
  let current = tools[0]!;

  const picker = el('div', 'segmented');
  picker.setAttribute('role', 'radiogroup');
  picker.setAttribute('aria-label', 'Tool');
  const buttons = tools.map((tool) => {
    const button = el('button', undefined, tool.label ?? NOUN[tool.type]);
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

  return {
    element,
    // The pad is built the first time the layer is on, so idle layers cost nothing.
    sync(active) {
      if (!active || pad) return;
      pad = new ToolPad(store.state.site, current, colour, send);
      element.append(pad.element);
    },
  };
}
