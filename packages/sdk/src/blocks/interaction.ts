// Interaction. Every way of pointing at the table (a mouse, a finger, a phone tool,
// later a tracked token or a dial) becomes the same thing: a stream of PointerSamples
// in table metres. Behaviours consume samples and know nothing about where they came
// from, so "a mouse drives a person" and "a phone drives a person" are one behaviour.
//
//   input source  ->  PointerSample stream  ->  router  ->  behaviours  ->  layer state
//
// Behaviours are plain objects with state a layer reads when it draws, and callbacks
// for what a layer must send onwards (`ctx.setParams`, `ctx.publish`, a kernel param).

import type { ToolInput } from '../types.ts';
import { distance, distanceToLine, pointInPolygon } from './geo.ts';
import type { Point, TableFrame } from './geo.ts';
import type { Area, Path, Shapes, Spot } from './sources.ts';
import { zoomedView } from './view.ts';
import type { View } from './view.ts';

/** Where a sample came from. New sources are added here, behaviours do not change. */
export type InputSource = 'mouse' | 'touch' | 'pen' | 'phone' | 'token' | 'script';

export interface PointerSample {
  /**
   * Identifies one pointer for as long as it exists: one mouse, one finger, one
   * participant's phone, one physical token. Simultaneous pointers have different ids.
   */
  id: string;
  source: InputSource;
  /** `down` and `up` bracket a press; `move` arrives with or without one; `leave` ends the pointer. */
  phase: 'move' | 'down' | 'up' | 'leave';
  /** Position in table metres. */
  point: [number, number];
  /** The same position in WGS84, for kernel params and services. */
  lonLat: [number, number];
  /** Whether the pointer is pressed (a button held, a finger on the glass, a token on the table). */
  pressed: boolean;
  /** Seconds, on a clock shared by all samples of a surface. */
  time: number;
  /** Rotation in radians for sources that have one: a token's heading, a dial's angle. */
  rotation?: number;
  /** The participant behind a phone pointer (the surface number from `tool.input`). */
  owner?: number;
}

/**
 * A point tool input from a phone as a pointer sample: a press at that place. Lines
 * and polygons are not pointers and return null; a layer handles those as drawings.
 */
export function fromToolInput(input: ToolInput, frame: TableFrame, time = 0): PointerSample | null {
  const geometry = input.geometry as { type?: string; coordinates?: [number, number] } | null;
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null;
  const lonLat: [number, number] = [geometry.coordinates[0], geometry.coordinates[1]];
  return { id: `phone:${input.from}`, source: 'phone', phase: 'down', point: frame.toTable(lonLat), lonLat, pressed: true, time, owner: input.from };
}

/** Something that reacts to pointers. Returns true when it used the sample, which stops it reaching behaviours behind it. */
export interface Behaviour {
  handle(sample: PointerSample): boolean;
}

/**
 * Offers each sample to the behaviours in order; the first to use it wins. A
 * behaviour that used a pointer's `down` keeps that pointer until its `up`, so a
 * drag that wanders over another behaviour's target is not stolen.
 */
