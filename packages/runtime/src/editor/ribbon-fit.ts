/**
 * The ribbon on a small screen (#66), as a desktop ribbon does it: when the groups do not fit,
 * the group with the most big tools folds them into columns of three small ones, then the next.
 * If that is still not enough, the longest group keeps its first columns and offers the rest
 * under More. Widen the window and everything opens out again.
 */
import { el } from '../controls.ts';
import { icon } from './icons.ts';
import { contextMenu } from './tree-tools.ts';

/** Each changed group's own tools, in their order, to put back. */
const original = new WeakMap<HTMLElement, Node[]>();

const fits = (ribbon: HTMLElement): boolean => ribbon.scrollWidth <= ribbon.clientWidth + 1;
const box = (group: HTMLElement): HTMLElement | null => group.querySelector<HTMLElement>(':scope > .ed-group-tools');

function restore(group: HTMLElement): void {
  const nodes = original.get(group);
  const tools = box(group);
  if (!nodes || !tools) return;
  for (const node of nodes) if (node instanceof HTMLElement) node.classList.replace('is-compact', 'is-large');
  tools.replaceChildren(...nodes);
  original.delete(group);
  group.classList.remove('is-folded');
}

function keep(group: HTMLElement, tools: HTMLElement): void {
  if (!original.has(group)) original.set(group, [...tools.childNodes]);
}

/** Big tools become small ones, three to a column. */
function fold(group: HTMLElement): void {
  const tools = box(group);
  if (!tools) return;
  keep(group, tools);
  const after: Node[] = [];
  let column: HTMLElement | null = null;
  for (const node of [...tools.children] as HTMLElement[]) {
    if (!node.classList.contains('is-large')) {
      after.push(node);
      column = null;
      continue;
    }
    node.classList.replace('is-large', 'is-compact');
    if (!column || column.childElementCount === 3) {
      column = el('div', 'ed-tool-column');
      after.push(column);
    }
    column.append(node);
  }
  tools.replaceChildren(...after);
  group.classList.add('is-folded');
}

/** The group's last columns go under a More button, one at a time, until the ribbon fits. */
function shorten(group: HTMLElement, ribbon: HTMLElement): void {
  const tools = box(group);
  if (!tools) return;
  keep(group, tools);
  const columns = [...tools.querySelectorAll<HTMLElement>(':scope > .ed-tool-column')];
  const hidden: HTMLButtonElement[] = [];
  const more = el('button', 'ed-tool is-more');
  more.type = 'button';
  more.append(icon('down', 16), el('span', undefined, 'More'));
  more.setAttribute('aria-haspopup', 'menu');
  const holder = el('div', 'ed-tool-column');
  holder.append(more);
  tools.append(holder);
  while (columns.length > 1 && !fits(ribbon)) {
    const last = columns.pop()!;
    hidden.unshift(...last.querySelectorAll<HTMLButtonElement>(':scope > button'));
    last.remove();
  }
  if (hidden.length === 0) {
    holder.remove();
    return;
  }
  more.title = `${hidden.length} more: ${hidden.map((b) => b.textContent?.trim()).join(', ')}`;
  more.addEventListener('click', () => {
    const at = more.getBoundingClientRect();
    contextMenu(
      hidden.map((tool) => ({
        label: tool.textContent?.trim() ?? '',
        icon: tool.querySelector('svg') ?? undefined,
        disabled: tool.disabled,
        run: () => tool.click(),
      })),
      { x: at.left, y: at.bottom + 2 },
      ribbon.closest<HTMLElement>('.ed') ?? document.body,
      group.querySelector('.ed-group-name')?.textContent ?? 'More',
    );
  });
}

function fit(ribbon: HTMLElement): void {
  const groups = [...ribbon.querySelectorAll<HTMLElement>(':scope > .ed-group')];
  groups.forEach(restore);
  ribbon.classList.remove('is-tight');
  if (fits(ribbon)) return;
  // First the space between groups narrows.
  ribbon.classList.add('is-tight');
  if (fits(ribbon)) return;
  const large = (group: HTMLElement) => group.querySelectorAll(':scope > .ed-group-tools > .is-large').length;
  for (const group of groups.filter((g) => large(g) > 0).sort((a, b) => large(b) - large(a))) {
    fold(group);
    if (fits(ribbon)) return;
  }
  const columns = (group: HTMLElement) => group.querySelectorAll(':scope > .ed-group-tools > .ed-tool-column').length;
  for (const group of groups.filter((g) => columns(g) > 1 && !g.classList.contains('is-keep')).sort((a, b) => columns(b) - columns(a))) {
    shorten(group, ribbon);
    if (fits(ribbon)) return;
  }
}

/** Keeps the ribbon fitted: after each redraw of its groups, and as the window changes size. */
export function fitRibbon(ribbon: HTMLElement): void {
  let queued = 0;
  let width = 0;
  const later = (): void => {
    cancelAnimationFrame(queued);
    queued = requestAnimationFrame(() => fit(ribbon));
  };
  new MutationObserver(later).observe(ribbon, { childList: true });
  new ResizeObserver(() => {
    if (ribbon.clientWidth === width) return;
    width = ribbon.clientWidth;
    later();
  }).observe(ribbon);
}
