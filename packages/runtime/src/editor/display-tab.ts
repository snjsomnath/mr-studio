// The editor's Display ribbon tab (#151, #153): the final colour pass per display, its
// presets and test card, how strongly each layer is drawn, and the projector calibration.
// These are app settings (#73), kept per display by the desktop app in `colour.json`; this
// tab is the editor's way to them, the same commands as the Colour tab of Displays and
// settings (apps/studio/ui/colour.js). In a browser only the calibration is offered.
// Quality (#134) is the exception: it belongs to the table, saved in site.json, so it shows everywhere.

import type { Connection, DisplayQuality, ProjectorCalibration } from '@mrstudio/sdk';

import { el } from '../controls.ts';
import { icon } from './icons.ts';

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

interface DisplayColour {
  display: number;
  name: string;
  role: string | null;
  colour: Colour;
}
interface Preset {
  name: string;
  built_in: boolean;
  colour: Colour;
}
interface LayerIntensity {
  id: string;
  name: string;
  active: boolean;
  intensity: number;
}
interface ColourState {
  displays: DisplayColour[];
  presets: Preset[];
  layers: LayerIntensity[];
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
const REMEMBER = 'mrs-editor-colour-display';

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

/** One compact slider: a label, the range and its value. Double-click puts it back to neutral. */
function slider(label: string, min: number, max: number, neutral: number, onInput: (value: number) => void): { row: HTMLElement; set: (value: number | null) => void } {
  const row = el('label', 'dt-slider');
  const range = el('input');
  Object.assign(range, { type: 'range', min: String(min), max: String(max), step: '0.01' });
  range.ariaLabel = label;
  const output = el('output');
  row.append(el('span', 'dt-slider-label', label), range, output);
  const change = (value: number) => {
    output.textContent = value.toFixed(2);
    onInput(value);
  };
  range.addEventListener('input', () => change(Number(range.value)));
  range.addEventListener('dblclick', () => {
    range.value = String(neutral);
    change(neutral);
  });
  row.title = 'Double-click to put it back';
  return {
    row,
    set: (value) => {
      range.disabled = value === null;
      range.value = String(value ?? neutral);
      output.textContent = value === null ? '' : value.toFixed(2);
    },
  };
}

/** Sends only the latest value, once the one before has been answered: sliders fire faster than the shell needs. */
function latest<T>(send: (value: T) => Promise<unknown>, onError: (error: unknown) => void): (value: T) => void {
  let next: { value: T } | null = null;
  let busy = false;
  return (value) => {
    next = { value };
    if (busy) return;
    busy = true;
    void (async () => {
      while (next) {
        const { value: now } = next;
        next = null;
        await send(now).catch(onError);
      }
      busy = false;
    })();
  };
}

export class DisplayTab {
  /** The ribbon groups, made once and kept, so a slider being dragged is never rebuilt under the pointer. */
  readonly groups: HTMLElement[];
  private readonly invoke: Invoke | undefined;
  private readonly connection: Connection;
  private readonly preview: HTMLElement;
  private readonly openSettings: () => void;
  private state: ColourState | null = null;
  private display: number | null = null;
  private open = false;
  private previewOn = true;
  private testCardOn = false;
  private calibrating = false;
  private calibrated = false;

  private readonly displaySelect = el('select', 'dt-select');
  private readonly presetSelect = el('select', 'dt-select');
  private readonly presetName = el('input', 'dt-input');
  private readonly saveButton = tool('Save', 'save');
  private readonly deleteButton = tool('Delete', 'trash');
  private readonly resetButton = tool('Neutral', 'reset');
  private readonly testCardButton = tool('Test card', 'bars');
  private readonly previewButton = tool('Preview here', 'eye');
  private readonly layersButton = tool('Layer strength', 'layers', true);
  private readonly calibrateButton = tool('Calibrate', 'crosshair', true);
  private readonly clearButton = tool('Clear', 'trash');
  private readonly calibrationStatus = el('span', 'dt-status');
  private readonly qualityButtons = new Map<DisplayQuality, HTMLButtonElement>();
  private readonly problem = el('span', 'dt-status is-error');
  private readonly sliders = new Map<keyof Colour, ReturnType<typeof slider>>();
  private popover: HTMLElement | null = null;
  /** The calibration guide, while it is open (#181). */
  private guide: HTMLElement | null = null;
  private guideTimer: number | null = null;
  /** A window shows the table, so the tool has somewhere to open; null when it cannot be known (a browser). */
  private tableShown: boolean | null = null;
  /** Saved while the guide was open, to tick its last step. */
  private savedNow = false;
  private stopAway: (() => void) | null = null;
  private readonly sendColour: (value: { display: number; colour: Colour }) => void;
  private readonly sendLayer: (value: { layer: string; intensity: number }) => void;

