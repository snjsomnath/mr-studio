/**
 * The editor's File button and its menu (#130): the same items, in the same order and
 * with the same shortcuts, as the desktop app's native File menu, so the commands can be
 * found both ways. The editor decides what each action does.
 */
import { el } from '../controls.ts';

export type FileAction = 'new' | 'open' | 'save' | 'save_as' | 'reveal' | 'close' | 'home';

const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** A shortcut as the platform writes it: ⇧⌘S on a Mac, Ctrl+Shift+S elsewhere. */
export function keys(key: string, shift = false): string {
  return mac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/** The action a key press asks for, if any. In a browser only Save is taken over. */
export function actionFor(event: KeyboardEvent, inApp: boolean): FileAction | null {
  if (!(mac ? event.metaKey : event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 's') return event.shiftKey ? (inApp ? 'save_as' : 'save') : 'save';
  if (!inApp) return null;
  if (event.shiftKey) return key === 'h' ? 'home' : null;
  return ({ n: 'new', o: 'open', w: 'close' } as Record<string, FileAction>)[key] ?? null;
}

interface Item {
  action: FileAction | 'export';
  label: string;
  shortcut?: string;
  /** Needs the desktop app. */
  app?: boolean;
  note?: string;
}

const ITEMS: (Item | 'line')[] = [
  { action: 'new', label: 'New table…', shortcut: keys('N'), app: true },
  { action: 'open', label: 'Open…', shortcut: keys('O'), app: true },
  'line',
  { action: 'save', label: 'Save', shortcut: keys('S') },
  { action: 'save_as', label: 'Save As…', shortcut: keys('S', true), app: true },
  { action: 'export', label: 'Export table…', note: 'Coming soon' },
  { action: 'reveal', label: mac ? 'Show in Finder' : 'Show in Explorer', app: true },
  'line',
  { action: 'close', label: 'Close table', shortcut: keys('W'), app: true },
  { action: 'home', label: 'All tables', shortcut: keys('H', true), app: true },
];

/** The File button. `run` is called with the chosen action. */
export function fileButton(inApp: boolean, run: (action: FileAction) => void): HTMLElement {
  const wrap = el('div', 'ed-file');
  const button = el('button', 'ed-file-button');
  button.type = 'button';
  button.append(el('span', undefined, 'File'));
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const menu = el('div', 'ed-file-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  for (const item of ITEMS) {
    if (item === 'line') {
      menu.append(el('hr'));
      continue;
    }
    const row = el('button', 'ed-file-item');
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    row.append(el('span', undefined, item.label), el('kbd', undefined, item.note ?? item.shortcut ?? ''));
    const off = item.action === 'export' || (Boolean(item.app) && !inApp);
    row.disabled = off;
    if (item.app && !inApp) row.title = 'In the MR Studio app';
    if (item.action === 'export') row.title = 'Export the table as one file to take to another computer (#85)';
    if (!off) {
      row.addEventListener('click', () => {
        close();
        run(item.action as FileAction);
      });
    }
    menu.append(row);
  }
  const close = (): void => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector<HTMLButtonElement>('.ed-file-item:not(:disabled)')?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!wrap.contains(event.target as Node)) close();
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      close();
      button.focus();
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !menu.hidden) {
      event.preventDefault();
      const rows = [...menu.querySelectorAll<HTMLButtonElement>('.ed-file-item:not(:disabled)')];
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      rows[(at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    }
  });
  wrap.append(button, menu);
  return wrap;
}

/**
 * Asks before leaving a table with a change that could not be saved. Resolves true to
 * leave anyway. A page dialog, as the app's webview may not show the browser's own.
 */
export function confirmLeave(problem: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'ed-leave');
    dialog.append(el('h2', undefined, 'A change was not saved'), el('p', undefined, `The last change could not be saved: ${problem}. If you leave now, it is lost.`));
    const actions = el('div', 'ed-leave-actions');
    const stay = el('button', 'ed-button is-primary', 'Stay');
    const leave = el('button', 'ed-button', 'Leave anyway');
    stay.type = leave.type = 'button';
    actions.append(leave, stay);
    dialog.append(actions);
    const done = (answer: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(answer);
    };
    stay.addEventListener('click', () => done(false));
    leave.addEventListener('click', () => done(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      done(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    stay.focus();
  });
}
