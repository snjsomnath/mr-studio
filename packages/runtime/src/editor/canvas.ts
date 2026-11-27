// The editor's canvas (#540): the map preview in the middle, what opens on it, click to select on
// the map, and the controller and phone previews beside it. Moved from editor.ts as functions of
// the one editor state; no change in behaviour.
import type { LayerManifest, LayerState } from '@mrstudio/sdk';
import { el, isAtRest, layerButton } from '../controls.ts';
import { returnCorners } from './drawing-frame.ts';
import { icon } from './icons.ts';
import type { RailFit } from '../rail-fit.ts';
import { AT_REST } from './wizard.ts';
import type { Editor, LegendFit } from './editor.ts';
import { checkRails } from './chrome.ts';

/**
 * The phone frame: shown when View › Phone is on, or while the Phones row is selected. A preview,
 * never a second place to edit: phone settings are in the Phones row's Format pane.
 */
export function drawPhone(ed: Editor): void {
  const on = ed.phoneShown || ed.context.kind === 'phone';
  ed.surfaces.classList.toggle('has-phone', on);
  const box = ed.phoneBox;
  if (!on) {
    box.replaceChildren();
    return;
  }
  if (box.childElementCount > 0) return;
  const caption = el('h3', 'ed-surface-caption');
  caption.append(el('strong', undefined, 'Phone'), el('span', undefined, 'What a visitor’s phone shows'));
  const { code, join_url } = ed.store.state.session;
  if (!join_url && !code) {
    box.append(caption, el('p', 'ed-empty', 'Phones cannot join this table yet.'));
    return;
  }
  const screen = el('div', 'ed-phone-screen');
  const frame = el('iframe');
  frame.title = 'A visitor’s phone';
  frame.src = `/phone?c=${encodeURIComponent(code)}`;
  screen.append(frame);
  // A phone is laid out for its own width; it is scaled down to fit its column, as in Rehearse.
  new ResizeObserver(() => {
    const scale = Math.min(screen.clientWidth / 406, screen.clientHeight / 816);
    frame.style.transform = `translateX(-50%) scale(${Math.max(0.1, scale)})`;
  }).observe(screen);
  box.append(caption, screen);
}

/**
 * Shrink controller (#388): in Both, the controller docks as a small live picture in the corner
 * of the canvas and the map takes the rest. Its own header has the button; clicking the small
 * picture enlarges it again. Remembered on this computer, never saved in the table.
 */
export function shrinkControls(ed: Editor, box: HTMLElement): void {
  const key = 'mrs-controller-small';
  const toggle = el('button', 'ed-surface-shrink');
  toggle.type = 'button';
  const enlarge = el('button', 'ed-surface-enlarge');
  enlarge.type = 'button';
  enlarge.ariaLabel = 'Enlarge controller';
  enlarge.title = 'Enlarge controller';
  const set = (small: boolean, keep = true) => {
    ed.surfaces.classList.toggle('is-controller-small', small);
    toggle.replaceChildren(icon(small ? 'fullscreen' : 'minus', 14), el('span', undefined, small ? 'Enlarge controller' : 'Shrink controller'));
    toggle.title = small ? 'Give the controller its half of the canvas again' : 'Dock the controller as a small live picture, so the map gets the canvas';
    toggle.setAttribute('aria-pressed', String(small));
    if (keep) {
      try {
        if (small) localStorage.setItem(key, '1');
        else localStorage.removeItem(key);
      } catch {
        // No storage: the choice lasts until the editor closes.
      }
    }
  };
  let small = false;
  try {
    small = localStorage.getItem(key) === '1';
  } catch {
    // As above.
  }
  set(small, false);
  toggle.addEventListener('click', () => set(!ed.surfaces.classList.contains('is-controller-small')));
  enlarge.addEventListener('click', () => set(false));
  box.querySelector('.ed-surface-caption')!.append(toggle);
  box.append(enlarge);
}
/** Opens one layer on the map and closes the rest, as its button on the controller does. Null leaves the map at rest. */
export function show(ed: Editor, id: string | null): void {
  const { store, connection } = ed;
  const alongside = id !== null && store.manifest(store.state.layers[id]?.layer ?? '')?.alongside;
  for (const other of store.state.scene) {
    const state = store.state.layers[other];
    const manifest = state && store.manifest(state.layer);
    // Items come and go with their layer; the host switches them.
    if (!state || !manifest || isAtRest(manifest, state) || state.parent) continue;
    // A layer a slideshow is showing belongs to the slideshow while it stays open.
    if (state.shown_by && state.shown_by === id) continue;
    const wanted = other === id || (state.active && id !== null && Boolean(alongside || manifest.alongside));
    if (state.active !== wanted) void connection.request('layer.activate', { layer: other, active: wanted }).catch(() => {});
  }
}

