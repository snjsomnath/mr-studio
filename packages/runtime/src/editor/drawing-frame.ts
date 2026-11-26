import { drawingSize, fitCorners, formatCorners, parseCorners, siteDataUrl, tableFrame } from '@mrstudio/sdk';
import type { SiteInfo } from '@mrstudio/sdk';

import { fitFrame, loadInk, loadOutlines, outlinePoints } from './drawing-snap.ts';

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
  /** The framed drawing's dataset ('' for the table's first) and its turn in degrees, for Snap to buildings (#379). */
  drawing(): { dataset: string; turn: number } | null;
}

export class DrawingFrame {
  private readonly root = document.createElement('div');
  private readonly drawing = svg('svg');
  private readonly body = svg('polygon', { class: 'ed-df-body' });
  private readonly stem = svg('line', { class: 'ed-df-stem' });
  private readonly knob = svg('circle', { r: 7, class: 'ed-df-turn' });
  private readonly corners = [0, 1, 2, 3].map(() => svg('rect', { width: 12, height: 12, class: 'ed-df-corner' }));
  private readonly top = svg('text', { class: 'ed-df-top', 'text-anchor': 'middle' });
  private readonly fill = Object.assign(document.createElement('button'), { type: 'button', className: 'ed-button', textContent: 'Fit to the table again' });
  private readonly snap = Object.assign(document.createElement('button'), { type: 'button', className: 'ed-button', textContent: 'Snap to buildings' });
  private readonly hint = Object.assign(document.createElement('span'), { className: 'ed-df-hint-howto', textContent: 'Drag to move the drawing, a corner to scale it, the round handle to turn it. Arrow keys nudge it.' });
  /** The drawing itself, drawn into the frame while it moves (#405), so it follows the hand before the table redraws. */
  private readonly ghost = svg('g', { class: 'ed-df-ghost' });
  private readonly ghostImage = svg('image', { width: 1, height: 1, preserveAspectRatio: 'none' });
  private ghostFrom = '';
  private ghostBlob = '';
  /** Keys pressed since the last save: saved together a moment after the last one. */
  private keySave = 0;
  private snapping = false;
  private surface: HTMLElement | null = null;
  private frame: Frame | null = null;
  /** The framed drawing's own size, read from its file, so a drawing with no corners is framed at its proportions (#559). */
  private size: { width: number; height: number } | null = null;
  private corners = '';
  private resize = new ResizeObserver(() => this.draw());

  private readonly host: DrawingFrameHost;

  constructor(host: DrawingFrameHost) {
    this.host = host;
    this.root.className = 'ed-drawing-frame';
    this.body.addEventListener('focus', () => this.ghostSource());
    const tip = (node: SVGElement, text: string) => node.append(Object.assign(svg('title'), { textContent: text }));
    tip(this.knob, 'Turn the drawing (Shift: in steps of 15°)');
    for (const corner of this.corners) tip(corner, 'Scale the drawing');
    this.top.textContent = 'top';
    this.body.addEventListener('pointerdown', (e) => this.drag(e, 'move'));
    this.knob.addEventListener('pointerdown', (e) => this.drag(e, 'turn'));
    for (const corner of this.corners) corner.addEventListener('pointerdown', (e) => this.drag(e, 'scale'));
    this.ghost.append(this.ghostImage);
    this.drawing.append(this.ghost, this.body, this.stem, this.knob, ...this.corners, this.top);
    // The keyboard (#405): arrows nudge, Shift for larger steps; [ and ] turn; + and − scale.
    this.body.setAttribute('tabindex', '0');
    this.body.setAttribute('role', 'application');
    this.body.setAttribute('aria-label', 'The drawing: arrow keys move it, [ and ] turn it, + and − scale it');
    this.body.addEventListener('keydown', (e) => this.key(e));
    const bar = document.createElement('div');
    bar.className = 'ed-df-bar';
    this.snap.title = 'Move, turn and scale the drawing a little so its lines lie on the table\'s building footprints.';
    bar.append(this.hint, this.snap, this.fill);
    this.fill.addEventListener('click', () => this.host.place(''));
    this.snap.addEventListener('click', () => void this.snapToBuildings());
    this.root.append(this.drawing, bar);
  }

