// Present › Screens and calibration… (#151, #153, #382, #393). In the desktop app this computer's
// screens, calibration and colour have one home, File › Settings › This computer
// (apps/studio/ui), and this dialog is the way there. In a browser, where there is no Settings
// window, the projector is lined up here. Quality (#134) belongs to the table, saved in
// site.json, so it shows in both.

import { setting } from './settings-list.ts';
import type { Connection, DisplayQuality, ProjectorCalibration } from '@mrstudio/sdk';

import { el } from '../controls.ts';
import { icon } from './icons.ts';
import { remoteCalibrationPanel } from '../model/calibration-panel.ts';
import type { CalibrationPanel } from '../model/calibration-panel.ts';

type Invoke = (command: string, args?: object) => Promise<unknown>;

/** The colour pass of one display. Neutral is 1, 1, 1, 1, 0, 0. */
export interface Colour {
  saturation: number;
  contrast: number;
  brightness: number;
  gamma: number;
  temperature: number;
  tint: number;
}

/** A connected display, as the desktop app lists it (#188). */
interface Screen {
  index: number;
  name: string | null;
  model: string | null;
  kind: 'projector' | 'tv' | null;
  width: number;
  height: number;
  primary: boolean;
}

/** How a display is listed in the Table and Controller pickers. */
export function screenLabel(d: Screen): string {
  const kind = d.kind === 'projector' ? ' · projector' : d.kind === 'tv' ? ' · TV' : d.primary ? ' · main screen' : '';
  return `${d.index + 1} · ${d.model ?? d.name ?? 'Display'}${kind}`;
}


/** The sliders, in the order the colour pass applies them, with their ranges (colour.rs). */
const SLIDERS: [keyof Colour, string, number, number, number][] = [
  ['saturation', 'Saturation', 0, 2.5, 1],
  ['contrast', 'Contrast', 0.5, 2, 1],
  ['brightness', 'Brightness', 0.5, 1.5, 1],
  ['gamma', 'Midtones', 0.5, 2.5, 1],
  ['temperature', 'Cool · warm', -1, 1, 0],
  ['tint', 'Green · magenta', -1, 1, 0],
];
const NEUTRAL: Colour = { saturation: 1, contrast: 1, brightness: 1, gamma: 1, temperature: 0, tint: 0 };

/** What went wrong, in words: a shell error is a string, ours an Error. */
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const same = (a: Colour, b: Colour) => SLIDERS.every(([key]) => Math.abs(a[key] - b[key]) < 1e-6);

// ---- The colour pass, for the preview in the editor --------------------------------------

const fmt = (n: number) => n.toFixed(4);

/** White balance as channel gains, scaled so no channel goes above 1 (as the surfaces do). */
function gains(temperature: number, tint: number): number[] {
  const raw = [(1 + 0.25 * temperature) * (1 + 0.1 * tint), 1 - 0.2 * tint, (1 - 0.25 * temperature) * (1 + 0.1 * tint)];
  const top = Math.max(...raw);
  return raw.map((g) => g / top);
}

/** The soft-light grey whose curve puts mid grey where gamma would: black and white stay put. */
function midtoneGrey(gamma: number): number {
  const target = Math.pow(0.5, 1 / gamma);
  const level = target <= 0.5 ? 2 * target - 0.5 : ((target - 0.5) / (Math.SQRT1_2 - 0.5) + 1) / 2;
  return Math.round(Math.min(1, Math.max(0, level)) * 255);
}

/**
 * Shows a display's colour pass on `target`, or takes it off with null. The same pass as
 * the shell's on a surface (apps/studio/src-tauri/src/colour.js), so change both together:
 * CSS filter functions for saturation, contrast and brightness, and two blended layers for
 * midtones (soft-light grey) and white balance (multiply by channel gains). No SVG filters:
 * WebKit on the Mac draws those in software and froze over the animated map (#181).
 */