/** Swaps the map for the live controller in the middle of the window. */
export function showController(ed: Editor, only: boolean): void {
  if (!ed.preview.firstChild) {
    const frame = el('iframe');
    frame.src = '/tv';
    frame.title = 'The controller, live';
    ed.preview.append(frame);
    // The controller says how its rails fit (#614); a reload of the frame asks again.
    window.addEventListener('message', (event) => {
      const data = event.data as RailFit | LegendFit | null;
      if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
      if (data?.type === 'mrs-legend-fit') {
        if (data.scrolls) ed.legendScrolls.set(data.layer, data.mode);
        else ed.legendScrolls.delete(data.layer);
        checkRails(ed);
        return;
      }
      if (data?.type !== 'mrs-rail-fit') return;
      ed.railFits[data.side] = data;
      checkRails(ed);
    });
    frame.addEventListener('load', () => {
      ed.railFits = {};
      ed.legendScrolls.clear();
      frame.contentWindow?.postMessage({ type: 'mrs-rail-fit?' }, location.origin);
    });
    // The controller is laid out for a full screen; it is scaled down to fit.
    const fit = (): void => {
      const scale = Math.min((ed.preview.clientWidth - 32) / 1600, (ed.preview.clientHeight - 32) / 900);
      frame.style.transform = `translate(-50%, -50%) scale(${Math.max(0.1, scale)})`;
    };
    new ResizeObserver(fit).observe(ed.preview);
  }
  // The map and the controller are on show together; `only` gives the controller the whole space.
  ed.surfaces.classList.toggle('is-controller-only', only);
}

/**
 * A click on the map selects what drew there (#425), as in a drawing program: the topmost
 * layer with a mark, shape, feature or field under the pointer. An item selects its layer with
 * the item open; map life at rest selects its row under At rest. A layer that reads clicks
 * itself (CoolPaths' ends, Sunlight's spot) keeps them while it is open, and a drag, a pan or a
 * click on the drawing frame or the ribbons is not a pick.
 */
export function clickToSelect(ed: Editor): void {
  let down: { x: number; y: number; time: number } | null = null;
  ed.canvas.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const onMap = target.closest('.table-surface') && !target.closest('.ed-drawing-frame, .ed-canvas-empty, button, input');
    down = event.button === 0 && !ed.canvas.classList.contains('is-panning') && onMap ? { x: event.clientX, y: event.clientY, time: event.timeStamp } : null;
  });
  ed.canvas.addEventListener('pointerup', (event) => {
    const start = down;
    down = null;
    if (!start || !ed.picker || ed.wizard || ed.dialog) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || event.timeStamp - start.time > 600) return;
    const open = ed.context.kind === 'layer' ? ed.context.id : null;
    if (open && ed.picker.listens(open)) return;
    const hit = ed.picker.hits(event.clientX, event.clientY).find((id) => ed.store.state.layers[id]);
    if (!hit) return;
    pickOnMap(ed, hit);
  });
}