export function pointerRouter(behaviours: readonly Behaviour[]): Behaviour {
  const captured = new Map<string, Behaviour>();
  return {
    handle(sample) {
      const owner = captured.get(sample.id);
      if (owner) {
        owner.handle(sample);
        if (sample.phase === 'up' || sample.phase === 'leave') captured.delete(sample.id);
        return true;
      }
      for (const behaviour of behaviours) {
        if (behaviour.handle(sample)) {
          if (sample.phase === 'down') captured.set(sample.id, behaviour);
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Gives every pointer its own behaviour: each mouse, finger, phone or token gets
 * an agent, a probe or a lens of its own. The behaviour is made when the pointer
 * first appears and dropped when it leaves (unless `keep`).
 */
export class PerPointer<B extends Behaviour> implements Behaviour {
  private make: (sample: PointerSample) => B | null;
  private keep: boolean;
  private byPointer = new Map<string, B>();

  constructor(make: (sample: PointerSample) => B | null, options: { keep?: boolean } = {}) {
    this.make = make;
    this.keep = options.keep ?? false;
  }

  handle(sample: PointerSample): boolean {
    let behaviour = this.byPointer.get(sample.id);
    if (!behaviour) {
      if (sample.phase === 'leave') return false;
      const made = this.make(sample);
      if (!made) return false;
      behaviour = made;
      this.byPointer.set(sample.id, behaviour);
    }
    const used = behaviour.handle(sample);
    if (sample.phase === 'leave' && !this.keep) this.byPointer.delete(sample.id);
    return used;
  }

  /** The live behaviours with their pointer ids, for drawing. */
  entries(): [id: string, behaviour: B][] {
    return [...this.byPointer.entries()];
  }
}

// ---- Agent: a pointer drives a marker ----------------------------------------

export interface AgentOptions {
  /** Where the agent starts. */
  position: Point;
  /**
   * `drag`: press on the agent and move it. `place`: any press puts it there.
   * `follow`: it goes wherever the pointer is, pressed or not.
   */
  mode?: 'drag' | 'place' | 'follow';
  /** How close a press must be to pick the agent up, in metres. Default 15. */
  grab_m?: number;
  /** Adjusts a wanted position: keep it on the table, snap it to a street, keep it out of buildings. */
  constrain?: (wanted: Point, from: Point) => Point;
  /** Called when the position changed. Send it on from here. */
  onMove?: (agent: Agent, sample: PointerSample) => void;
  /** Called when a drag ends or the agent is placed. */
  onSettle?: (agent: Agent, sample: PointerSample) => void;
}

/**
 * A marker a pointer moves: a person whose view is computed, a camera for a
 * street-level view, an origin or a destination. It also keeps a heading: the
 * direction it last moved, or the rotation of the token that drives it.
 */
export class Agent implements Behaviour {
  position: [number, number];
  /** Radians, 0 pointing right, clockwise on the table. */
  heading = 0;
  /** The pointer currently holding the agent, if any. */
  heldBy: string | null = null;
  private options: AgentOptions;

  constructor(options: AgentOptions) {
    this.options = options;
    this.position = [options.position[0], options.position[1]];
  }

  handle(sample: PointerSample): boolean {
    const mode = this.options.mode ?? 'drag';
    if (sample.phase === 'leave') {
      const held = this.heldBy === sample.id;
      this.heldBy = null;
      return held;
    }
    if (mode === 'follow') {
      this.moveTo(sample);
      return true;
    }
    if (mode === 'place') {
      if (sample.phase !== 'down') return false;
      this.moveTo(sample);
      this.options.onSettle?.(this, sample);
      return true;
    }
    if (sample.phase === 'down' && this.heldBy === null && distance(sample.point, this.position) <= (this.options.grab_m ?? 15)) {
      this.heldBy = sample.id;
      return true;
    }
    if (this.heldBy !== sample.id) return false;
    if (sample.phase === 'move') this.moveTo(sample);
    else if (sample.phase === 'up') {
      this.heldBy = null;
      this.options.onSettle?.(this, sample);
    }
    return true;
  }

  private moveTo(sample: PointerSample): void {
    const wanted = this.options.constrain ? this.options.constrain(sample.point, this.position) : sample.point;
    const dx = wanted[0] - this.position[0];
    const dy = wanted[1] - this.position[1];
    if (sample.rotation !== undefined) this.heading = sample.rotation;
    else if (Math.hypot(dx, dy) > 0.5) this.heading = Math.atan2(dy, dx);
    if (dx === 0 && dy === 0 && sample.rotation === undefined) return;
    this.position = [wanted[0], wanted[1]];
    this.options.onMove?.(this, sample);
  }
}

/** Keeps a position on the table, with a margin in metres. A ready-made `constrain`. */
export function keepOnTable(frame: Pick<TableFrame, 'width' | 'height'>, margin = 0): (wanted: Point) => [number, number] {
  return ([x, y]) => [Math.min(frame.width - margin, Math.max(margin, x)), Math.min(frame.height - margin, Math.max(margin, y))];
}

// ---- Lens: a pointer drives a region that shows something else ----------------

export interface LensOptions {
  /** Radius of the lens on the table, in metres. */
  radius_m: number;
  /** Magnification inside the lens. 1 shows the same scale, which is what an X-ray or scenario lens wants. */
  zoom?: number;
  position?: Point;
  /** Zoom range when a dial or token rotation drives the zoom. */
  zoomRange?: readonly [number, number];
  onChange?: (lens: Lens) => void;
}

/**
 * A circle that follows a pointer and shows something different inside: the same
 * scene magnified (a magnifying glass), another layer (an X-ray), another scenario
 * (today against 2050). A press pins it in place and another press releases it.
 */
export class Lens implements Behaviour {
  centre: [number, number];
  radius_m: number;
  zoom: number;
  pinned = false;
  /** False until a pointer has shown where the lens is. */
  visible: boolean;
  private options: LensOptions;

  constructor(options: LensOptions) {
    this.options = options;
    this.radius_m = options.radius_m;
    this.zoom = options.zoom ?? 1;
    this.centre = options.position ? [options.position[0], options.position[1]] : [0, 0];
    this.visible = options.position !== undefined;
  }

  handle(sample: PointerSample): boolean {
    if (sample.phase === 'leave') {
      if (!this.pinned && sample.source !== 'phone') this.visible = false;
      this.options.onChange?.(this);
      return false;
    }
    if (sample.phase === 'down') {
      // A phone tap has no hover, so it moves the lens rather than pinning it.
      if (sample.source === 'phone' || !this.visible) this.centre = [sample.point[0], sample.point[1]];
      else this.pinned = !this.pinned;
      this.visible = true;
    } else if (sample.phase === 'move' && !this.pinned) {
      this.centre = [sample.point[0], sample.point[1]];
      this.visible = true;
    } else if (sample.phase !== 'up') return this.pinned;
    if (sample.rotation !== undefined && this.options.zoomRange) {
      const [lo, hi] = this.options.zoomRange;
      const turn = (((sample.rotation / (Math.PI * 2)) % 1) + 1) % 1;
      this.zoom = lo + (hi - lo) * turn;
    }
    this.options.onChange?.(this);
    return true;
  }
}

export interface LensStyle {
  /** What hides the scene under the lens before the inside is drawn. Default opaque near-black. */
  backdrop?: string | null;
  rim?: string;
  /** Rim width in pixels. */
  rimWidth?: number;
}

/**
 * Draws a lens: clips to its circle, clears what is underneath, and calls `inside`
 * with a view magnified around the lens centre. Whatever blocks `inside` draws
 * appear in the lens, so the same draw function serves the table and the glass,
 * and a different one makes an X-ray.
 */
export function drawLens(view: View, lens: Pick<Lens, 'centre' | 'radius_m' | 'zoom' | 'pinned' | 'visible'>, inside: (inner: View) => void, style: LensStyle = {}): void {
  if (!lens.visible) return;
  const pen = view.pen;
  const [x, y] = view.toPx(lens.centre);
  const radius = lens.radius_m * view.scale;
  pen.save();
  pen.beginPath();
  pen.arc(x, y, radius, 0, Math.PI * 2);
  pen.clip();
  const backdrop = style.backdrop === undefined ? 'rgba(6,9,14,0.96)' : style.backdrop;
  if (backdrop) {
    pen.fillStyle = backdrop;
    pen.fill();
  }
  inside(zoomedView(view, lens.centre, lens.zoom));
  pen.restore();
  pen.beginPath();
  pen.arc(x, y, radius, 0, Math.PI * 2);
  pen.strokeStyle = style.rim ?? (lens.pinned ? 'rgba(255,223,167,0.95)' : 'rgba(255,241,210,0.7)');
  pen.lineWidth = (style.rimWidth ?? 2) * view.detail;
  pen.stroke();
}

// ---- Probe: a pointer reads what is under it -----------------------------------

export type Hit<P = Record<string, any>> =
  | { kind: 'area'; shape: Area<P>; point: Point }
  | { kind: 'path'; shape: Path<P>; point: Point }
  | { kind: 'spot'; shape: Spot<P>; point: Point };

/**
 * What is under a point: the nearest spot or path within `tolerance_m`, otherwise
 * the area containing it. Small things win over the big things they sit on.
 */
export function hitTest<P>(shapes: Partial<Shapes<P>>, point: Point, tolerance_m = 8): Hit<P> | null {
  let best: Hit<P> | null = null;
  let bestDistance = tolerance_m;
  for (const spot of shapes.spots ?? []) {
    const d = distance(point, spot.point);
    if (d <= bestDistance) {
      best = { kind: 'spot', shape: spot, point };
      bestDistance = d;
    }
  }
  if (best) return best;
  for (const path of shapes.paths ?? []) {
    const d = distanceToLine(point, path.points);
    if (d <= bestDistance) {
      best = { kind: 'path', shape: path, point };
      bestDistance = d;
    }
  }
  if (best) return best;
  for (const area of shapes.areas ?? []) {
    if (area.polygons.some((polygon) => pointInPolygon(point, polygon))) return { kind: 'area', shape: area, point };
  }
  return null;
}

export interface ProbeOptions<P> {
  /** The shapes to read, looked up on every sample so data may change. */
  shapes: () => Partial<Shapes<P>>;
  tolerance_m?: number;
  /** The thing under the pointer changed (null when it left everything). */
  onHover?: (hit: Hit<P> | null, sample: PointerSample) => void;
  /** A press on something, or on nothing (null), which clears the selection. */
  onSelect?: (hit: Hit<P> | null, sample: PointerSample) => void;
}

/** Hover and select: the readout behind "click a building to see its numbers". */
export class Probe<P = Record<string, any>> implements Behaviour {
  hover: Hit<P> | null = null;
  selected: Hit<P> | null = null;
  private options: ProbeOptions<P>;

  constructor(options: ProbeOptions<P>) {
    this.options = options;
  }

  handle(sample: PointerSample): boolean {
    if (sample.phase === 'leave') {
      if (this.hover) {
        this.hover = null;
        this.options.onHover?.(null, sample);
      }
      return false;
    }
    const hit = hitTest(this.options.shapes(), sample.point, this.options.tolerance_m);
    if (hit?.shape !== this.hover?.shape) {
      this.hover = hit;
      this.options.onHover?.(hit, sample);
    }
    if (sample.phase === 'down') {
      this.selected = hit;
      this.options.onSelect?.(hit, sample);
      return hit !== null;
    }
    return false;
  }
}

// ---- Dwell: staying still means something --------------------------------------

export interface DwellOptions {
  /** How long the pointer must stay put. */
  seconds: number;
  /** How far it may drift and still count as staying put, in metres. Default 10. */
  radius_m?: number;
  onDwell: (sample: PointerSample) => void;
  /** The pointer moved on after a dwell. */
  onLeave?: (sample: PointerSample) => void;
}

/**
 * Fires when a pointer rests in one place: reveal details without a click, which
 * suits a table where people point more than they press. Call `check(time)` every
 * frame, since a pointer that is perfectly still sends no samples.
 */
export class Dwell implements Behaviour {
  private options: DwellOptions;
  private resting = new Map<string, { anchor: PointerSample; fired: boolean }>();

  constructor(options: DwellOptions) {
    this.options = options;
  }

  handle(sample: PointerSample): boolean {
    const rest = this.resting.get(sample.id);
    if (sample.phase === 'leave') {
      if (rest?.fired) this.options.onLeave?.(sample);
      this.resting.delete(sample.id);
      return false;
    }
    if (!rest || distance(rest.anchor.point, sample.point) > (this.options.radius_m ?? 10)) {
      if (rest?.fired) this.options.onLeave?.(sample);
      this.resting.set(sample.id, { anchor: sample, fired: false });
    }
    this.check(sample.time);
    return false;
  }

  /** Fires any dwell that has become due at `time` (seconds, the samples' clock). */
  check(time: number): void {
    for (const rest of this.resting.values()) {
      if (!rest.fired && time - rest.anchor.time >= this.options.seconds) {
        rest.fired = true;
        this.options.onDwell(rest.anchor);
      }
    }
  }
}
