import { formatCorners, parseCorners, tableFrame } from '@mrstudio/sdk';
import type { SiteInfo } from '@mrstudio/sdk';

/**
 * Placing a drawing by hand (#301): with a Masterplan open in the editor, its frame is drawn over
 * the table with handles. Drag inside it to move it, a corner to scale it about its middle, the
 * round handle to turn it. Letting go writes the `corners` param (top left; top right; bottom
 * left, as lon,lat), which the layer already places the drawing by.
 */

type Point = [number, number];
/** The drawing's top left, top right and bottom left, in table metres. */
type Frame = [Point, Point, Point];

const SVG = 'http://www.w3.org/2000/svg';
/** A turn within this many degrees of square to the table snaps square. */
const SNAP_DEG = 1.5;

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Point, s: number): Point => [a[0] * s, a[1] * s];
const turn = (a: Point, radians: number): Point => {
  const [c, s] = [Math.cos(radians), Math.sin(radians)];
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
};

/** The four corners in drawing order: top left, top right, bottom right, bottom left. */
export function frameCorners([tl, tr, bl]: Frame): [Point, Point, Point, Point] {
  return [tl, tr, add(tr, sub(bl, tl)), bl];
}

export function frameMiddle(frame: Frame): Point {
  const [tl, , br] = frameCorners(frame);
  return scale(add(tl, br), 0.5);
}

/** Every corner moved by `by`. */
export function moveFrame(frame: Frame, by: Point): Frame {
  return frame.map((p) => add(p, by)) as Frame;
}

/** Grown by `factor` about the middle. */
export function scaleFrame(frame: Frame, factor: number): Frame {
  const middle = frameMiddle(frame);
  return frame.map((p) => add(middle, scale(sub(p, middle), factor))) as Frame;
}

/** Turned by `degrees` clockwise on the table (y points down) about the middle. */
export function turnFrame(frame: Frame, degrees: number): Frame {
  const middle = frameMiddle(frame);
  return frame.map((p) => add(middle, turn(sub(p, middle), (degrees * Math.PI) / 180))) as Frame;
}

/** The frame's top edge as a bearing on the table: 0 when square to it, clockwise. */
export function frameAngle([tl, tr]: Frame): number {
  return (Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180) / Math.PI;
}

/** Turns a frame that is within `SNAP_DEG` of square to the table the rest of the way. */
export function squareUp(frame: Frame): Frame {
  const angle = frameAngle(frame);
  const square = Math.round(angle / 90) * 90;
  return Math.abs(angle - square) < SNAP_DEG && angle !== square ? turnFrame(frame, square - angle) : frame;
}

/**
 * The frame of a drawing turned a further `quarters` quarter turns, about its middle: its sides
 * swap when the turn is odd, so the drawing keeps its own shape and the frame its direction.
 */
export function returnFrame(frame: Frame, quarters: number): Frame {
  if (Math.abs(Math.round(quarters)) % 2 === 0) return frame;
  const [tl, tr, bl] = frame;
  const middle = frameMiddle(frame);
  const [across, down] = [sub(tr, tl), sub(bl, tl)];
  const [w, h] = [Math.hypot(...across), Math.hypot(...down)];
  const [u, v] = [scale(across, 1 / (w || 1)), scale(down, 1 / (h || 1))];
  const corner = sub(sub(middle, scale(u, h / 2)), scale(v, w / 2));
  return [corner, add(corner, scale(u, h)), add(corner, scale(v, w))];
}

/** The same, for a `corners` param: "" stays "". */
export function returnCorners(site: SiteInfo, corners: string, quarters: number): string {
  const parsed = parseCorners(corners);
  if (!parsed) return corners;
  const map = tableFrame(site);
  return formatCorners(returnFrame(parsed.map((c) => map.toTable(c)) as Frame, quarters).map((p) => map.toLonLat(p)));
}

export interface DrawingFrameHost {
  site(): SiteInfo;
  /** Saves the corners ('' fills the table again). */
  place(corners: string): void;
}

export class DrawingFrame {
  private readonly root = document.createElement('div');
  private readonly drawing = svg('svg');
  private readonly body = svg('polygon', { class: 'ed-df-body' });
  private readonly stem = svg('line', { class: 'ed-df-stem' });
  private readonly knob = svg('circle', { r: 7, class: 'ed-df-turn' });
  private readonly corners = [0, 1, 2, 3].map(() => svg('rect', { width: 12, height: 12, class: 'ed-df-corner' }));
  private readonly top = svg('text', { class: 'ed-df-top', 'text-anchor': 'middle' });
  private readonly fill = Object.assign(document.createElement('button'), { type: 'button', className: 'ed-button', textContent: 'Fill the table again' });
  private surface: HTMLElement | null = null;
  private frame: Frame | null = null;
  private resize = new ResizeObserver(() => this.draw());

  private readonly host: DrawingFrameHost;

