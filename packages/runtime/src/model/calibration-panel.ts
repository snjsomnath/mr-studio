import type { Connection } from '@mrstudio/sdk';

/**
 * The words and buttons of the projector calibration (#594). The table only shows the cross of
 * light and the corners already placed; this panel, which says which corner to find and holds
 * the buttons, is on the controller (and in the editor's calibration guide). The table's tool
 * sends its state through the host (`calibration.state`); the panel's presses go back as
 * `calibration.command`.
 */
export interface CalibrationState {
  /** False when the tool closed. */
  open: boolean;
  /** The corner being placed, from 0. */
  index: number;
  count: number;
  /** Which corner, in words. */
  label: string;
  /** How far along, or how good the fit is. */
  status: string;
  problem: boolean;
  /** Corners placed so far, and the number needed to solve. */
  placed: number;
  needed: number;
  /** For each corner, whether it is placed. */
  done: boolean[];
  /** True once enough corners give a camera: Save and the model check can be used. */
  solved: boolean;
  showModel: boolean;
  /** True when the tool runs in a preview window, not on the projected table. */
  preview: boolean;
  /** The site from above with the corner ringed, as a picture. Sent only when it changed. */
  plan?: string;
  /** Changes whenever the plan picture does. */
  planKey: string;
}

export type CalibrationAction = 'sync' | 'back' | 'next' | 'skip' | 'select' | 'nudge' | 'model' | 'save' | 'flat';

export interface CalibrationCommand {
  action: CalibrationAction;
  /** For `nudge`: pixels on the table. */
  dx?: number;
  dy?: number;
  /** For `select`: the corner. */
  index?: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The panel. `send` passes a press on: through the host on the controller, straight to the tool
 * on the table. `close` ends calibrating.
 */
export class CalibrationPanel {
  readonly element: HTMLElement;
  private readonly send: (command: CalibrationCommand) => void;
  private state: CalibrationState | null = null;
  private plan = '';
  private readonly title = el('h2', 'cp-title');
  private readonly label = el('p', 'cp-label');
  private readonly picture = el('img', 'cp-plan');
  private readonly corners = el('div', 'cp-corners');
  private readonly status = el('p', 'cp-status');
  private readonly saveButton: HTMLButtonElement;
  private readonly modelButton: HTMLButtonElement;
  private readonly flatButton: HTMLButtonElement;
  private readonly note = el('p', 'cp-help');
  private keys = false;

  constructor(send: (command: CalibrationCommand) => void, close: () => void, options: { compact?: boolean } = {}) {
    this.send = send;
    const root = el('section', `calibration-remote${options.compact ? ' is-compact' : ''}`);
    root.setAttribute('aria-label', 'Calibrate the projector');
    this.element = root;
    this.picture.alt = 'The site from above, with the corner to find ringed in yellow';
    const button = (text: string, action: () => void, className = '') => {
      const node = el('button', `cp-button ${className}`.trim(), text);
      node.type = 'button';
      node.addEventListener('click', action);
      return node;
    };
    const steps = el('div', 'cp-row');
    steps.append(
      button('Back', () => send({ action: 'back' })),
      button('Skip', () => send({ action: 'skip' })),
      button('Next', () => send({ action: 'next' }), 'is-primary'),
    );
    // A touch screen has no arrow keys: a pad nudges the cross, a little or (outer arrows) a lot.
    const pad = el('div', 'cp-pad');
    pad.setAttribute('aria-label', 'Nudge the cross');
    const nudge = (text: string, title: string, dx: number, dy: number, area: string) => {
      const node = button(text, () => send({ action: 'nudge', dx, dy }), 'cp-nudge');
      node.title = title;
      node.style.gridArea = area;
      return node;
    };
    pad.append(
      nudge('⇈', 'Up 10 px', 0, -10, 'uu'),
      nudge('↑', 'Up 1 px', 0, -1, 'u'),
      nudge('⇇', 'Left 10 px', -10, 0, 'll'),
      nudge('←', 'Left 1 px', -1, 0, 'l'),
      nudge('→', 'Right 1 px', 1, 0, 'r'),
      nudge('⇉', 'Right 10 px', 10, 0, 'rr'),
      nudge('↓', 'Down 1 px', 0, 1, 'd'),
      nudge('⇊', 'Down 10 px', 0, 10, 'dd'),
    );
    this.modelButton = button('', () => send({ action: 'model' }));
    this.saveButton = button('Save', () => send({ action: 'save' }), 'is-primary');
    const actions = el('div', 'cp-row');
    actions.append(this.modelButton, this.saveButton);
    this.flatButton = button('Use flat table', () => send({ action: 'flat' }));
    const ending = el('div', 'cp-row');
    ending.append(this.flatButton, button('Stop calibrating', close));
    const help = el(
      'p',
      'cp-help',
      'Put the cross on the corner: click or drag on the table’s screen, or use the arrows here. Arrow keys nudge it too (Shift for bigger steps); Enter goes to the next corner.',
    );
    const look = el('div', 'cp-look');
    look.append(this.picture, this.corners);
    const work = el('div', 'cp-work');
    work.append(this.label, pad, steps, this.status, actions, ending, help, this.note);
    const head = el('header', 'cp-head');
    head.append(this.title);
    root.append(head, look, work);
    root.hidden = true;
  }

