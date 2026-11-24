/**
 * Rehearse (#97): try the table as a visitor, from the editor, on one screen. The map stays in
 * the middle; beside it a controller and a phone that can be pressed as visitors would. Nothing
 * is saved and the real displays are not touched. Finishing (or Escape) puts every layer back as
 * it was, and says what the rehearsal covered and what is still to check.
 */
import type { Connection, LayerManifest, LayerState, ReadyCheck } from '@mrstudio/sdk';
import { el, isAmbient } from '../controls.ts';
import type { Store } from '../store.ts';
import { icon } from './icons.ts';

export interface RehearseHost {
  store: Store;
  connection: Connection;
  shell: HTMLElement;
  /** Where the stage goes: under the map, in the middle of the window. */
  centre: HTMLElement;
  /** The table's own layers with buttons, in the order of the controller. */
  buttons: () => { id: string; name: string; manifest: LayerManifest }[];
  checks: () => ReadyCheck[];
  showChecks: () => void;
  /** Tells the editor the rehearsal began or ended, so it can hide and bring back its panels. */
  changed: (on: boolean) => void;
}

type Kept = Record<string, { active: boolean; params: Record<string, unknown> }>;

const FAST_IDLE_S = 20;

export class Rehearsal {
  private stage: HTMLElement | null = null;
  private kept: Kept = {};
  private opened = new Set<string>();
  private started = 0;
  private stop: (() => void) | null = null;
  private keys = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      void this.finish();
    }
  };

  private readonly host: RehearseHost;

  constructor(host: RehearseHost) {
    this.host = host;
  }

  get on(): boolean {
    return this.stage !== null;
  }

  start(): void {
    if (this.stage) return;
    const { store } = this.host;
    const host = this.host;
    // Everything a visitor can change is live state; it is put back at the end.
    this.kept = {};
    for (const [id, state] of Object.entries(store.state.layers)) this.kept[id] = { active: state.active, params: structuredClone(state.params ?? {}) };
    this.opened.clear();
    this.started = performance.now();
    this.stop = store.onLayer((id: string, state: LayerState) => {
      if (state.active && !state.parent) this.opened.add(id);
    });

    const stage = el('div', 'ed-rehearse');
    const bar = el('div', 'ed-rehearse-bar');
    const words = el('div');
    words.append(el('strong', undefined, 'Rehearsing'), el('span', undefined, 'Use the controller and the phone as a visitor would. Nothing is saved, and the real displays are not used.'));
    const fast = el('label', 'ed-rehearse-fast');
    const fastBox = Object.assign(el('input'), { type: 'checkbox' });
    fast.append(fastBox, el('span', undefined, `Go home after ${FAST_IDLE_S} s untouched`));
    fast.title = `The controller goes back to its welcome after ${this.idle()} when nobody touches it. Try it sooner here.`;
    const finish = el('button', 'ed-button is-primary');
    finish.type = 'button';
    finish.append(icon('check', 14), el('span', undefined, 'Finish rehearsal'));
    finish.title = 'Put every layer back as it was (Esc)';
    finish.addEventListener('click', () => void this.finish());
    bar.append(icon('play', 16), words, fast, finish);

    const controller = el('div', 'ed-rehearse-controller');
    const tv = el('iframe');
    tv.title = 'The controller, to press as a visitor';
    tv.src = '/tv';
    controller.append(tv);
    const fit = (): void => {
      const scale = Math.min((controller.clientWidth - 16) / 1600, (controller.clientHeight - 16) / 900);
      tv.style.transform = `translate(-50%, -50%) scale(${Math.max(0.1, scale)})`;
    };
    new ResizeObserver(fit).observe(controller);
    fastBox.addEventListener('change', () => {
      tv.src = fastBox.checked ? `/tv?idle=${FAST_IDLE_S}` : '/tv';
    });

    const phone = el('div', 'ed-rehearse-phone');
    const { code, join_url } = store.state.session;
    if (join_url || code) {
      const frame = el('iframe');
      frame.title = 'A visitor’s phone';
      frame.src = `/phone?c=${encodeURIComponent(code)}`;
      const screen = el('div', 'ed-rehearse-screen');
      screen.append(frame);
      phone.append(el('span', 'ed-rehearse-label', 'A visitor’s phone'), screen);
      // A phone is laid out for its own width; it is scaled down to fit beside the controller.
      new ResizeObserver(() => {
        const scale = Math.min(screen.clientWidth / 406, screen.clientHeight / 816);
        frame.style.transform = `translateX(-50%) scale(${Math.max(0.1, scale)})`;
      }).observe(screen);
    } else phone.append(el('p', 'ed-empty', 'Phones cannot join this table yet, so there is no phone to try.'));

    const row = el('div', 'ed-rehearse-row');
    row.append(controller, phone);
    stage.append(bar, row);
    this.host.centre.append(stage);
    this.stage = stage;
    // Escape inside the controller or the phone ends the rehearsal too (the frames are this page's own).
    for (const frame of stage.querySelectorAll('iframe')) {
      frame.addEventListener('load', () => frame.contentWindow?.addEventListener('keydown', this.keys, true));
    }
    this.host.shell.classList.add('is-rehearse');
    window.addEventListener('keydown', this.keys, true);
    host.changed(true);
  }

  private idle(): string {
    const s = this.host.store.state.site.tv?.idle_reset_s ?? 180;
    return s <= 0 ? 'never' : s % 60 === 0 ? `${s / 60} min` : `${s} s`;
  }

  /** Ends the rehearsal: every layer as it was, then what was tried and what is left. */
  async finish(): Promise<void> {
    if (!this.stage) return;
    window.removeEventListener('keydown', this.keys, true);
    this.stop?.();
    this.stop = null;
    this.stage.remove();
    this.stage = null;
    this.host.shell.classList.remove('is-rehearse');
    const { store, connection } = this.host;
    const minutes = Math.max(1, Math.round((performance.now() - this.started) / 60000));
    for (const [id, was] of Object.entries(this.kept)) {
      const now = store.state.layers[id];
      if (!now) continue;
      const changed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(was.params)) if (JSON.stringify(now.params?.[key]) !== JSON.stringify(value)) changed[key] = value;
      if (Object.keys(changed).length) await connection.request('layer.set', { layer: id, params: changed }).catch(() => {});
      if (now.active !== was.active) await connection.request('layer.activate', { layer: id, active: was.active }).catch(() => {});
    }
    this.host.changed(false);
    this.summary(minutes);
  }

  private summary(minutes: number): void {
    const buttons = this.host.buttons().filter((b) => !isAmbient(b.manifest));
    const tried = buttons.filter((b) => this.opened.has(b.id));
    const missed = buttons.filter((b) => !this.opened.has(b.id));
    const checks = this.host.checks().filter((c) => c.level !== 'nice');
    const dialog = el('dialog', 'im-dialog ed-ask ed-rehearse-summary');
    dialog.ariaLabel = 'Rehearsal';
    const head = el('header', 'im-dialog-head');
    const close = el('button', 'ed-icon-button', '×');
    close.type = 'button';
    close.ariaLabel = 'Close';
    close.addEventListener('click', () => dialog.close());
    head.append(el('h2', undefined, 'Rehearsal finished'), close);
    const list = el('ul', 'ed-rehearse-facts');
    list.append(el('li', undefined, `You opened ${tried.length} of ${buttons.length} layers in about ${minutes} min.`));
    if (missed.length) list.append(el('li', undefined, `Not tried: ${missed.map((b) => b.name).join(', ')}.`));
    list.append(el('li', undefined, checks.length ? `${checks.length} ${checks.length === 1 ? 'thing' : 'things'} to check before presenting.` : 'Nothing left to check before presenting.'));
    list.append(el('li', undefined, 'Every layer is back as it was.'));
    const actions = el('div', 'ed-ask-actions');
    if (checks.length) {
      const show = el('button', 'ed-button', 'Show the checks');
      show.type = 'button';
      show.addEventListener('click', () => {
        dialog.close();
        this.host.showChecks();
      });
      actions.append(show);
    }
    const again = el('button', 'ed-button', 'Rehearse again');
    again.type = 'button';
    again.addEventListener('click', () => {
      dialog.close();
      this.start();
    });
    const done = el('button', 'ed-button is-primary', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => dialog.close());
    actions.append(again, done);
    dialog.append(head, list, actions);
    dialog.addEventListener('close', () => dialog.remove());
    this.host.shell.append(dialog);
    dialog.showModal();
  }
}