  /** Shows the frame of a drawing placed by `corners` ('' for the whole table) over `surface`. */
  show(surface: HTMLElement, corners: string): void {
    if (this.root.classList.contains('is-dragging')) return;
    const map = tableFrame(this.host.site());
    const parsed = parseCorners(corners);
    this.fill.hidden = !parsed;
    this.snap.disabled = this.snapping || !this.host.site().data?.buildings;
    this.corners = corners;
    this.frame = parsed ? (parsed.map((c) => map.toTable(c)) as Frame) : this.fitted();
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

  /** The frame of a drawing with no corners: fitted inside the table at its own proportions, as the layer places it. */
  private fitted(): Frame {
    const map = tableFrame(this.host.site());
    const quarters = Math.round((this.host.drawing()?.turn ?? 0) / 90);
    return fitCorners({ width: map.width, height: map.height }, this.size, quarters);
  }

  hide(): void {
    this.root.remove();
    this.resize.disconnect();
    this.surface = null;
  }

  /** Fits the frame to the footprints (#379) and saves it when the fit is better, saying how well it matches. */
  private async snapToBuildings(): Promise<void> {
    const frame = this.frame;
    const drawing = this.host.drawing();
    if (!frame || !drawing || this.snapping) return;
    this.snapping = true;
    this.snap.disabled = true;
    this.hint.className = '';
    this.hint.textContent = 'Fitting the drawing to the footprints…';
    try {
      const site = this.host.site();
      const [ink, rings] = await Promise.all([loadInk(site, drawing.dataset, drawing.turn), loadOutlines(site)]);
      if (rings.length === 0) throw new Error('the table has no building footprints');
      const spacing = Math.max(0.5, Math.hypot(site.extent.width_m, site.extent.height_m) / 2500);
      const fit = fitFrame(ink, frame, outlinePoints(rings, spacing));
      const [before, after] = [Math.round(fit.before * 100), Math.round(fit.after * 100)];
      if (fit.after < 0.15 || fit.after <= fit.before + 0.005) {
        this.hint.textContent =
          fit.after <= fit.before + 0.005
            ? `It already fits as well as it can (${before} % of the footprint edges on its lines).`
            : `No good fit nearby (${after} %). Drag the drawing close to where it belongs and try again.`;
      } else {
        const map = tableFrame(site);
        this.frame = fit.frame;
        this.draw();
        this.fill.hidden = false;
        this.host.place(formatCorners(fit.frame.map((p) => map.toLonLat(p))));
        this.hint.textContent = `Snapped: ${after} % of the footprint edges now lie on its lines (from ${before} %).`;
      }
    } catch (error) {
      this.hint.textContent = `Could not snap: ${(error as Error).message}.`;
    } finally {
      this.snapping = false;
      this.snap.disabled = !this.host.site().data?.buildings;
    }
  }

  private toTable(event: PointerEvent): Point {
    const box = this.surface!.getBoundingClientRect();
    const { width_m, height_m } = this.host.site().extent;
    return [((event.clientX - box.left) / box.width) * width_m, ((event.clientY - box.top) / box.height) * height_m];
  }

  private key(event: KeyboardEvent): void {
    if (!this.frame) return;
    const { width_m } = this.host.site().extent;
    const step = width_m * (event.shiftKey ? 0.02 : 0.002);
    const moves: Record<string, Point> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    let next: Frame | null = null;
    if (moves[event.key]) next = moveFrame(this.frame, moves[event.key]!);
    else if (event.key === '[' || event.key === ']') next = turnFrame(this.frame, (event.key === '[' ? -1 : 1) * (event.shiftKey ? 15 : 0.5));
    else if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '−') next = scaleFrame(this.frame, event.key === '-' || event.key === '−' ? 1 / 1.01 : 1.01);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    this.frame = next;
    this.root.classList.add('is-dragging', 'is-moved');
    this.draw();
    clearTimeout(this.keySave);
    this.keySave = window.setTimeout(() => {
      this.root.classList.remove('is-dragging');
      this.save();
    }, 500);
  }

  private save(): void {
    if (!this.frame) return;
    const map = tableFrame(this.host.site());
    this.fill.hidden = false;
    this.host.place(formatCorners(this.frame.map((p) => map.toLonLat(p))));
  }

  /** Points the ghost at the framed drawing's picture; it shows only while the frame moves. */
  private ghostSource(): void {
    const drawing = this.host.drawing();
    const site = this.host.site();
    const name = drawing && (drawing.dataset || Object.entries(site.data ?? {}).find(([, path]) => String(path).toLowerCase().endsWith('.svg'))?.[0]);
    const url = name ? siteDataUrl(site, name) : null;
    // Read as a typed picture: the host may serve the file without an SVG content type.
    if (url && this.ghostFrom !== url) {
      this.ghostFrom = url;
      void fetch(url)
        .then((r) => r.text())
        .then((text) => {
          if (this.ghostFrom !== url) return;
          this.size = drawingSize(new DOMParser().parseFromString(text, 'image/svg+xml').documentElement);
          if (!parseCorners(this.corners) && !this.root.classList.contains('is-dragging')) {
            this.frame = this.fitted();
            this.draw();
          }
          if (this.ghostBlob) URL.revokeObjectURL(this.ghostBlob);
          this.ghostBlob = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
          this.ghostImage.setAttribute('href', this.ghostBlob);
        })
        .catch(() => {});
    }
    // The picture turns inside the frame by whole quarters, as the layer turns it.
    const quarters = ((Math.round((drawing?.turn ?? 0) / 90) % 4) + 4) % 4;
    this.ghostImage.setAttribute('transform', `rotate(${quarters * 90} 0.5 0.5)`);
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
    // The unit square onto the frame: (0,0) top left, (1,0) top right, (0,1) bottom left.
    const [tl, tr, , bl] = corners as [Point, Point, Point, Point];
    set(this.ghost, { transform: `matrix(${tr[0] - tl[0]} ${tr[1] - tl[1]} ${bl[0] - tl[0]} ${bl[1] - tl[1]} ${tl[0]} ${tl[1]})` });
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
    this.ghostSource();
    this.root.classList.add('is-dragging', 'is-moved');
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
      this.save();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }
}
