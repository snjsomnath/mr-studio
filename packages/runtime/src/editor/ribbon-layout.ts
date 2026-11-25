/**
 * Draws the editor's commands wherever they appear (#392): the ribbon from the layout file
 * (layout.ts), right-click menus and command search. Every one of them reads the same
 * declaration (commands-list.ts) and runs the same handler, so a command has one name, one
 * tooltip and one behaviour wherever it is pressed.
 */
import { el } from '../controls.ts';
import { COMMANDS } from './commands-list.ts';
import type { CommandId } from './commands-list.ts';
import type { Command } from './commands.ts';
import { icon } from './icons.ts';
import type { LayoutTab, WidgetId } from './layout.ts';
import type { MenuItem } from './tree-tools.ts';

/** What a command does, given by the editor. `target` is a layer from a right-click; without it, the selection. */
export interface Handler {
  run: (target?: string) => void | Promise<void>;
  /** Why it is greyed out right now (rule 11, "Greyed, not gone"); undefined when it can run. */
  disabled?: (target?: string) => string | undefined;
  /** A name that follows the state, as Hide and Show do. */
  label?: (target?: string) => string;
  icon?: (target?: string) => string;
  /** A toggle that is on. */
  pressed?: () => boolean;
  /** Its key, shown in the tooltip, the menus and command search. */
  keys?: string;
  /** A more specific tooltip for the moment, such as what a greyed-out command needs. */
  tip?: (target?: string) => string | undefined;
}

export type CommandHandlers = Record<CommandId, Handler>;

/** The tooltip: the name and key, what it does, and why it is greyed out. */
function tooltip(id: CommandId, handler: Handler, label: string, reason: string | undefined): string {
  const info = COMMANDS[id];
  const name = handler.keys ? `${label} (${handler.keys})` : label;
  const tip = handler.tip?.() ?? info.tip;
  return reason ? `${name}. ${reason}` : `${name}. ${tip}`;
}

/** One command as a ribbon button: `data-command` names it, for tests and the help (#392). */
export function commandTool(id: CommandId, handler: Handler, large: boolean): HTMLButtonElement {
  const label = handler.label?.() ?? COMMANDS[id].label;
  const node = el('button', large ? 'ed-tool is-large' : 'ed-tool');
  node.type = 'button';
  node.dataset.command = id;
  node.append(icon(handler.icon?.() ?? COMMANDS[id].icon, large ? 20 : 16), el('span', undefined, label));
  const reason = handler.disabled?.();
  node.disabled = reason !== undefined;
  node.title = tooltip(id, handler, label, reason);
  if (handler.pressed) {
    const on = handler.pressed();
    node.setAttribute('aria-pressed', String(on));
    node.classList.toggle('is-pressed', on);
  }
  node.addEventListener('click', async () => {
    const result = handler.run();
    if (!(result instanceof Promise)) return;
    // Busy until it is done (#68): a second click does not run it twice.
    node.disabled = true;
    node.classList.add('is-busy');
    try {
      await result;
    } finally {
      node.classList.remove('is-busy');
      if (node.isConnected) node.disabled = handler.disabled?.() !== undefined;
    }
  });
  return node;
}

/** A group of the ribbon: its tools, then its name underneath. */
export function ribbonGroup(name: string, ...children: HTMLElement[]): HTMLElement {
  const group = el('div', 'ed-group');
  const tools = el('div', 'ed-group-tools');
  tools.append(...children);
  group.append(tools, el('div', 'ed-group-name', name));
  return group;
}

/** Small tools, three to a column, as in a desktop ribbon. */
export function columns(tools: HTMLElement[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let i = 0; i < tools.length; i += 3) {
    const column = el('div', 'ed-tool-column');
    column.append(...tools.slice(i, i + 3));
    out.push(column);
  }
  return out;
}

/** One tab of the layout, drawn: large tools as they are, runs of small ones in columns. */
export function drawTab(tab: LayoutTab, handlers: CommandHandlers, widgets: Record<WidgetId, () => HTMLElement[]>): HTMLElement[] {
  const groups = tab.groups.map((spec) => {
    const children: HTMLElement[] = [];
    let small: HTMLElement[] = [];
    const flush = (): void => {
      children.push(...columns(small));
      small = [];
    };
    for (const item of spec.items) {
      if (typeof item === 'object' && 'widget' in item) {
        flush();
        children.push(...widgets[item.widget]());
        continue;
      }
      const id = typeof item === 'string' ? item : item.command;
      const large = typeof item === 'object' && Boolean(item.large);
      const tool = commandTool(id, handlers[id], large);
      if (large) {
        flush();
        children.push(tool);
      } else small.push(tool);
    }
    flush();
    const group = ribbonGroup(spec.name, ...children);
    group.dataset.group = spec.name;
    if (spec.keep) group.classList.add('is-keep');
    return group;
  });
  return groups;
}

/** A command in a right-click menu: the same name and the same action as on the ribbon. */
export function menuItem(id: CommandId, handlers: CommandHandlers, target: string, extra: { danger?: boolean } = {}): MenuItem {
  const handler = handlers[id];
  return {
    label: handler.label?.(target) ?? COMMANDS[id].label,
    icon: handler.icon?.(target) ?? COMMANDS[id].icon,
    keys: handler.keys,
    disabled: handler.disabled?.(target) !== undefined,
    run: () => void handler.run(target),
    ...extra,
  };
}

/** Every declared command for command search (#65), with the reason any is greyed out. */
export function searchable(handlers: CommandHandlers): Command[] {
  return (Object.keys(COMMANDS) as CommandId[]).map((id) => {
    const info: { label: string; icon: string; group: string; also?: string } = COMMANDS[id];
    const handler = handlers[id];
    return {
      id,
      label: handler.label?.() ?? info.label,
      group: info.group,
      icon: handler.icon?.() ?? info.icon,
      keys: handler.keys,
      also: info.also,
      disabled: handler.disabled?.(),
      run: () => void handler.run(),
    };
  });
}