  /** Arrow keys and Enter on this window steer the cross too, while the panel shows. */
  listenForKeys(): () => void {
    if (this.keys) return () => {};
    this.keys = true;
    const onKey = (event: KeyboardEvent) => {
      if (this.element.hidden || !this.element.isConnected) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const step = event.shiftKey ? 10 : 1;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = moves[event.key];
      if (move) this.send({ action: 'nudge', dx: move[0], dy: move[1] });
      else if (event.key === 'Enter' && !(target instanceof HTMLButtonElement)) this.send({ action: 'next' });
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      this.keys = false;
    };
  }

  get isOpen(): boolean {
    return this.state?.open === true;
  }

  show(state: CalibrationState): void {
    this.state = state;
    if (state.plan) this.plan = state.plan;
    this.element.hidden = !state.open;
    if (!state.open) return;
    this.title.textContent = `Corner ${state.index + 1} of ${state.count}`;
    this.label.textContent = `${state.label}. Move the cross until its light sits on that corner of the model.`;
    if (this.plan && this.picture.src !== this.plan) this.picture.src = this.plan;
    this.corners.replaceChildren(
      ...state.done.map((done, index) => {
        const chip = el('button', `cp-corner${done ? ' is-done' : ''}${index === state.index ? ' is-current' : ''}`, String(index + 1));
        chip.type = 'button';
        chip.title = done ? `Corner ${index + 1}, placed` : `Corner ${index + 1}`;
        chip.addEventListener('click', () => this.send({ action: 'select', index }));
        return chip;
      }),
    );
    this.status.textContent = state.status;
    this.status.classList.toggle('is-problem', state.problem);
    this.saveButton.disabled = !state.solved;
    this.modelButton.disabled = !state.solved;
    this.modelButton.textContent = state.showModel ? 'Hide the model' : 'Show the model';
    this.note.textContent = state.preview ? 'The tool is open in a preview window. To calibrate the real projector, open it on the projected table.' : '';
    this.note.hidden = !state.preview;
  }

  hide(): void {
    if (this.state) this.state = { ...this.state, open: false };
    this.element.hidden = true;
  }
}

/**
 * The panel on a controller: shown while the table's tool is open, fed by its state, its presses
 * sent through the host. Returns the panel; `onChange` hears it open and close.
 */
export function remoteCalibrationPanel(connection: Connection, options: { compact?: boolean; onChange?: (open: boolean) => void } = {}): CalibrationPanel {
  const send = (command: CalibrationCommand) => void connection.request('calibration.command', command).catch(() => {});
  const panel = new CalibrationPanel(send, () => void connection.request('calibration.mode', { active: false }).catch(() => {}), options);
  let open = false;
  const changed = (next: boolean) => {
    if (next === open) return;
    open = next;
    options.onChange?.(open);
  };
  connection.on('calibration.state', (state: CalibrationState) => {
    panel.show(state);
    changed(state.open);
  });
  connection.on('calibration.mode', (p: { active: boolean }) => {
    if (p.active) send({ action: 'sync' });
    else {
      panel.hide();
      changed(false);
    }
  });
  // A controller that starts while the tool is already open asks for where it is.
  send({ action: 'sync' });
  panel.listenForKeys();
  return panel;
}