export function previewColour(target: HTMLElement, s: Colour | null): void {
  const on = s !== null && !same(s, NEUTRAL);
  const plain = !s || (s.saturation === 1 && s.contrast === 1 && s.brightness === 1);
  target.style.filter = on && !plain ? `saturate(${fmt(s!.saturation)}) contrast(${fmt(s!.contrast)}) brightness(${fmt(s!.brightness)})` : '';
  if (on && getComputedStyle(target).position === 'static') target.style.position = 'relative';
  const layer = (name: string, blend: string, show: boolean, background: string) => {
    let node = target.querySelector<HTMLElement>(`:scope > .dt-colour-${name}`);
    if (!show) {
      node?.remove();
      return;
    }
    if (!node) {
      node = el('div', `dt-colour-layer dt-colour-${name}`);
      node.setAttribute('aria-hidden', 'true');
      node.style.mixBlendMode = blend;
      target.append(node);
    }
    node.style.background = background;
  };
  const grey = s ? midtoneGrey(s.gamma) : 128;
  layer('midtones', 'soft-light', on && s!.gamma !== 1, `rgb(${grey}, ${grey}, ${grey})`);
  const [r, g, b] = s ? gains(s.temperature, s.tint).map((v) => Math.round(v * 255)) : [255, 255, 255];
  layer('balance', 'multiply', on && (s!.temperature !== 0 || s!.tint !== 0), `rgb(${r}, ${g}, ${b})`);
}

// ---- The tab ------------------------------------------------------------------------------

function tool(label: string, iconName: string, large = false): HTMLButtonElement {
  const node = el('button', large ? 'ed-tool is-large' : 'ed-tool');
  node.type = 'button';
  node.append(icon(iconName, large ? 20 : 16), el('span', undefined, label));
  return node;
}

function group(name: string, ...children: HTMLElement[]): HTMLElement {
  const node = el('div', 'ed-group');
  const tools = el('div', 'ed-group-tools');
  tools.append(...children);
  node.append(tools, el('div', 'ed-group-name', name));
  return node;
}

function column(...children: HTMLElement[]): HTMLElement {
  const node = el('div', 'ed-tool-column dt-column');
  node.append(...children);
  return node;
}



export class DisplayTab {
  /** The ribbon groups, made once and kept, so a slider being dragged is never rebuilt under the pointer. */
  readonly groups: HTMLElement[];
  private readonly invoke: Invoke | undefined;
  private readonly connection: Connection;
  private readonly preview: HTMLElement;
  private readonly openSettings: () => void;
  private calibrating = false;
  private calibrated = false;

  private readonly calibrateButton = tool('Calibrate', 'crosshair', true);
  private readonly clearButton = tool('Clear', 'trash');
  private readonly calibrationStatus = el('span', 'dt-status');
  private readonly qualityButtons = new Map<DisplayQuality, HTMLButtonElement>();
  private readonly soundButtons = new Map<number, HTMLButtonElement>();
  private readonly problem = el('span', 'dt-status is-error');
  /** The calibration guide, while it is open (#181). */
  private guide: HTMLElement | null = null;
  private guideTimer: number | null = null;
  /** A window shows the table, so the tool has somewhere to open; null when it cannot be known (a browser). */
  private tableShown: boolean | null = null;
  /** Saved while the guide was open, to tick its last step. */
  private savedNow = false;
  /** The calibration's panel (#594), shown in the guide while the tool is open on the table. */
  private panel: CalibrationPanel | null = null;

