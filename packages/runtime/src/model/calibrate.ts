import { MIN_CALIBRATION_PAIRS, describeProjector, solveProjector } from '@mrstudio/sdk';
import type { CalibrationPair, Connection, ModelHandle, ProjectorCalibration, SiteInfo } from '@mrstudio/sdk';

import { CalibrationPanel } from './calibration-panel.ts';
import type { CalibrationCommand, CalibrationState } from './calibration-panel.ts';
import { proposeLandmarks, tableAxes } from './landmarks.ts';
import type { Landmark } from './landmarks.ts';
import type { Footprint } from './sun-shadows.ts';
import type { ModelView } from './view.ts';

/** The pseudo layer the tool draws its preview light through. */
const LAYER = '__calibration';
/** The plan is drawn for the controller's screen, where it has room. */
const PLAN_WIDTH = 480;
const PLAN_MARGIN = 16;
/** How often, at most, the tool tells the controllers where it is while the cross is dragged. */
const STATE_MS = 60;

interface Target extends Landmark {
  /** Where the marker was put, in CSS pixels of the surface. Null until placed. */
  image: [number, number] | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Geometric calibration of the projector. The tool names a corner of the physical model and
 * shows it on a plan; the person moves a projected marker until its light sits on that corner.
 * From six or more such pairs the projector's camera is solved, the twin is shown through it
 * as a check, and the result is saved by the host to calibration.json.
 *
 * The table shows only the cross and the corners placed so far (#594): the words, the plan and
 * the buttons are on the controller, which gets the tool's state as `calibration.state` and
 * sends its presses back as `calibration.command`. K shows the same panel on the table, for a
 * table run without a controller.
 */
export class CalibrationTool {
  private readonly surface: HTMLElement;
  private readonly model: ModelView;
  private readonly connection: Connection;
  private readonly site: SiteInfo;
  private readonly onProjector: boolean;
  private root: HTMLElement | null = null;
  private targets: Target[] = [];
  private current = 0;
  private size: [number, number] = [1, 1];
  private solution: ProjectorCalibration | null = null;
  private problem = '';
  private showModel = true;
  private cleanups: (() => void)[] = [];
  private handle: ModelHandle | null = null;
  /** True from `open` until the footprints are read and the tool shows. */
  private opening = false;
  private footprints: Footprint[] | null = null;
  private marker!: HTMLElement;
  private dots!: HTMLElement;
  /** The panel on the table itself, hidden unless K asks for it. */
  private panel: CalibrationPanel | null = null;
  private stateTimer: number | null = null;
  /** The plan last sent, so its picture goes out only when it changed. */
  private planSent = '';
  private planPicture = '';

  constructor(surface: HTMLElement, model: ModelView, connection: Connection, site: SiteInfo, onProjector: boolean) {
    this.surface = surface;
    this.model = model;
    this.connection = connection;
    this.site = site;
    this.onProjector = onProjector;
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this.root || this.opening) return;
    this.opening = true;
    // Footprint corners are the ones a person can find (#595), so the tool waits for them.
    void this.model.footprintsReady().then((footprints) => {
      if (!this.opening) return;
      this.opening = false;
      this.footprints = footprints;
      this.start();
    });
  }

  private start(): void {
    this.size = [this.surface.clientWidth, this.surface.clientHeight];
    this.targets = proposeLandmarks(this.model.twin, this.site, 6, this.footprints).map((landmark) => ({ ...landmark, image: null }));
    this.restore(this.model.savedCalibration);
    this.current = Math.max(0, this.targets.findIndex((target) => target.image === null));

    // The tool has the surface to itself: other layers and the flat map are hidden while it runs.
    this.surface.classList.add('is-calibrating');
    this.model.setSolo(LAYER);
    this.handle = this.model.handle(LAYER, (cleanup) => this.cleanups.push(cleanup));
    this.handle.addLight({ type: 'sun', azimuth: 200, altitude: 55, intensity: 0.75, sky: { intensity: 0.3 } });

    this.build();
    const resize = new ResizeObserver(() => this.resized());
    resize.observe(this.surface);
    this.cleanups.push(() => resize.disconnect());
    window.addEventListener('keydown', this.onKey);
    this.cleanups.push(() => window.removeEventListener('keydown', this.onKey));
    // The projected table's tool is run from the controllers. A preview window (the developer
    // page) keeps its panel to itself, so two tools never answer the same controller.
    if (this.onProjector) this.cleanups.push(this.connection.on('calibration.command', (command: CalibrationCommand) => this.command(command)));
    this.planSent = '';
    if (!this.onProjector) this.togglePanel();
    this.solve();
  }

  close(): void {
    this.opening = false;
    if (!this.root) return;
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    if (this.stateTimer !== null) window.clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.panel = null;
    // The controllers put their panel away.
    if (this.onProjector) void this.connection.request('calibration.state', closedState()).catch(() => {});
    this.handle = null;
    this.root.remove();
    this.root = null;
    this.model.canvas.style.visibility = '';
    this.surface.classList.remove('is-calibrating');
    this.model.setSolo(null);
    this.model.setCalibrationOverride(undefined);
  }

  /** Starts from the saved calibration's markers, so a small correction does not mean starting over. */
  private restore(saved: ProjectorCalibration | null): void {
    if (!saved) return;
    const [sx, sy] = [this.size[0] / saved.image.width, this.size[1] / saved.image.height];
    const close = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 0.01;
    for (const pair of saved.pairs) {
      const image: [number, number] = [pair.image[0] * sx, pair.image[1] * sy];
      const known = this.targets.find((target) => close(target.point, pair.model));
      if (known) known.image = image;
      else this.targets.push({ point: pair.model, label: pair.label ?? 'A corner from the saved calibration', image });
    }
  }

  // ---- Screen --------------------------------------------------------------

  private build(): void {
    const root = el('div', 'calibration');
    this.root = root;
    this.dots = el('div', 'calibration-dots');
    this.marker = el('div', 'calibration-marker');
    this.marker.append(el('i', ''), el('i', ''), el('b', ''));
    root.append(this.dots, this.marker);

    const place = (event: PointerEvent) => {
      const box = this.surface.getBoundingClientRect();
      this.put([event.clientX - box.left, event.clientY - box.top]);
    };
    root.addEventListener('pointerdown', (event) => {
      root.setPointerCapture(event.pointerId);
      place(event);
    });
    root.addEventListener('pointermove', (event) => {
      if (root.hasPointerCapture(event.pointerId)) place(event);
    });
    this.surface.append(root);
  }

  /** K: the panel on the table too, for a table with no controller. It covers part of the map. */
  private togglePanel(): void {
    if (!this.root) return;
    if (this.panel) {
      this.panel.element.remove();
      this.panel = null;
      return;
    }
    const panel = new CalibrationPanel(
      (command) => this.command(command),
      () => this.close(),
      { compact: true },
    );
    panel.element.classList.add('is-on-table');
    // The panel is for reading and pressing; only the rest of the surface places the marker.
    panel.element.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.root.append(panel.element);
    this.panel = panel;
    this.planSent = '';
    this.publish();
  }

  /** A press on a controller's panel, or on the table's own. */
  private command(command: CalibrationCommand): void {
    if (!this.root) return;
    switch (command.action) {
      case 'sync':
        this.planSent = '';
        this.publish();
        break;
      case 'back':
        this.go(this.current - 1);
        break;
      case 'next':
        this.go(this.current + 1);
        break;
      case 'skip':
        this.skip();
        break;
      case 'select':
        if (Number.isInteger(command.index)) this.go(command.index!);
        break;
      case 'nudge': {
        const [dx, dy] = [Number(command.dx) || 0, Number(command.dy) || 0];
        const from = this.targets[this.current]?.image ?? this.guess(this.current);
        this.put([from[0] + dx, from[1] + dy]);
        break;
      }
      case 'model':
        this.showModel = !this.showModel;
        this.refresh();
        break;
      case 'save':
        void this.save();
        break;
      case 'flat':
        void this.clear();
        break;
    }
  }

  private onKey = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 10 : event.altKey ? 0.25 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (move) {
      const from = this.targets[this.current]?.image ?? this.guess(this.current);
      this.put([from[0] + move[0], from[1] + move[1]]);
    } else if (event.key === 'Enter') this.go(this.current + 1);
    else if (event.key === 'Backspace') this.skip();
    else if (event.key === 'Escape') this.close();
    else if (event.key === 'k' || event.key === 'K') this.togglePanel();
    else return;
    event.preventDefault();
  };

