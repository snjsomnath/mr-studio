/**
 * The editor tour (#451): a few steps that point at the broad, stable parts of the window, shown
 * when the editor opens until the author ticks it off. Help › Tour of the editor replays it, and
 * the tick box on the tour is the one home of "show it when the editor opens" (docs/editor-ui.md
 * rule 1). The steps are plain data: a layout change means editing STEPS only.
 */
import { el } from '../controls.ts';

export interface TourStep {
  /** The region pointed at; a step whose region is not on screen is skipped. */
  target: string;
  title: string;
  text: string;
}

export const TOUR_STEPS: TourStep[] = [
  { target: '.ed-ribbon', title: 'The ribbon', text: 'Commands, grouped like PowerPoint: Home works on what is selected, Insert adds layers, data and media, Design sets the look and the table’s size and place, Present checks and starts the table.' },
  { target: '.ed-left', title: 'The list', text: 'What the map shows. At rest is the map when nobody presses anything; each layer below it is a button on the controller. Move up and Move down on Home reorder them; the eye hides one.' },
  { target: '.ed-surfaces', title: 'The map and the controller', text: 'What visitors see, live: the map projected on the table and the screen beside it. View chooses the map, the controller or both.' },
  { target: '.ed-inspector', title: 'The Format pane', text: 'The settings of whatever is selected, and the only place they are changed.' },
  { target: '.ed-status', title: 'The status bar', text: 'Saved, the connection to the table, and what is left to check before presenting.' },
  { target: '[data-present]', title: 'Present', text: 'Puts the map on the projector and the controller on its screen. Share sends the table to another computer, such as the studio PC.' },
  { target: '.ed-tab[data-tab="help"]', title: 'Help, and this tour again', text: 'Guides for every feature are under Help. Help › Tour of the editor shows this tour again, and its tick box below decides whether it opens with the editor.' },
];

const KEY = 'mrs-editor-tour';

/** Whether the tour opens with the editor. On until the author turns it off; this computer only. */
export function tourOnStart(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return false;
  }
}

function setTourOnStart(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    // No storage: the tour shows again next time.
  }
}

/**
 * Runs the tour over `root`. Resolves when it is closed. `startup` is the tour the editor opens
 * with: being shown counts as seen (#585), so it does not come back on the next table unless the
 * author ticks the box.
 */
export function runTour(root: HTMLElement, startup = false): Promise<void> {
  document.querySelector('.ed-tour')?.remove();
  const steps = TOUR_STEPS.filter((s) => {
    const node = root.querySelector<HTMLElement>(s.target);
    return node && node.getBoundingClientRect().width > 0;
  });
  if (steps.length === 0) return Promise.resolve();
  if (startup) setTourOnStart(false);
  return new Promise((resolve) => {
    const layer = el('div', 'ed-tour');
    layer.setAttribute('role', 'dialog');
    layer.ariaLabel = 'Tour of the editor';
    const spot = el('div', 'ed-tour-spot');
    const card = el('section', 'ed-tour-card');
    layer.append(spot, card);
    let at = 0;
    const close = () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('keydown', keys, true);
      layer.remove();
      resolve();
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'ArrowRight' && at < steps.length - 1) go(at + 1);
      else if (event.key === 'ArrowLeft' && at > 0) go(at - 1);
    };
    function place(): void {
      const node = root.querySelector<HTMLElement>(steps[at]!.target);
      if (!node) return;
      const r = node.getBoundingClientRect();
      const pad = 4;
      Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      // The card sits beside the region, on whichever side has room, and stays on screen.
      const w = card.offsetWidth || 320;
      const h = card.offsetHeight || 180;
      const gap = 12;
      let left = r.right + gap;
      let top = r.top;
      if (left + w > innerWidth - 8) left = r.left - w - gap;
      if (left < 8) {
        left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
        top = r.bottom + gap + h > innerHeight - 8 ? r.top - h - gap : r.bottom + gap;
      }
      card.style.left = `${Math.max(8, left)}px`;
      card.style.top = `${Math.min(Math.max(8, top), innerHeight - h - 8)}px`;
    }
    function go(index: number): void {
      at = index;
      const step = steps[at]!;
      const count = el('span', 'ed-tour-count', `${at + 1} of ${steps.length}`);
      const head = el('header');
      head.append(el('strong', undefined, step.title), count);
      const onStart = el('label', 'ed-tour-start');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = tourOnStart();
      box.addEventListener('change', () => setTourOnStart(box.checked));
      onStart.append(box, el('span', undefined, startup ? 'Show this tour again next time' : 'Show this tour when the editor opens'));
      const foot = el('footer');
      const skip = el('button', 'ed-link', 'Close');
      skip.type = 'button';
      skip.addEventListener('click', close);
      const back = el('button', 'ed-button', 'Back');
      back.type = 'button';
      back.disabled = at === 0;
      back.addEventListener('click', () => go(at - 1));
      const last = at === steps.length - 1;
      const next = el('button', 'ed-button is-primary', last ? 'Done' : 'Next');
      next.type = 'button';
      next.addEventListener('click', () => (last ? close() : go(at + 1)));
      foot.append(skip, back, next);
      card.replaceChildren(head, el('p', undefined, step.text), onStart, foot);
      place();
      next.focus();
    }
    window.addEventListener('resize', place);
    document.addEventListener('keydown', keys, true);
    root.append(layer);
    go(0);
  });
}