  /** `preview` is the editor's map, which shows the chosen display's colour while this tab is open. */
  constructor(invoke: Invoke | undefined, connection: Connection, preview: HTMLElement, openSettings: () => void) {
    this.invoke = invoke;
    this.connection = connection;
    this.preview = preview;
    this.openSettings = openSettings;

    // In the order a table is set up: which screen is which, line the map up, then colour.
    const groups: HTMLElement[] = [];
    if (invoke) {
      // In the app this computer's screens, calibration and colour have one home, File › Settings
      // (#393), which works with no table open too. Here is the way to it, and the table's quality.
      const open = tool('Screens, calibration and colour', 'settings', true);
      open.dataset.command = 'settings.computer';
      open.title = 'File › Settings › This computer: which display shows the table and the controller, lining the map up with the model, and the colour of each display';
      open.addEventListener('click', () => this.openSettings());
      const note = el('p', 'dt-note', 'They belong to this computer, so they are in File › Settings, the same for every table.');
      groups.push(group('This computer', open, note));
      groups.push(setting('computer.quality', 'dialog:screens', this.qualityGroup()));
      groups.push(setting('table.sounds', 'dialog:screens', this.soundsGroup()));
    } else {
      // In a browser there is no Settings window: the projector is lined up here (settings-list.ts, #392).
      groups.push(setting('computer.calibration', 'dialog:screens', this.projectorGroup()));
      const note = el('p', 'dt-note', 'The colour of each display is set in the MR Studio desktop app, where the table is projected.');
      groups.push(group('Colour', note));
      groups.push(setting('computer.quality', 'dialog:screens', this.qualityGroup()));
      groups.push(setting('table.sounds', 'dialog:screens', this.soundsGroup()));
    }
    this.groups = groups;

    // The tool may also be opened or closed from Displays and settings.
    connection.on('calibration.mode', (p: { active: boolean }) => {
      this.calibrating = p.active;
      this.drawCalibration();
    });
    connection.on('calibration', (p: { projector: ProjectorCalibration | null }) => {
      this.calibrated = Boolean(p.projector);
      if (p.projector && this.guide) this.savedNow = true;
      this.drawCalibration();
    });
  }

  private call(command: string, args?: object): Promise<unknown> {
    if (!this.invoke) return Promise.reject(new Error('Only in the desktop app'));
    return this.invoke(command, args);
  }

  private say(message: string | null): void {
    this.problem.textContent = message ?? '';
    this.problem.hidden = !message;
    if (this.guide) this.fillGuide(this.guide);
  }






  /** Draft, Good or Best for this table (#134): pixel density on the table and the sun shadows' detail. */
  private qualityGroup(): HTMLElement {
    const choices: [DisplayQuality, string, string, string][] = [
      ['draft', 'Draft', 'pencil', 'Lightest: one pixel per screen point and coarser sun shadows (0.6 m). For a slow computer.'],
      ['good', 'Good', 'check', 'Sharp on most screens, sun shadows at 0.3 m. The default.'],
      ['best', 'Best', 'sparkle', 'The screen’s full pixel density and the finest sun shadows (0.15 m). Needs a strong graphics card.'],
    ];
    for (const [quality, label, iconName, tip] of choices) {
      const button = tool(label, iconName);
      button.title = tip;
      button.addEventListener('click', () => {
        this.setQuality(quality);
        this.connection.request('site.display', { display: { quality } }).catch((error) => this.say(text(error)));
      });
      this.qualityButtons.set(quality, button);
    }
    return group('Quality', column(...this.qualityButtons.values()));
  }

  /**
   * Off, Soft or Normal for the table's interface sounds (#703): a tap when a layer button is
   * pressed and a chime when the table opens. They play on the table's speakers only, never here,
   * and the controller's sound switch silences them with everything else.
   */
  private soundsGroup(): HTMLElement {
    const choices: [number, string, string, string][] = [
      [0, 'Off', 'muted', 'No taps or chimes from the table.'],
      [0.35, 'Soft', 'sound', 'A quiet tap for each layer button and a chime when the table opens. The default.'],
      [0.8, 'Normal', 'sound', 'The same sounds, louder, for a busy room.'],
    ];
    for (const [sounds, label, iconName, tip] of choices) {
      const button = tool(label, iconName);
      button.title = tip;
      button.addEventListener('click', () => {
        this.setSounds(sounds);
        this.connection.request('site.display', { display: { sounds } }).catch((error) => this.say(text(error)));
      });
      this.soundButtons.set(sounds, button);
    }
    return group('Interface sounds', column(...this.soundButtons.values()));
  }

  /** Shows the nearest of Off, Soft and Normal to the table's sound volume. */
  setSounds(volume: number): void {
    const values = [...this.soundButtons.keys()];
    const near = values.reduce((a, b) => (Math.abs(b - volume) < Math.abs(a - volume) ? b : a), values[0] ?? 0);
    for (const [value, button] of this.soundButtons) {
      button.classList.toggle('is-on', value === near);
      button.setAttribute('aria-pressed', String(value === near));
    }
  }