  private put(position: [number, number]): void {
    const target = this.targets[this.current];
    if (!target) return;
    target.image = [Math.min(this.size[0], Math.max(0, position[0])), Math.min(this.size[1], Math.max(0, position[1]))];
    this.solve();
  }

  private skip(): void {
    const target = this.targets[this.current];
    if (target) target.image = null;
    this.solve();
    this.go(this.current + 1);
  }

  private go(index: number): void {
    this.current = (index + this.targets.length) % this.targets.length;
    this.refresh();
  }

  /** Where the tool expects a corner to be before the person has placed it. */
  private guess(index: number): [number, number] {
    const projected = this.model.project(this.targets[index]!.point);
    const inside = projected && projected[0] >= 0 && projected[0] <= this.size[0] && projected[1] >= 0 && projected[1] <= this.size[1];
    return inside ? projected : [this.size[0] / 2, this.size[1] / 2];
  }

  private resized(): void {
    const next: [number, number] = [this.surface.clientWidth, this.surface.clientHeight];
    if (next[0] < 1 || next[1] < 1) return;
    const [sx, sy] = [next[0] / this.size[0], next[1] / this.size[1]];
    for (const target of this.targets) if (target.image) target.image = [target.image[0] * sx, target.image[1] * sy];
    this.size = next;
    this.solve();
  }

