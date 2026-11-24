/**
 * Small pieces of the editor's layer list (#58): a right-click menu and renaming a row in place.
 */
import { el } from '../controls.ts';
import { icon } from './icons.ts';

export type MenuItem = { label: string; icon?: string | Element; keys?: string; disabled?: boolean; danger?: boolean; run: () => void } | 'line';

/**
 * A menu at a point, as a desktop app's right-click menu: arrow keys move, Enter runs, Escape or a
 * click elsewhere closes it. One at a time.
 */
export function contextMenu(items: MenuItem[], at: { x: number; y: number }, root: HTMLElement, label = 'Actions'): HTMLElement {
  document.querySelector('.ed-context')?.remove();
  const menu = el('div', 'ed-file-menu ed-context');
  menu.setAttribute('role', 'menu');
  menu.ariaLabel = label;
  const close = (): void => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('blur', close);
  };
  const outside = (event: PointerEvent): void => {
    if (!menu.contains(event.target as Node)) close();
  };
  for (const item of items) {
    if (item === 'line') {
      menu.append(el('hr'));
      continue;
    }
    const row = el('button', `ed-file-item${item.danger ? ' is-danger' : ''}`);
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    const name = el('span', 'ed-context-label');
    if (item.icon) name.append(typeof item.icon === 'string' ? icon(item.icon, 14) : item.icon.cloneNode(true));
    name.append(el('span', undefined, item.label));
    row.append(name, el('kbd', undefined, item.keys ?? ''));
    row.disabled = Boolean(item.disabled);
    row.addEventListener('click', () => {
      close();
      item.run();
    });
    menu.append(row);
  }
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rows = [...menu.querySelectorAll<HTMLButtonElement>('.ed-file-item:not(:disabled)')];
      const now = rows.indexOf(document.activeElement as HTMLButtonElement);
      rows[(now + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    }
  });
  menu.style.position = 'fixed';
  root.append(menu);
  // Kept inside the window, as a native menu is.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(at.x, innerWidth - box.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(at.y, innerHeight - box.height - 4))}px`;
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('blur', close);
  menu.querySelector<HTMLButtonElement>('.ed-file-item:not(:disabled)')?.focus();
  return menu;
}

/**
 * Renames a row in place: its label becomes a text box. Enter or leaving it keeps the name,
 * Escape puts it back. An empty name goes back to the layer's own (`commit(null)`).
 */
export function renameInline(row: HTMLElement, current: string, commit: (name: string | null) => void, done?: () => void, max = 40): void {
  const label = row.querySelector<HTMLElement>('.ed-row-label');
  if (!label || row.querySelector('.ed-rename')) return;
  const input = el('input', 'ed-rename');
  Object.assign(input, { type: 'text', value: current, maxLength: max });
  input.ariaLabel = 'Button name';
  label.hidden = true;
  label.after(input);
  // The row is a button: typing a space in it must not press the row.
  for (const kind of ['click', 'keyup', 'pointerdown'] as const) input.addEventListener(kind, (event) => event.stopPropagation());
  let finished = false;
  const finish = (keep: boolean): void => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    input.remove();
    label.hidden = false;
    if (keep && name !== current) {
      label.textContent = name || current;
      commit(name || null);
    }
    (row as HTMLElement).focus();
    done?.();
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.focus();
  input.select();
}

/** Whether a key press is typing into a field, which the editor's keys leave alone. */
export function typing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}