  /** Shows which quality the table uses. */
  setQuality(quality: DisplayQuality): void {
    for (const [value, button] of this.qualityButtons) {
      button.classList.toggle('is-on', value === quality);
      button.setAttribute('aria-pressed', String(value === quality));
    }
  }

  private projectorGroup(): HTMLElement {
    this.calibrateButton.title = 'Line the projected map up with the physical model, step by step';
    this.calibrateButton.addEventListener('click', () => (this.guide ? this.closeGuide() : this.openGuide()));
    this.clearButton.title = 'Forget the calibration, so the table is shown flat again';
    this.clearButton.addEventListener('click', () => {
      this.connection.request('calibration.set', { projector: null }).catch((error) => this.say(text(error)));
    });
    return group('Projector', this.calibrateButton, column(this.calibrationStatus, this.clearButton));
  }

  /** The dialog is on show: how the projector is lined up, here or in Settings. */
  async show(): Promise<void> {
    this.say(null);
    this.connection
      .request<{ projector: ProjectorCalibration | null }>('calibration.get')
      .then((result) => {
        this.calibrated = Boolean(result.projector);
        this.drawCalibration();
      })
      .catch(() => {});
    this.drawCalibration();
  }

  /** The dialog is put away: no calibration tool left open by it. */
  hide(): void {
    this.closeGuide();
  }

  /** The scene changed. Nothing here follows the layers any more (layer strength is in Settings › Colour). */
  refresh(): void {}




  private drawCalibration(): void {
    this.calibrateButton.classList.toggle('is-on', this.guide !== null || this.calibrating);
    this.calibrationStatus.textContent = this.calibrated ? 'Calibrated' : 'Not calibrated';
    this.clearButton.disabled = !this.calibrated;
    if (this.guide) this.fillGuide(this.guide);
  }

  // ---- The calibration guide (#181) ---------------------------------------------------