  // ---- Solving and saving --------------------------------------------------

  private pairs(): CalibrationPair[] {
    return this.targets.filter((target) => target.image).map((target) => ({ model: target.point, image: target.image!, label: target.label }));
  }

  private solve(): void {
    const pairs = this.pairs();
    const image = { width: this.size[0], height: this.size[1] };
    this.solution = null;
    this.problem = '';
    if (pairs.length >= MIN_CALIBRATION_PAIRS) {
      try {
        const { matrix, error_px } = solveProjector(pairs, image);
        this.solution = { version: 1, matrix, image, pairs, error_px: Math.round(error_px * 100) / 100, camera: describeProjector(matrix, image) };
      } catch (error) {
        this.problem = (error as Error).message;
      }
    }
    this.refresh();
  }

  private async save(): Promise<void> {
    if (!this.solution) return;
    try {
      await this.connection.request('calibration.set', { projector: { ...this.solution, saved_at: new Date().toISOString() } });
      this.close();
    } catch (error) {
      this.problem = `Could not save: ${(error as Error).message}`;
      this.refresh();
    }
  }

  private async clear(): Promise<void> {
    try {
      await this.connection.request('calibration.set', { projector: null });
      this.close();
    } catch (error) {
      this.problem = `Could not clear: ${(error as Error).message}`;
      this.refresh();
    }
  }

  // ---- Drawing -------------------------------------------------------------

