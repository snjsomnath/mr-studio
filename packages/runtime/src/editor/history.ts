/**
 * Undo, redo and the History panel (#57), on the host's revision history (#72).
 *
 * The host keeps every version of site.json, whoever made it: this editor, another
 * editor, the controller, an import, the MCP server or a hand edit of the file. So undo
 * here can take back a change the MCP server made, and a change made somewhere else
 * shows up as a notice with its own Undo.
 */
import type { Connection } from '@mrstudio/sdk';

import { el } from '../controls.ts';
import { describeChange, type DiffNames } from './history-diff.ts';
import { icon } from './icons.ts';

export type By = 'editor' | 'controller' | 'mcp' | 'import' | 'history' | 'outside' | 'start';

export interface Revision {
  rev: number;
  at: number;
  by: By;
  summary: string;
  keys: string[];
  surface?: number;
}

interface HistoryList {
  revisions: Revision[];
  head: number;
  can_undo: boolean;
  can_redo: boolean;
}

interface HistoryChanged {
  revision: Revision;
  head: number;
  stepped: boolean;
  can_undo: boolean;
  can_redo: boolean;
}

const WHO: Record<By, string> = {
  editor: 'Editor',
  controller: 'Controller',
  mcp: 'AI assistant (MCP)',
  import: 'Add data',
  history: 'History',
  outside: 'Outside MR Studio',
  start: 'Opened',
};

const WHO_ICON: Record<By, string> = {
  editor: 'pencil',
  controller: 'tv',
  mcp: 'sparkle',
  import: 'plus',
  history: 'reset',
  outside: 'code',
  start: 'home',
};

/** "just now", "4 min ago", "yesterday 14:05". */
export function ago(at: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - at);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const date = new Date(at * 1000);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const today = new Date(now * 1000);
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date((now - 86400) * 1000);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/** True when the keys are for the text being typed, which keeps its own undo. */
function typing(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  if (active.isContentEditable) return true;
  if (active instanceof HTMLTextAreaElement) return true;
  return active instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'color'].includes(active.type);
}

export class HistoryControls {
  readonly undoButton: HTMLButtonElement;
  readonly redoButton: HTMLButtonElement;
  private canUndo = false;
  private canRedo = false;
  private list: HistoryList | null = null;
  private panel: HTMLElement | null = null;
  private notice: HTMLElement | null = null;
  private noticeTimer = 0;
  private busy = false;
  private keyed: { what: string; at: number } | null = null;
  /** The names the editor knows, for the lines that say what a version changed (#395). */
  names: DiffNames = { layer: () => undefined, control: () => undefined };
  /** What each version changed, once asked for: it never changes. */
  private readonly details = new Map<number, string[]>();
  private readonly shown = new Set<number>();

  private readonly connection: Connection;
  /** This editor's surface, so its own changes are not announced back to it. */
  private readonly surface: () => number | undefined;
  /** Shows a problem (or clears it) on the status beside the table's name. */
  private readonly report: (problem?: string) => void;

