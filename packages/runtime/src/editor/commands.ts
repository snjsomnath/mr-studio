/**
 * Command search (#65): Cmd/Ctrl+K opens a box that finds any command, layer or setting by a
 * few words ("add sunlight", "go to wind", "traffic at rest", "present") and runs it. And the
 * keyboard shortcut sheet (Cmd/Ctrl+/).
 */
import { el } from '../controls.ts';
import { icon } from './icons.ts';

import { rank, type Command } from './command-rank.ts';

export { score, rank, type Command } from './command-rank.ts';

let open: HTMLDialogElement | null = null;

/** Opens the command search. `list` is asked each time, so it names what the table has now. */
export function commandSearch(list: () => Command[], root: HTMLElement): void {
  // The same key closes it. One already closing (its close event comes a moment later) gives way to a new one.
  if (open?.open) {
    open.close();
    return;
  }
  open?.remove();
  const dialog = el('dialog', 'ed-commands');
  dialog.ariaLabel = 'Command search';
  const field = el('input', 'ed-commands-field');
  Object.assign(field, { type: 'text', placeholder: 'Search commands, layers and settings…', autocomplete: 'off', spellcheck: false });
  field.setAttribute('role', 'combobox');
  field.setAttribute('aria-controls', 'ed-commands-list');
  field.setAttribute('aria-expanded', 'true');
  const box = el('div', 'ed-commands-search');
  box.append(icon('search', 16), field);
  const results = el('ul', 'ed-commands-list');
  results.id = 'ed-commands-list';
  results.setAttribute('role', 'listbox');
  const foot = el('footer', 'ed-commands-foot', '↑↓ to choose · Enter to run · Esc to close');
  dialog.append(box, results, foot);
  const commands = list();
  let shown: Command[] = [];
  let active = 0;
  const run = (command: Command | undefined): void => {
    if (!command || command.disabled) return;
    dialog.close();
    // After the box has gone, so a command that opens a dialog of its own can.
    requestAnimationFrame(() => command.run());
  };
  const draw = (): void => {
    const query = field.value;
    shown = rank(commands, query);
    active = Math.min(active, Math.max(0, shown.length - 1));
    results.replaceChildren(
      ...shown.map((command, n) => {
        const row = el('li', 'ed-command');
        row.id = `ed-command-${n}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(n === active));
        row.setAttribute('aria-disabled', String(Boolean(command.disabled)));
        row.dataset.command = command.id;
        const badge = el('span', 'ed-command-icon');
        badge.append(icon(command.icon ?? 'next', 14));
        const text = el('span', 'ed-command-text');
        text.append(el('span', undefined, command.label));
        if (command.disabled) text.append(el('small', undefined, command.disabled));
        row.append(badge, text, el('span', 'ed-command-group', command.group));
        if (command.keys) row.append(el('kbd', undefined, command.keys));
        row.addEventListener('pointermove', () => {
          if (active === n) return;
          active = n;
          draw();
        });
        row.addEventListener('click', () => run(command));
        return row;
      }),
    );
    if (shown.length === 0) results.append(el('li', 'ed-command-none', `Nothing called "${query}". Try fewer words.`));
    field.setAttribute('aria-activedescendant', shown.length ? `ed-command-${active}` : '');
    results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  field.addEventListener('input', () => {
    active = 0;
    draw();
  });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length) active = (active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      draw();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(shown[active]);
    } else if (event.key === 'Escape') {
      // One press closes it, whatever is typed.
      event.preventDefault();
      dialog.close();
    }
  });
  dialog.addEventListener('click', (event) => event.target === dialog && dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (open === dialog) open = null;
  });
  root.append(dialog);
  open = dialog;
  dialog.showModal();
  draw();
  field.focus();
}

/** The shortcut sheet: every key the editor knows, in groups. */
export function shortcutSheet(groups: { name: string; keys: [string, string][] }[], root: HTMLElement): void {
  document.querySelector('.ed-shortcuts')?.remove();
  const dialog = el('dialog', 'im-dialog ed-shortcuts');
  dialog.ariaLabel = 'Keyboard shortcuts';
  const head = el('header', 'im-dialog-head');
  const close = el('button', 'ed-icon-button', '×');
  close.type = 'button';
  close.ariaLabel = 'Close';
  close.addEventListener('click', () => dialog.close());
  head.append(el('h2', undefined, 'Keyboard shortcuts'), close);
  const body = el('div', 'ed-shortcuts-body');
  for (const group of groups) {
    const section = el('section');
    section.append(el('h3', undefined, group.name));
    const list = el('dl');
    for (const [what, keys] of group.keys) list.append(el('dt', undefined, what), el('dd', undefined, keys));
    section.append(list);
    body.append(section);
  }
  dialog.append(head, body);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => event.target === dialog && dialog.close());
  root.append(dialog);
  dialog.showModal();
}