  private refresh(): void {
    if (!this.root) return;
    const target = this.targets[this.current]!;

    // The twin shows through the solved camera, as the check that the fit is right.
    this.model.setCalibrationOverride(this.solution && this.showModel ? this.solution : null);
    this.root.classList.toggle('shows-model', this.solution !== null && this.showModel);
    // Without a solution there is nothing meaningful to show: the surface stays dark around the marker.
    this.model.canvas.style.visibility = this.solution && this.showModel ? '' : 'hidden';

    const at = target.image ?? this.guess(this.current);
    this.marker.style.transform = `translate(${at[0]}px, ${at[1]}px)`;
    this.marker.classList.toggle('is-placed', target.image !== null);
    this.dots.replaceChildren(
      ...this.targets.flatMap((t, index) => {
        if (!t.image || index === this.current) return [];
        const dot = el('span', 'calibration-dot', String(index + 1));
        dot.style.transform = `translate(${t.image[0]}px, ${t.image[1]}px)`;
        return [dot];
      }),
    );

    this.publish();
  }

  /** Tells the controllers (and the table's own panel) where the tool is, at most every STATE_MS. */
  private publish(): void {
    if (this.stateTimer !== null) return;
    this.stateTimer = window.setTimeout(() => {
      this.stateTimer = null;
      if (this.root) this.sendState();
    }, STATE_MS);
  }

  private sendState(): void {
    const target = this.targets[this.current]!;
    const placed = this.targets.filter((t) => t.image).length;
    let status: string;
    if (this.problem) status = this.problem;
    else if (this.solution) {
      const camera = this.solution.camera;
      status =
        `${placed} corners placed. The fit is off by ${this.solution.error_px} px on average. ` +
        `The projector is ${this.projectorHeight(camera.position[2])}, with a ${camera.fov_deg.horizontal}° wide image${camera.mirrored ? ', mirrored' : ''}.`;
    } else status = `${placed} of at least ${MIN_CALIBRATION_PAIRS} corners placed.`;
    const done = this.targets.map((t) => t.image !== null);
    const planKey = `${this.current}|${done.map(Number).join('')}|${this.targets.length}`;
    const state: CalibrationState = {
      open: true,
      index: this.current,
      count: this.targets.length,
      label: target.label,
      status,
      problem: this.problem !== '',
      placed,
      needed: MIN_CALIBRATION_PAIRS,
      done,
      solved: this.solution !== null,
      showModel: this.showModel,
      preview: !this.onProjector,
      planKey,
    };
    if (planKey !== this.planSent) {
      this.planPicture = this.drawPlan();
      this.planSent = planKey;
      state.plan = this.planPicture;
    }
    this.panel?.show({ ...state, plan: this.planPicture });
    if (this.onProjector) void this.connection.request('calibration.state', state).catch(() => {});
  }

  /** The solved height of the lens over the model's base, in the room's own measure when the table's size is known. */
  private projectorHeight(z: number): string {
    const above = z - this.model.twin.minZ;
    const table = this.site.table;
    if (!table) return `${Math.round(above)} site metres above the model's base`;
    const metres = (above * table.width_cm) / 100 / this.site.extent.width_m;
    return `about ${metres.toFixed(2)} m above the table`;
  }

