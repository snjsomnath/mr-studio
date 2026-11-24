// The guide's phone (#98): a clicker with presenter notes. The guide starts a tour (a slideshow
// made of layers), reads what to say at each step, and moves the table and the controller on
// with Next and Previous. Visitors never see the notes.

import type { Connection } from '@mrstudio/sdk';

import { layerButton } from './controls.ts';
import type { Store } from './store.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The code from the address the guide's QR code opened. */
export function guideCode(): string | undefined {
  return new URLSearchParams(location.search).get('g')?.trim() || undefined;
}

/** The tours of the table: top-level sequences with at least one step. */
function tours(store: Store) {
  return store.state.scene
    .map((id) => ({ id, state: store.state.layers[id]! }))
    .filter(({ state }) => state && !state.parent && store.manifest(state.layer)?.sequence && (state.steps?.sequence?.length ?? 0) > 0);
}

export function guideScreen(store: Store, connection: Connection): HTMLElement {
  const root = el('main', 'guide');
  const send = (method: string, params: object) => connection.request(method, params).catch((error: Error) => (problem.textContent = error.message));
  const problem = el('p', 'guide-problem');

  const draw = () => {
    problem.textContent = '';
    const all = tours(store);
    const running = all.find(({ state }) => state.active);
    const head = el('header', 'guide-head');
    head.append(el('span', 'guide-badge', 'Guide'), el('h1', undefined, store.state.site.name));
    if (!running) {
      const list = el('div', 'guide-tours');
      for (const { id, state } of all) {
        const manifest = store.manifest(state.layer)!;
        const start = el('button', 'guide-tour');
        start.type = 'button';
        start.append(el('strong', undefined, layerButton(id, manifest, state).name), el('span', undefined, `${state.steps!.sequence!.length} steps`));
        start.addEventListener('click', () => void send('layer.activate', { layer: id, active: true }));
        list.append(start);
      }
      root.replaceChildren(
        head,
        el('h2', undefined, all.length ? 'Start a tour' : 'No tours yet'),
        all.length
          ? list
          : el('p', 'guide-empty', 'Make one in the editor: a slideshow made of layers, with notes on each step for you.'),
        problem,
      );
      return;
    }
    const { id, state } = running;
    const sequence = state.steps!.sequence!;
    const index = Math.min(state.step?.index ?? 0, sequence.length - 1);
    const step = sequence[index]!;
    const shown = store.state.layers[step.layer];
    const shownManifest = shown && store.manifest(shown.layer);
    const title = step.title || (shown && shownManifest ? layerButton(step.layer, shownManifest, shown).name : step.layer);
    const sub = state.step?.sub;

    const where = el('p', 'guide-where', `${layerButton(id, store.manifest(state.layer)!, state).name} · step ${index + 1} of ${sequence.length}`);
    const notes = el('div', 'guide-notes');
    if (step.notes?.trim()) for (const line of step.notes.split(/\n+/)) notes.append(el('p', undefined, line));
    else notes.append(el('p', 'guide-empty', 'No notes for this step.'));
    const next = sequence[index + 1];
    const upcoming = el('p', 'guide-next', next ? `Next: ${next.title || next.layer}` : 'This is the last step.');

    const previous = el('button', 'guide-button', 'Previous');
    previous.type = 'button';
    previous.disabled = index === 0 && !(sub && sub.index > 0);
    previous.addEventListener('click', () => void send('layer.step', { layer: id, to: 'previous' }));
    const forward = el('button', 'guide-button primary', next || (sub && sub.index < sub.count) ? 'Next' : 'Finish');
    forward.type = 'button';
    forward.addEventListener('click', () => void send(next || (sub && sub.index < sub.count) ? 'layer.step' : 'layer.activate', next || (sub && sub.index < sub.count) ? { layer: id, to: 'next' } : { layer: id, active: false }));
    const end = el('button', 'guide-end', 'End the tour and go back to rest');
    end.type = 'button';
    end.addEventListener('click', () => void send('layers.reset', {}));
    const buttons = el('div', 'guide-buttons');
    buttons.append(previous, forward);
    root.replaceChildren(head, where, el('h2', 'guide-title', title), notes, upcoming, problem, buttons, end);
  };
  draw();
  store.onLayer(() => draw());
  store.onScene(() => draw());
  connection.on('welcome', () => draw());
  return root;
}

/** The guide's door: the code did not work, or there was none. */
export function guideDoor(problem?: string): HTMLElement {
  const door = el('div', 'door');
  const form = el('form');
  const input = el('input');
  Object.assign(input, { name: 'g', inputMode: 'numeric', autocomplete: 'off', maxLength: 8, required: true, ariaLabel: 'Guide code' });
  const join = el('button', 'action primary', 'Join as the guide');
  form.append(input, join);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    location.assign(`${location.pathname}?g=${encodeURIComponent(input.value.trim())}`);
  });
  door.append(
    el('h1', undefined, problem ? 'That guide code did not work' : 'Enter the guide code'),
    el('p', undefined, 'The editor shows it under a slideshow’s slides, in “Run it from the guide’s phone”. It is not the code on the TV.'),
    form,
  );
  return door;
}