/** Selects a layer, an item or a piece of map life the map was clicked on. */
export function pickOnMap(ed: Editor, id: string): void {
  const state = ed.store.state.layers[id]!;
  const manifest = ed.store.manifest(state.layer);
  if (ed.also.size) ed.also.clear();
  if (state.parent) {
    if (ed.context.kind === 'layer' && ed.context.id === state.parent && ed.layerItem === id) return;
    ed.go({ kind: 'layer', id: state.parent }, id);
  } else if (manifest && isAtRest(manifest, state)) {
    if (ed.context.kind === 'home' && ed.homeItem === id) return;
    ed.homeItem = id;
    ed.go({ kind: 'home' });
  } else {
    if (ed.context.kind === 'layer' && ed.context.id === id && !ed.layerItem) return;
    ed.go({ kind: 'layer', id });
  }
}

/** A press on the live controller selects that layer here, so the two stay in step. */
export function follow(ed: Editor, id: string, state: LayerState): void {
  if (ed.wizard || (ed.context.kind !== 'home' && ed.context.kind !== 'layer')) return;
  const manifest = ed.store.manifest(state.layer);
  // A slideshow showing a layer is not someone opening that layer.
  if (!manifest || isAtRest(manifest, state) || state.parent || state.shown_by) return;
  const mine = ed.context.kind === 'layer' && ed.context.id === id;
  if (state.active && !mine && !manifest.alongside) ed.context = { kind: 'layer', id };
  else if (!state.active && mine) {
    ed.context = { kind: 'home' };
    ed.homeItem = null;
  } else return;
  ed.render();
}
export function renderCanvas(ed: Editor, instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
  const { context } = ed;
  frameDrawing(ed, instances);
  let iconName: string | undefined = 'moon';
  let title = AT_REST;
  let detail = 'What the map shows when no layer is open';
  let notice: string | null = null;
  if (context.kind === 'layer') {
    const layer = instances.find((i) => i.id === context.id)!;
    const as = layerButton(layer.id, layer.manifest, layer.state);
    iconName = as.icon;
    title = as.name;
    detail = as.description || 'Layer';
  } else if (context.kind === 'phone') {
    iconName = 'phone';
    title = 'Phones';
    detail = 'Personal controllers for visitors';
    notice = `Visitors join with the code ${ed.store.state.session.code}. Choosing which layers a phone may control comes with a later step of the editor.`;
  } else if (context.kind === 'controller') {
    iconName = 'tv';
    title = 'Controller';
    detail = 'The screen beside the table: layer buttons, controls, legend and dashboard';
    notice = 'The map stays visual. Words, buttons and numbers live on the controller. Arranging it here comes with a later step of the editor. ';
  }
  if (ed.wizard) return;
  const showsController = context.kind === 'controller';
  showController(ed, false);
  ed.canvasTools.force(showsController);
  if (showsController) notice = null;
  const badge = el('span', 'ed-row-icon');
  badge.append(icon(iconName));
  const words = el('span', 'ed-canvas-detail', detail);
  ed.canvasHead.replaceChildren(badge, el('strong', undefined, title), words, ed.canvasTools.element, ed.drawerToggle);
  ed.notice.hidden = notice === null;
  ed.notice.textContent = notice ?? '';
}

/** Shows the open Masterplan's frame on the map, with handles to place its drawing by hand (#301). */
export function frameDrawing(ed: Editor, instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
  const open = ed.context.kind === 'layer' ? ed.context.id : null;
  const plan = [ed.layerItem, open].map((id) => instances.find((i) => i.id === id)).find((i) => i?.manifest.id === 'plan');
  const surface = ed.canvas.querySelector<HTMLElement>('.table-surface');
  if (!plan || !surface || ed.wizard) {
    ed.framedDrawing = null;
    ed.drawingFrame.hide();
    return;
  }
  ed.framedDrawing = plan.id;
  const corners = String(plan.state.params.corners ?? '');
  // A new turn keeps the drawing's own shape: the frame's sides swap about its middle.
  const turn = Number(plan.state.params.turn ?? 0) / 90 || 0;
  const before = ed.drawingTurns.get(plan.id);
  ed.drawingTurns.set(plan.id, turn);
  if (before !== undefined && before !== turn && corners) {
    const turned = returnCorners(ed.store.state.site, corners, turn - before);
    if (turned !== corners) void ed.send('scene.set', { layer: plan.id, params: { corners: turned } });
  }
  ed.drawingFrame.show(surface, corners);
}