  constructor(host: DrawingFrameHost) {
    this.host = host;
    this.root.className = 'ed-drawing-frame';
    const tip = (node: SVGElement, text: string) => node.append(Object.assign(svg('title'), { textContent: text }));
    tip(this.knob, 'Turn the drawing (Shift: in steps of 15°)');
    for (const corner of this.corners) tip(corner, 'Scale the drawing');
    this.top.textContent = 'top';
    this.body.addEventListener('pointerdown', (e) => this.drag(e, 'move'));
    this.knob.addEventListener('pointerdown', (e) => this.drag(e, 'turn'));
    for (const corner of this.corners) corner.addEventListener('pointerdown', (e) => this.drag(e, 'scale'));
    this.drawing.append(this.body, this.stem, this.knob, ...this.corners, this.top);
    const bar = document.createElement('div');
    bar.className = 'ed-df-bar';
    bar.append(Object.assign(document.createElement('span'), { textContent: 'Drag to move the drawing, a corner to scale it, the round handle to turn it.' }), this.fill);
    this.fill.addEventListener('click', () => this.host.place(''));
    this.root.append(this.drawing, bar);
  }

  /** Shows the frame of a drawing placed by `corners` ('' for the whole table) over `surface`. */
  show(surface: HTMLElement, corners: string): void {
    if (this.root.classList.contains('is-dragging')) return;
    const map = tableFrame(this.host.site());
    const parsed = parseCorners(corners);
    this.fill.hidden = !parsed;
    this.frame = parsed ? (parsed.map((c) => map.toTable(c)) as Frame) : [[0, 0], [map.width, 0], [0, map.height]];
    // Drawn in the surface's parent, so the handles may reach past the table's edge.
    const holder = surface.parentElement!;
    if (this.surface !== surface) {
      this.resize.disconnect();
      this.surface = surface;
      if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
      this.resize.observe(surface);
    }
    if (this.root.parentElement !== holder) holder.append(this.root);
    this.draw();
  }

  hide(): void {
    this.root.remove();
    this.resize.disconnect();
    this.surface = null;
  }

  private toTable(event: PointerEvent): Point {
    const box = this.surface!.getBoundingClientRect();
    const { width_m, height_m } = this.host.site().extent;
    return [((event.clientX - box.left) / box.width) * width_m, ((event.clientY - box.top) / box.height) * height_m];
  }

  private draw(): void {
    const frame = this.frame;
    if (!frame || !this.surface) return;
    const [inner, outer] = [this.surface.getBoundingClientRect(), this.surface.parentElement!.getBoundingClientRect()];
    Object.assign(this.root.style, { left: `${inner.left - outer.left}px`, top: `${inner.top - outer.top}px`, width: `${inner.width}px`, height: `${inner.height}px` });
    const k = inner.width / this.host.site().extent.width_m;
    const px = (p: Point): Point => [p[0] * k, p[1] * k];
    const corners = frameCorners(frame).map(px);
    const middle = px(frameMiddle(frame));
    const top = scale(add(corners[0]!, corners[1]!), 0.5);
    // The turning handle sits 18 px out from the top edge's middle.
    const out = sub(top, middle);
    const knob = add(top, scale(out, 18 / (Math.hypot(out[0], out[1]) || 1)));
    const set = (node: SVGElement, attributes: Record<string, number | string>) => {
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    };
    set(this.body, { points: corners.map((p) => p.join(',')).join(' ') });
    set(this.stem, { x1: top[0], y1: top[1], x2: knob[0], y2: knob[1] });
    set(this.knob, { cx: knob[0], cy: knob[1] });
    corners.forEach((corner, i) => set(this.corners[i]!, { x: corner[0] - 6, y: corner[1] - 6 }));
    // Where the drawing's top is, so a turned drawing reads the right way up.
    const inward = scale(out, -14 / (Math.hypot(out[0], out[1]) || 1));
    set(this.top, { x: top[0] + inward[0], y: top[1] + inward[1] + 4, transform: `rotate(${frameAngle(frame)} ${top[0] + inward[0]} ${top[1] + inward[1]})` });
  }

  private drag(start: PointerEvent, kind: 'move' | 'scale' | 'turn'): void {
    if (!this.frame || start.button !== 0) return;
    start.preventDefault();
    start.stopPropagation();
    const target = start.currentTarget as Element;
    target.setPointerCapture(start.pointerId);
    const from = this.toTable(start);
    const before = this.frame;
    const middle = frameMiddle(before);
    const reach = Math.hypot(from[0] - middle[0], from[1] - middle[1]) || 1;
    const angle = Math.atan2(from[1] - middle[1], from[0] - middle[0]);
    this.root.classList.add('is-dragging');
    const move = (e: Event): void => {
      const event = e as PointerEvent;
      const at = this.toTable(event);
      if (kind === 'move') this.frame = moveFrame(before, sub(at, from));
      else if (kind === 'scale') this.frame = scaleFrame(before, Math.max(0.02, Math.hypot(at[0] - middle[0], at[1] - middle[1]) / reach));
      else {
        const degrees = ((Math.atan2(at[1] - middle[1], at[0] - middle[0]) - angle) * 180) / Math.PI;
        this.frame = squareUp(turnFrame(before, event.shiftKey ? Math.round(degrees / 15) * 15 : degrees));
      }
      this.draw();
    };
    const end = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      this.root.classList.remove('is-dragging');
      if (!this.frame || this.frame === before) return;
      const map = tableFrame(this.host.site());
      this.fill.hidden = false;
      this.host.place(formatCorners(this.frame.map((p) => map.toLonLat(p))));
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }
}
