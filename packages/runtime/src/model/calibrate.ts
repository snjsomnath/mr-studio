import { MIN_CALIBRATION_PAIRS, describeProjector, solveProjector } from '@mrstudio/sdk';
import type { CalibrationPair, Connection, ModelHandle, ProjectorCalibration, SiteInfo } from '@mrstudio/sdk';

import { proposeLandmarks, tableAxes } from './landmarks.ts';
import type { Landmark } from './landmarks.ts';
import type { ModelView } from './view.ts';

/** The pseudo layer the tool draws its preview light through. */
const LAYER = '__calibration';
const PLAN_WIDTH = 260;
const PLAN_MARGIN = 10;

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
  // Parts of the panel that change.
  private marker!: HTMLElement;
  private dots!: HTMLElement;
  private title!: HTMLElement;
  private label!: HTMLElement;
  private status!: HTMLElement;
  private plan!: HTMLCanvasElement;
  private saveButton!: HTMLButtonElement;
  private modelButton!: HTMLButtonElement;

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
    if (this.root) return;
    this.size = [this.surface.clientWidth, this.surface.clientHeight];
    this.targets = proposeLandmarks(this.model.twin, this.site).map((landmark) => ({ ...landmark, image: null }));
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
    this.solve();
  }

  close(): void {
    if (!this.root) return;
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
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

    const panel = el('div', 'calibration-panel');
    // The panel is for reading and pressing; only the rest of the surface places the marker.
    panel.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.title = el('h2', '');
    this.label = el('p', 'calibration-label');
    this.plan = el('canvas', 'calibration-plan');
    this.status = el('p', 'calibration-status');
    const button = (text: string, action: () => void, className = '') => {
      const node = el('button', className, text);
      node.type = 'button';
      node.addEventListener('click', action);
      return node;
    };
    const steps = el('div', 'calibration-row');
    steps.append(
      button('Back', () => this.go(this.current - 1)),
      button('Skip', () => this.skip()),
      button('Next', () => this.go(this.current + 1), 'is-primary'),
    );
    const actions = el('div', 'calibration-row');
    this.modelButton = button('', () => {
      this.showModel = !this.showModel;
      this.refresh();
    });
    this.saveButton = button('Save', () => void this.save(), 'is-primary');
    actions.append(this.modelButton, this.saveButton);
    const ending = el('div', 'calibration-row');
    ending.append(
      button('Use flat table', () => void this.clear()),
      button('Close', () => this.close()),
    );
    const help = el('p', 'calibration-help', 'Click or drag to move the marker. Arrow keys nudge it; hold Shift for bigger steps. Enter goes to the next corner.');
    panel.append(this.title, this.label, this.plan, steps, this.status, actions, ending, help);
    if (!this.onProjector) {
      panel.append(el('p', 'calibration-help', 'This is a preview window. To calibrate the real projector, open this tool on the projected table.'));
    }
    root.append(this.dots, this.marker, panel);

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
    const placed = this.targets.filter((t) => t.image).length;

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

    this.title.textContent = `Corner ${this.current + 1} of ${this.targets.length}`;
    this.label.textContent = `${target.label}. Move the marker until its light sits on that corner.`;
    if (this.problem) this.status.textContent = this.problem;
    else if (this.solution) {
      const camera = this.solution.camera;
      this.status.textContent =
        `${placed} corners placed. The fit is off by ${this.solution.error_px} px on average. ` +
        `The projector is ${this.projectorHeight(camera.position[2])}, with a ${camera.fov_deg.horizontal}° wide image${camera.mirrored ? ', mirrored' : ''}.`;
    } else {
      this.status.textContent = `${placed} of at least ${MIN_CALIBRATION_PAIRS} corners placed.`;
    }
    this.status.classList.toggle('is-problem', this.problem !== '');
    this.saveButton.disabled = this.solution === null;
    this.modelButton.disabled = this.solution === null;
    this.modelButton.textContent = this.showModel ? 'Hide the model' : 'Show the model';
    this.drawPlan();
  }

  /** The solved height of the lens over the model's base, in the room's own measure when the table's size is known. */
  private projectorHeight(z: number): string {
    const above = z - this.model.twin.minZ;
    const table = this.site.table;
    if (!table) return `${Math.round(above)} site metres above the model's base`;
    const metres = (above * table.width_cm) / 100 / this.site.extent.width_m;
    return `about ${metres.toFixed(2)} m above the table`;
  }

  /** The site from above with the current corner ringed, so the person knows which corner is meant. */
  private drawPlan(): void {
    const { twin } = this.model;
    const axes = tableAxes(this.site);
    const { width_m, height_m } = this.site.extent;
    // A margin keeps corners on the model's edge whole.
    const scale = (PLAN_WIDTH - 2 * PLAN_MARGIN) / width_m;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const height = Math.round(height_m * scale) + 2 * PLAN_MARGIN;
    this.plan.width = PLAN_WIDTH * ratio;
    this.plan.height = height * ratio;
    this.plan.style.width = `${PLAN_WIDTH}px`;
    this.plan.style.height = `${height}px`;
    const g = this.plan.getContext('2d')!;
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
    for (let t = 0; t < twin.indices.length; t += 3) {
      const a = twin.indices[t]!;
      if (twin.kinds[a] !== 1) continue;
      const shade = 70 + Math.round(((twin.positions[a * 3 + 2]! - twin.minZ) / span) * 150);
      g.fillStyle = `rgb(${shade} ${shade} ${shade + 12})`;
      g.beginPath();
      for (let k = 0; k < 3; k++) {
        const i = twin.indices[t + k]!;
        const [x, y] = xy(twin.positions[i * 3]!, twin.positions[i * 3 + 1]!);
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.fill();
    }
    this.targets.forEach((target, index) => {
      const [x, y] = xy(target.point[0], target.point[1]);
      const here = index === this.current;
      g.beginPath();
      g.arc(x, y, here ? 7 : 3, 0, Math.PI * 2);
      if (here) {
        g.strokeStyle = '#ffd24a';
        g.lineWidth = 2;
        g.stroke();
        g.beginPath();
        g.arc(x, y, 2, 0, Math.PI * 2);
        g.fillStyle = '#ffd24a';
      } else {
        g.fillStyle = target.image ? '#4ade80' : '#7c8799';
      }
      g.fill();
    });
  }
}