  private openGuide(): void {
    const guide = el('section', 'dt-guide');
    guide.setAttribute('role', 'dialog');
    guide.ariaLabel = 'Calibrate the projector';
    const box = this.calibrateButton.getBoundingClientRect();
    guide.style.top = `${box.bottom + 6}px`;
    guide.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 412))}px`;
    (this.preview.closest('.ed') ?? document.body).append(guide);
    this.guide = guide;
    this.savedNow = false;
    void this.checkTable();
    // Whether the map is on the projector can change from elsewhere (Present, Esc on the table).
    this.guideTimer = window.setInterval(() => void this.checkTable(), 2000);
    this.drawCalibration();
  }

  private closeGuide(): void {
    if (this.guideTimer !== null) window.clearInterval(this.guideTimer);
    this.guideTimer = null;
    this.guide?.remove();
    this.guide = null;
    this.drawCalibration();
  }

  private async checkTable(): Promise<void> {
    if (!this.invoke) return;
    try {
      const state = (await this.call('calibration_state')) as { table: boolean };
      if (state.table !== this.tableShown) {
        this.tableShown = state.table;
        this.drawCalibration();
      }
    } catch {
      // An older app: leave it unknown.
    }
  }

  private fillGuide(guide: HTMLElement): void {
    const desktop = Boolean(this.invoke);
    const shown = this.tableShown === true || this.calibrating;
    const head = el('header', 'dt-guide-head');
    const close = el('button', 'dt-guide-close', '×');
    close.type = 'button';
    close.ariaLabel = 'Close';
    close.addEventListener('click', () => this.closeGuide());
    head.append(el('strong', undefined, 'Line the map up with the model'), close);

    const lead = el(
      'p',
      'dt-guide-lead',
      'Calibration teaches MR Studio where the projector’s light falls on your physical model, so the map lands on the right buildings. Do it once for each projector set-up, and again if the projector or the model moves.',
    );

    const steps = el('ol', 'dt-steps');
    const step = (done: boolean, active: boolean, title: string, detail: string, ...actions: HTMLElement[]) => {
      const item = el('li', `dt-step${done ? ' is-done' : ''}${active ? ' is-active' : ''}`);
      const mark = el('span', 'dt-step-mark');
      if (done) mark.append(icon('check', 14));
      const body = el('div', 'dt-step-body');
      body.append(el('strong', undefined, title), el('p', undefined, detail));
      if (actions.length > 0) {
        const row = el('div', 'dt-step-actions');
        row.append(...actions);
        body.append(row);
      }
      item.append(mark, body);
      return item;
    };
    const action = (label: string, primary: boolean, run: () => void) => {
      const node = el('button', primary ? 'ed-button is-primary' : 'ed-button', label);
      node.type = 'button';
      node.addEventListener('click', run);
      return node;
    };

    // 1. The map must be on the projector, since that is where the tool draws.
    const present = desktop
      ? action('Present', true, () => {
          void this.call('present')
            .then(() => this.checkTable())
            .catch((error) => this.say(text(error)));
        })
      : action('Open the Map', true, () => window.open('/table', 'mrstudio-table'));
    steps.append(
      step(
        shown,
        !shown,
        'Show the map on the projector',
        desktop
          ? shown
            ? 'The map is on its display.'
            : 'Present, so the map is projected on the model. With one screen, the map takes it over; Esc brings you back.'
          : 'Open the Map and drag its window onto the projector, full screen.',
        ...(shown ? [] : [present]),
      ),
    );

    // 2. Open the tool there.
    const start = action(this.calibrating ? 'Stop calibrating' : 'Start calibrating', !this.calibrating, () => void this.calibrate(!this.calibrating));
    start.disabled = desktop && !shown;
    steps.append(
      step(
        this.calibrating || this.savedNow,
        shown && !this.calibrating && !this.savedNow,
        'Open the tool on the table',
        'A cross of light appears on the projected table, and nothing else covers the map. It needs the buildings or a 3D model of the place.',
        start,
      ),
    );

    // 3. The corners: the cross is on the table, the words and buttons here and on the controller (#594).
    this.panel ??= remoteCalibrationPanel(this.connection, { compact: true, onChange: () => this.drawCalibration() });
    const panel = this.calibrating && this.panel.isOpen ? [this.panel.element] : [];
    steps.append(
      step(
        this.savedNow,
        this.calibrating && !this.savedNow,
        'Put the cross on each corner',
        'The panel below and the controller name a corner of the model and ring it on a small plan. Click or drag on the table’s screen, or use the arrows, until the cross’s light sits exactly on that corner of the real model. Arrow keys nudge it; hold Shift for bigger steps. Press Next, or Skip a corner you cannot see.',
        ...panel,
      ),
    );

    // 4. Save.
    steps.append(
      step(
        this.savedNow,
        false,
        'Save',
        'After at least 6 of the 10 corners, press Save. The map then follows the model, buildings and all.',
      ),
    );

    const foot = el('footer', 'dt-guide-foot');
    foot.append(el('span', `dt-guide-state${this.calibrated ? ' is-ok' : ''}`, this.calibrated ? 'This table is calibrated.' : 'This table is shown flat, not calibrated.'));
    if (this.calibrated) {
      const flat = action('Use a flat table', false, () => {
        this.connection.request('calibration.set', { projector: null }).catch((error) => this.say(text(error)));
      });
      flat.title = 'Forget the calibration, so the map is drawn flat and straight down again';
      foot.append(flat);
    }
    const problem = el('p', 'dt-guide-problem', this.problem.textContent ?? '');
    problem.hidden = !this.problem.textContent;
    guide.replaceChildren(head, lead, steps, problem, foot);
  }





  private async calibrate(active: boolean): Promise<void> {
    this.say(null);
    try {
      if (this.invoke) {
        // The tool runs on the projected table, so a window must be showing it.
        const state = (await this.call('calibration_state')) as { table: boolean };
        this.tableShown = state.table;
        if (active && !state.table) throw new Error('The map is not on a screen yet. Present first, then start calibrating.');
        await this.call('calibration_mode', { active });
      } else await this.connection.request('calibration.mode', { active });
      this.calibrating = active;
    } catch (error) {
      this.calibrating = false;
      this.say(text(error));
    }
    this.drawCalibration();
  }



}