  constructor(connection: Connection, surface: () => number | undefined, report: (problem?: string) => void) {
    this.connection = connection;
    this.surface = surface;
    this.report = report;
    this.undoButton = this.stepButton('undo');
    this.redoButton = this.stepButton('redo');
    connection.on('history.changed', (p: HistoryChanged) => this.changed(p));
    connection.on('site.problem', (p: { message: string }) =>
      this.announce('site.json was changed outside MR Studio and has a mistake in it. The table keeps showing the last good version.', p.message, true),
    );
    connection.on('welcome', () => void this.refresh());
    void this.refresh();
    window.addEventListener('keydown', (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey || typing()) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        this.keyed = { what: 'undo', at: performance.now() };
        void this.step('undo');
      } else if ((key === 'z' && event.shiftKey) || (key === 'y' && !event.metaKey)) {
        event.preventDefault();
        this.keyed = { what: 'redo', at: performance.now() };
        void this.step('redo');
      }
    });
    // The app's Edit menu (src-tauri file_menu.rs) sends Undo and Redo here; text being typed keeps its own.
    window.addEventListener('mrs-edit', (event) => {
      const what = (event as CustomEvent<{ action: string }>).detail.action;
      if (what !== 'undo' && what !== 'redo') return;
      // The same key press can arrive from the page and from the menu's shortcut: once is enough.
      if (this.keyed?.what === what && performance.now() - this.keyed.at < 500) return;
      if (typing()) document.execCommand(what);
      else void this.step(what);
    });
    document.addEventListener('pointerdown', (event) => {
      if (this.panel && !this.panel.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('.ed-saved')) this.closePanel();
    });
    window.addEventListener('keydown', (event) => event.key === 'Escape' && this.closePanel());
  }

  /** Undo or redo, from the buttons, the keys or the menu. */
  async step(what: 'undo' | 'redo'): Promise<void> {
    if (this.busy || !(what === 'undo' ? this.canUndo : this.canRedo)) return;
    this.busy = true;
    try {
      const list = await this.connection.request<HistoryList>(`history.${what}`);
      this.take(list);
      this.report();
    } catch (error) {
      this.report((error as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** File › Version history… (#395): opens the panel, or leaves it open. */
  open(anchor: HTMLElement): void {
    if (!this.panel) this.toggle(anchor);
  }

  /** Opens or closes the History panel under `anchor` (the "Saved" status). */
  toggle(anchor: HTMLElement): void {
    if (this.panel) {
      this.closePanel();
      return;
    }
    const panel = el('section', 'ed-history');
    panel.setAttribute('role', 'dialog');
    panel.ariaLabel = 'Version history';
    this.panel = panel;
    this.drawPanel();
    const box = anchor.getBoundingClientRect();
    panel.style.top = `${box.bottom + 8}px`;
    panel.style.left = `${Math.max(12, Math.min(window.innerWidth - 432, box.left + box.width / 2 - 210))}px`;
    this.host().append(panel);
    void this.refresh();
  }

  /** Inside the editor, where its colours are defined. */
  private host(): HTMLElement {
    return document.querySelector<HTMLElement>('.ed') ?? document.body;
  }

  private closePanel(): void {
    this.panel?.remove();
    this.panel = null;
  }

  private stepButton(what: 'undo' | 'redo'): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'ed-icon-button';
    node.append(icon(what, 16));
    node.ariaLabel = what === 'undo' ? 'Undo' : 'Redo';
    node.disabled = true;
    node.addEventListener('click', () => void this.step(what));
    return node;
  }

  private async refresh(): Promise<void> {
    try {
      this.take(await this.connection.request<HistoryList>('history.list'));
    } catch {
      // An older host without a history: the buttons stay off.
    }
  }

  private take(list: HistoryList): void {
    this.list = list;
    this.canUndo = list.can_undo;
    this.canRedo = list.can_redo;
    this.drawButtons();
    if (this.panel) this.drawPanel();
  }

  private changed(p: HistoryChanged): void {
    this.canUndo = p.can_undo;
    this.canRedo = p.can_redo;
    this.drawButtons();
    void this.refresh();
    const mine = p.revision.surface !== undefined && p.revision.surface === this.surface();
    if (p.stepped || mine || p.revision.by === 'start') return;
    // Someone or something else changed the table: say so, with a way back.
    if (p.revision.by === 'editor' && p.revision.surface !== undefined) this.announce(`Another editor: ${p.revision.summary}`);
    else if (p.revision.by === 'controller') this.announce(`From the controller: ${p.revision.summary}`);
    else if (p.revision.by === 'mcp') this.announce(`From the AI assistant: ${p.revision.summary}`);
    else if (p.revision.by === 'outside') this.announce(`${p.revision.summary}.`);
  }

  private drawButtons(): void {
    const top = this.list?.revisions.find((r) => r.rev === this.list?.head);
    const next = this.list ? this.list.revisions[this.list.revisions.findIndex((r) => r.rev === this.list?.head) - 1] : undefined;
    const keys = navigator.platform.startsWith('Mac') ? ['⌘Z', '⇧⌘Z'] : ['Ctrl+Z', 'Ctrl+Y'];
    this.undoButton.disabled = !this.canUndo;
    this.redoButton.disabled = !this.canRedo;
    this.undoButton.title = this.canUndo && top ? `Undo: ${top.summary} (${keys[0]})` : 'Nothing to undo';
    this.redoButton.title = this.canRedo && next ? `Redo: ${next.summary} (${keys[1]})` : 'Nothing to redo';
  }

  private drawPanel(): void {
    const panel = this.panel;
    if (!panel) return;
    const head = el('header', 'ed-history-head');
    head.append(el('strong', undefined, 'Version history'), el('span', undefined, 'Every change is saved. See what one did, or go back to it.'));
    const list = el('ol', 'ed-history-list');
    const revisions = this.list?.revisions ?? [];
    const headIndex = revisions.findIndex((r) => r.rev === this.list?.head);
    revisions.forEach((revision, n) => {
      const undone = n < headIndex;
      const current = n === headIndex;
      const row = el('li', `ed-history-row${undone ? ' is-undone' : ''}${current ? ' is-current' : ''}`);
      const badge = el('span', 'ed-history-who');
      badge.append(icon(WHO_ICON[revision.by] ?? 'pencil', 14));
      badge.title = WHO[revision.by] ?? revision.by;
      const text = el('div', 'ed-history-text');
      const by = revision.surface !== undefined && revision.surface === this.surface() ? 'You' : (WHO[revision.by] ?? revision.by);
      text.append(el('span', 'ed-history-summary', revision.summary), el('span', 'ed-history-meta', `${by} · ${ago(revision.at)}${undone ? ' · undone' : ''}`));
      row.append(badge, text);
      // What it changed (#395): asked of the host once, then kept.
      const what = document.createElement('button');
      what.type = 'button';
      what.className = 'ed-history-what';
      what.textContent = this.shown.has(revision.rev) ? 'Hide' : 'What changed';
      what.setAttribute('aria-expanded', String(this.shown.has(revision.rev)));
      what.addEventListener('click', () => void this.toggleDetail(revision.rev));
      text.append(what);
      if (this.shown.has(revision.rev)) {
        const lines = this.details.get(revision.rev);
        const list = el('ul', 'ed-history-detail');
        for (const line of lines ?? ['…']) list.append(el('li', undefined, line));
        text.append(list);
      }
      if (current) row.append(el('span', 'ed-history-now', 'Now'));
      else {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'ed-history-back';
        back.textContent = undone ? 'Redo to here' : 'Go back';
        back.title = undone ? 'Bring the table forward to this version' : 'Make the table as it was after this change. Nothing is lost: this goes on the list as a new change.';
        back.addEventListener('click', () => void this.restore(revision, undone));
        row.append(back);
      }
      list.append(row);
    });
    const foot = el('footer', 'ed-history-foot', 'Kept on this computer: the last 200 changes to this table.');
    panel.replaceChildren(head, list, foot);
  }

  private async toggleDetail(rev: number): Promise<void> {
    if (this.shown.delete(rev)) return this.drawPanel();
    this.shown.add(rev);
    this.drawPanel();
    if (this.details.has(rev)) return;
    try {
      const got = await this.connection.request<{ before: Record<string, unknown> | null; after: Record<string, unknown> }>('history.get', { revision: rev });
      this.details.set(rev, describeChange(got.before, got.after, this.names));
    } catch (error) {
      this.details.set(rev, [`Could not read it: ${(error as Error).message}`]);
    }
    this.drawPanel();
  }

  private async restore(revision: Revision, undone: boolean): Promise<void> {
    try {
      if (undone) {
        // Redo step by step to that version, so what was undone after it can still be redone.
        while (this.list && this.list.head !== revision.rev && this.canRedo) {
          this.take(await this.connection.request<HistoryList>('history.redo'));
        }
      } else {
        this.take(await this.connection.request<HistoryList>('history.restore', { revision: revision.rev }));
      }
      this.report();
    } catch (error) {
      this.report((error as Error).message);
    }
  }

  /** A notice at the bottom of the editor with Undo, for a change made in one key press (Delete) that is easy to miss. */
  undoable(message: string, detail?: string): void {
    this.announce(message, detail, false, true);
  }

  /** A notice at the bottom of the editor, without Undo: for something done outside the table, such as an export. */
  notify(message: string, detail?: string): void {
    this.announce(message, detail, false, false);
  }

  /** A notice at the bottom of the editor, with Undo, that goes away by itself. */
  /** A change from elsewhere to the field being typed in (#396): the author's text stays, theirs is one click away. */
  offer(message: string, detail: string, label: string, take: () => void): void {
    this.notice?.remove();
    this.announce(message, detail, false, false);
    const notice = this.notice;
    if (!notice) return;
    notice.dataset.offer = 'true';
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'ed-toast-button';
    use.textContent = label;
    use.addEventListener('click', () => {
      notice.remove();
      take();
    });
    notice.querySelector('.ed-toast-close')?.before(use);
  }

  private announce(message: string, detail?: string, problem = false, offerUndo = true): void {
    // An offer of the other value for the field being typed in says more than "someone changed it" (#396).
    if (this.notice?.isConnected && this.notice.dataset.offer && !problem) return;
    this.notice?.remove();
    window.clearTimeout(this.noticeTimer);
    const notice = el('div', `ed-toast${problem ? ' is-problem' : ''}`);
    notice.setAttribute('role', 'status');
    const words = el('div', 'ed-toast-text');
    words.append(el('span', undefined, message));
    if (detail) words.append(el('small', undefined, detail));
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'ed-toast-button';
    undo.textContent = 'Undo';
    undo.addEventListener('click', () => {
      notice.remove();
      void this.step('undo');
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ed-toast-close';
    close.ariaLabel = 'Close';
    close.textContent = '×';
    close.addEventListener('click', () => notice.remove());
    notice.append(icon(problem ? 'alert' : offerUndo ? 'info' : 'check', 16), words);
    if (offerUndo) notice.append(undo);
    notice.append(close);
    this.host().append(notice);
    this.notice = notice;
    if (!problem) this.noticeTimer = window.setTimeout(() => notice.remove(), offerUndo ? 9000 : 14000);
  }
}