  /** `preview` is the editor's map, which shows the chosen display's colour while this tab is open. */
  constructor(invoke: Invoke | undefined, connection: Connection, preview: HTMLElement, openSettings: () => void) {
    this.invoke = invoke;
    this.connection = connection;
    this.preview = preview;
    this.openSettings = openSettings;
    const fail = (error: unknown) => this.say(text(error));
    this.sendColour = latest((value) => this.call('set_colour', value), fail);
    this.sendLayer = latest((value) => this.call('set_layer_intensity', value), fail);

    const groups: HTMLElement[] = [];
    if (invoke) groups.push(...this.colourGroups());
    else {
      const note = el('p', 'dt-note', 'The colour of each display is set in the MR Studio desktop app, where the table is projected.');
      groups.push(group('Colour', note));
    }
    groups.push(this.qualityGroup(), this.projectorGroup());
    if (invoke) {
      const more = tool('Displays and settings', 'settings', true);
      more.title = 'Which display shows the table and the controller, updates, and every display setting';
      more.addEventListener('click', () => this.openSettings());
      const last = group('More', more);
      last.classList.add('is-last');
      groups.push(last);
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

  private current(): DisplayColour | undefined {
    return this.state?.displays.find((d) => d.display === this.display);
  }

  private colourGroups(): HTMLElement[] {
    this.displaySelect.ariaLabel = 'Display';
    this.displaySelect.addEventListener('change', () => {
      this.setTestCard(false);
      this.display = Number(this.displaySelect.value);
      try {
        localStorage.setItem(REMEMBER, this.current()?.name ?? '');
      } catch {
        // No storage: the choice is not remembered.
      }
      this.draw();
    });
    this.testCardButton.title = 'Colour bars and grey steps on that display, to judge the settings on the real surface';
    this.testCardButton.addEventListener('click', () => this.setTestCard(!this.testCardOn));
    this.previewButton.title = 'Show this display’s colour on the map here, while this tab is open';
    this.previewButton.addEventListener('click', () => {
      this.previewOn = !this.previewOn;
      this.drawPreview();
    });
    const display = group('Display', column(this.displaySelect, this.testCardButton, this.previewButton));

    this.presetSelect.ariaLabel = 'Preset';
    this.presetSelect.addEventListener('change', () => {
      const preset = this.state?.presets.find((p) => p.name === this.presetSelect.value);
      if (preset) this.setColour({ ...preset.colour });
    });
    Object.assign(this.presetName, { type: 'text', placeholder: 'New preset name', maxLength: 40 });
    this.presetName.ariaLabel = 'New preset name';
    this.saveButton.title = 'Keep these settings as a preset on this computer';
    this.saveButton.addEventListener('click', () => void this.savePreset());
    this.presetName.addEventListener('keydown', (event) => event.key === 'Enter' && void this.savePreset());
    this.deleteButton.title = 'Forget this saved preset';
    this.deleteButton.addEventListener('click', () => void this.deletePreset());
    this.resetButton.title = 'Back to neutral: the colours as they are drawn';
    this.resetButton.addEventListener('click', () => this.setColour({ ...NEUTRAL }));
    const actions = el('div', 'dt-row');
    actions.append(this.saveButton, this.deleteButton, this.resetButton);
    const presets = group('Preset', column(this.presetSelect, this.presetName, actions));

    const columns = [column(), column()];
    SLIDERS.forEach(([key, label, min, max, neutral], i) => {
      const s = slider(label, min, max, neutral, (value) => {
        const now = this.current();
        if (!now) return;
        now.colour[key] = value;
        this.drawPresets();
        this.drawPreview();
        this.sendColour({ display: now.display, colour: { ...now.colour } });
      });
      this.sliders.set(key, s);
      columns[i < 3 ? 0 : 1]!.append(s.row);
    });
    const colour = group('Colour and post-processing', ...columns);
    colour.append(this.problem);
    this.problem.hidden = true;

    this.layersButton.title = 'How strongly each layer is drawn on the table, from faint to twice as bright';
    this.layersButton.addEventListener('click', () => this.toggleLayers());
    const layers = group('Layers', this.layersButton);
    return [display, presets, colour, layers];
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

  /** The tab is on show: fetch what the desktop app knows, and preview the colour. */
  async show(): Promise<void> {
    this.open = true;
    this.say(null);
    this.connection
      .request<{ projector: ProjectorCalibration | null }>('calibration.get')
      .then((result) => {
        this.calibrated = Boolean(result.projector);
        this.drawCalibration();
      })
      .catch(() => {});
    this.drawCalibration();
    if (!this.invoke) return;
    try {
      this.state = (await this.call('colour_state')) as ColourState;
    } catch (error) {
      this.say(text(error));
      return;
    }
    if (!this.current()) {
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(REMEMBER);
      } catch {
        // No storage.
      }
      const displays = this.state.displays;
      // The table's display is the one worth tuning; then the one chosen last time.
      const preferred = displays.find((d) => d.role === 'table') ?? displays.find((d) => d.name === remembered) ?? displays.find((d) => d.role) ?? displays[0];
      this.display = preferred?.display ?? null;
    }
    this.draw();
  }

  /** The tab is put away: no preview, no test card, no calibration tool left open by it. */
  hide(): void {
    this.open = false;
    this.closeGuide();
    this.setTestCard(false);
    this.closeLayers();
    this.drawPreview();
  }

  /** The scene changed: the list of layers may have. */
  refresh(): void {
    if (this.open && this.invoke && this.popover) {
      this.call('colour_state')
        .then((state) => {
          this.state = state as ColourState;
          if (this.popover) this.fillLayers(this.popover);
        })
        .catch(() => {});
    }
  }

  private draw(): void {
    const state = this.state;
    if (!state) return;
    this.displaySelect.replaceChildren(
      ...state.displays.map((d) => {
        const option = el('option', undefined, `${d.display + 1} · ${d.name}${d.role ? ` · ${d.role === 'tv' ? 'controller' : d.role}` : ''}`);
        option.value = String(d.display);
        return option;
      }),
    );
    if (this.display !== null) this.displaySelect.value = String(this.display);
    this.displaySelect.disabled = state.displays.length === 0;
    const colour = this.current()?.colour;
    for (const [key, s] of this.sliders) s.set(colour ? colour[key] : null);
    this.testCardButton.disabled = !colour;
    this.drawPresets();
    this.drawPreview();
  }

  private drawPresets(): void {
    const state = this.state;
    if (!state) return;
    const colour = this.current()?.colour;
    const match = colour && state.presets.find((p) => same(p.colour, colour));
    const custom = el('option', undefined, 'Custom');
    custom.value = '';
    custom.disabled = true;
    custom.hidden = Boolean(match);
    this.presetSelect.replaceChildren(
      custom,
      ...state.presets.map((p) => {
        const option = el('option', undefined, p.name);
        option.value = p.name;
        return option;
      }),
    );
    this.presetSelect.value = match?.name ?? '';
    this.presetSelect.disabled = !colour;
    this.saveButton.disabled = !colour;
    this.resetButton.disabled = !colour || same(colour, NEUTRAL);
    this.deleteButton.disabled = !match || match.built_in;
  }

  private drawPreview(): void {
    const colour = this.current()?.colour;
    this.previewButton.setAttribute('aria-pressed', String(this.previewOn));
    this.previewButton.classList.toggle('is-on', this.previewOn);
    // On the table itself, not the grey around it.
    const surface = this.preview.querySelector<HTMLElement>('.table-surface') ?? this.preview;
    previewColour(surface, this.open && this.previewOn && colour ? colour : null);
  }

  private drawCalibration(): void {
    this.calibrateButton.classList.toggle('is-on', this.guide !== null || this.calibrating);
    this.calibrationStatus.textContent = this.calibrated ? 'Calibrated' : 'Not calibrated';
    this.clearButton.disabled = !this.calibrated;
    if (this.guide) this.fillGuide(this.guide);
  }

  // ---- The calibration guide (#181) ---------------------------------------------------

  private openGuide(): void {
    this.closeLayers();
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
        'A cross of light and a small panel appear on the projected table. It needs the buildings or a 3D model of the place.',
        start,
      ),
    );

    // 3. The corners, done on the table itself.
    steps.append(
      step(
        this.savedNow,
        this.calibrating && !this.savedNow,
        'Put the cross on each corner',
        'The panel on the table names a corner of the model and shows it on a small map. Move the mouse onto the table’s screen and click or drag until the cross’s light sits exactly on that corner of the real model. Arrow keys nudge it; hold Shift for bigger steps. Press Next, or Skip a corner you cannot see.',
      ),
    );

    // 4. Save.
    steps.append(
      step(
        this.savedNow,
        false,
        'Save',
        'After at least 6 of the 10 corners, press Save on the table. The map then follows the model, buildings and all.',
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

  private setColour(colour: Colour): void {
    const now = this.current();
    if (!now) return;
    now.colour = colour;
    this.draw();
    this.sendColour({ display: now.display, colour: { ...colour } });
  }

  private setTestCard(on: boolean): void {
    if (!this.invoke || (on === this.testCardOn && !on)) return;
    this.testCardOn = on;
    this.testCardButton.setAttribute('aria-pressed', String(on));
    this.testCardButton.classList.toggle('is-on', on);
    if (this.display !== null) void this.call('test_card', { display: this.display, on }).catch(() => {});
  }

  private async savePreset(): Promise<void> {
    const now = this.current();
    if (!now || !this.state) return;
    this.say(null);
    try {
      await this.call('save_preset', { name: this.presetName.value, colour: now.colour });
      this.presetName.value = '';
      this.state = (await this.call('colour_state')) as ColourState;
      this.draw();
    } catch (error) {
      this.say(text(error));
    }
  }

  private async deletePreset(): Promise<void> {
    try {
      await this.call('delete_preset', { name: this.presetSelect.value });
      this.state = (await this.call('colour_state')) as ColourState;
      this.draw();
    } catch (error) {
      this.say(text(error));
    }
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

  private toggleLayers(): void {
    if (this.popover) {
      this.closeLayers();
      return;
    }
    const popover = el('div', 'dt-popover');
    this.fillLayers(popover);
    const box = this.layersButton.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 336))}px`;
    popover.style.top = `${box.bottom + 6}px`;
    (this.preview.closest('.ed') ?? document.body).append(popover);
    this.popover = popover;
    this.layersButton.classList.add('is-on');
    // A press anywhere else puts it away, even on the map, which keeps its clicks to itself.
    const away = (event: PointerEvent) => {
      if (popover.contains(event.target as Node) || this.layersButton.contains(event.target as Node)) return;
      this.closeLayers();
    };
    // A press in the controller preview's frame never reaches this page, but takes the focus from it.
    const blur = () => this.closeLayers();
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', blur);
    this.stopAway = () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', blur);
    };
  }

  private fillLayers(popover: HTMLElement): void {
    const layers = this.state?.layers ?? [];
    const rows = layers.map((layer) => {
      const s = slider(layer.active ? layer.name : `${layer.name} (off)`, 0, 2, 1, (value) => {
        layer.intensity = value;
        this.sendLayer({ layer: layer.id, intensity: value });
      });
      s.set(layer.intensity);
      return s.row;
    });
    popover.replaceChildren(
      el('strong', undefined, 'Layer strength'),
      el('p', undefined, 'How strongly each layer is drawn on the table. 1 is as made; double-click a slider to put it back.'),
      ...(rows.length > 0 ? rows : [el('p', undefined, 'There are no layers on this table yet.')]),
    );
  }

  private closeLayers(): void {
    this.stopAway?.();
    this.stopAway = null;
    this.popover?.remove();
    this.popover = null;
    this.layersButton.classList.remove('is-on');
  }
}