  /** The site from above with the current corner ringed (and its building outlined), as a picture for the panel. */
  private drawPlan(): string {
    const { twin } = this.model;
    const axes = tableAxes(this.site);
    const { width_m, height_m } = this.site.extent;
    // A margin keeps corners on the model's edge whole.
    const scale = (PLAN_WIDTH - 2 * PLAN_MARGIN) / width_m;
    const ratio = 2;
    const height = Math.round(height_m * scale) + 2 * PLAN_MARGIN;
    const plan = document.createElement('canvas');
    plan.width = PLAN_WIDTH * ratio;
    plan.height = height * ratio;
    const g = plan.getContext('2d')!;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.fillStyle = '#10141c';
    g.fillRect(0, 0, PLAN_WIDTH, height);
    g.strokeStyle = '#3a4458';
    g.strokeRect(PLAN_MARGIN + 0.5, PLAN_MARGIN + 0.5, PLAN_WIDTH - 2 * PLAN_MARGIN - 1, height - 2 * PLAN_MARGIN - 1);
    const xy = (east: number, north: number): [number, number] => {
      const [right, up] = axes(east, north);
      return [PLAN_MARGIN + (right + width_m / 2) * scale, PLAN_MARGIN + (height_m / 2 - up) * scale];
    };
    // Roofs, lighter the taller they are.
    const span = Math.max(1, twin.maxZ - twin.minZ);
    const shadeOf = (z: number) => {
      const shade = 70 + Math.round(((z - twin.minZ) / span) * 150);
      return `rgb(${shade} ${shade} ${shade + 12})`;
    };
    const target = this.targets[this.current];
    const outline = (rings: [number, number][][]) => {
      g.beginPath();
      for (const ring of rings) {
        ring.forEach(([east, north], k) => {
          const [x, y] = xy(east, north);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        g.closePath();
      }
    };
    if (this.footprints) {
      // The footprints, as the corners were picked from them (#595).
      const tops = new Map<number, number>();
      for (let i = 0; i < twin.kinds.length; i++) {
        const b = twin.buildings[i]!;
        if (twin.kinds[i] === 1 && b) tops.set(b, Math.max(tops.get(b) ?? -Infinity, twin.positions[i * 3 + 2]!));
      }
      for (const footprint of this.footprints) {
        const top = tops.get(footprint.number);
        if (top === undefined) continue;
        outline(footprint.rings);
        g.fillStyle = shadeOf(top);
        g.fill('evenodd');
      }
      if (target?.building) {
        for (const footprint of this.footprints) {
          if (footprint.number !== target.building) continue;
          outline(footprint.rings);
          g.strokeStyle = '#ffd24a';
          g.lineWidth = 2;
          g.stroke();
        }
      }
    } else {
      for (let t = 0; t < twin.indices.length; t += 3) {
        const a = twin.indices[t]!;
        if (twin.kinds[a] !== 1) continue;
        g.fillStyle = shadeOf(twin.positions[a * 3 + 2]!);
        g.beginPath();
        for (let k = 0; k < 3; k++) {
          const i = twin.indices[t + k]!;
          const [x, y] = xy(twin.positions[i * 3]!, twin.positions[i * 3 + 1]!);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.fill();
      }
    }
    // The model's tile seams (#651), so a crossing on the plan reads as one on the table.
    const table = this.site.table;
    if (table?.tile_cm && table.width_cm && table.height_cm) {
      const across = Math.round(table.width_cm / table.tile_cm);
      const down = Math.round(table.height_cm / table.tile_cm);
      const [left, top] = [PLAN_MARGIN, PLAN_MARGIN];
      const [w, h] = [width_m * scale, height_m * scale];
      g.strokeStyle = 'rgba(160, 176, 204, 0.35)';
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath();
      for (let i = 1; i < across; i++) {
        g.moveTo(left + (i * w) / across, top);
        g.lineTo(left + (i * w) / across, top + h);
      }
      for (let j = 1; j < down; j++) {
        g.moveTo(left, top + (j * h) / down);
        g.lineTo(left + w, top + (j * h) / down);
      }
      g.stroke();
      g.setLineDash([]);
    }
    this.targets.forEach((t, index) => {
      if (index === this.current) return;
      const [x, y] = xy(t.point[0], t.point[1]);
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fillStyle = t.image ? '#4ade80' : '#7c8799';
      g.fill();
    });
    if (target) {
      const [x, y] = xy(target.point[0], target.point[1]);
      g.beginPath();
      g.arc(x, y, 11, 0, Math.PI * 2);
      g.strokeStyle = '#ffd24a';
      g.lineWidth = 3;
      g.stroke();
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fillStyle = '#ffd24a';
      g.fill();
    }
    return plan.toDataURL('image/png');
  }
}

/** What the controllers hear when the tool closes. */
function closedState(): CalibrationState {
  return { open: false, index: 0, count: 0, label: '', status: '', problem: false, placed: 0, needed: MIN_CALIBRATION_PAIRS, done: [], solved: false, showModel: false, preview: false, planKey: '' };
}
