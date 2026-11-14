import { isVisible } from '@mrstudio/sdk';
import type { Connection, LayerCategory, LayerManifest, LayerState } from '@mrstudio/sdk';

import { el, instanceTitle, widget } from './controls.ts';
import type { Widget } from './controls.ts';
import { paramSender } from './layer-manager.ts';
import type { Store } from './store.ts';

const CATEGORIES: { id: LayerCategory; title: string; empty: string }[] = [
  { id: 'base', title: 'Base', empty: 'No base layers yet' },
  { id: 'ambient', title: 'Ambient', empty: 'No ambient layers yet' },
  { id: 'analysis', title: 'Analysis', empty: 'No analysis layers yet' },
  { id: 'media', title: 'Media', empty: 'No media layers yet' },
];
/** A press becomes a drag after the pointer has moved this far. */
const DRAG_START_PX = 5;

/**
 * The scene composer: a palette of every available layer, and the scene as a stack
 * that can be added to, reordered and edited. Every change goes to the host as a
 * `scene.*` request, which also writes it to site.json.
 */
export class Composer {
  private selected: string | null = null;
  private rows = new Map<string, (state: LayerState) => void>();
  private list = el('div', 'stack-list');
  private status = el('p', 'compose-status');
  private readonly store: Store;
  private readonly connection: Connection;
  private readonly dropZones: HTMLElement[];

  /** `preview` is the table view; dropping a palette layer on it adds the layer on top. */
  constructor(palette: HTMLElement, stack: HTMLElement, preview: HTMLElement, store: Store, connection: Connection) {
    this.store = store;
    this.connection = connection;
    this.dropZones = [stack, preview];

    const header = el('header', 'controller-header');
    header.append(el('h1', undefined, 'Layers'), el('p', undefined, 'Drag a layer into the scene, or press +'));
    palette.append(header, this.palette());

    const title = el('header', 'controller-header');
    title.append(el('h1', undefined, 'Scene'), el('p', undefined, `${store.state.site.name} · top layer first`));
    this.status.textContent = 'Changes are saved to site.json';
    stack.append(title, this.list, this.status);

    this.render();
    store.onScene(() => this.render());
    store.onLayer((id, state) => this.rows.get(id)?.(state));
  }

  // ---- Requests -------------------------------------------------------------

  private async send(method: string, params: object): Promise<any> {
    try {
      const result = await this.connection.request(method, params);
      this.status.textContent = 'Saved to site.json';
      this.status.classList.remove('is-error');
      return result;
    } catch (error) {
      this.status.textContent = (error as Error).message;
      this.status.classList.add('is-error');
      return null;
    }
  }

  private async add(manifest: LayerManifest, index?: number): Promise<void> {
    const result = await this.send('scene.add', { use: manifest.id, index });
    // The reply can arrive before the scene event that brings the new layer; its row opens when it does.
    if (result?.id) this.select(result.id);
  }

  private select(id: string | null): void {
    this.selected = id;
    this.render();
  }

  // ---- Palette --------------------------------------------------------------

  private palette(): HTMLElement {
    const root = el('div', 'palette-groups');
    const data = this.store.state.site.data ?? {};
    for (const category of CATEGORIES) {
      const group = el('section', 'palette-group');
      group.append(el('h2', undefined, category.title));
      const manifests = this.store.manifests.filter((manifest) => (manifest.category ?? 'analysis') === category.id);
      if (manifests.length === 0) group.append(el('p', 'palette-empty', category.empty));
      for (const manifest of manifests) {
        const item = el('div', 'palette-item');
        item.dataset.layer = manifest.id;
        const text = el('div', 'palette-text');
        text.append(el('strong', undefined, manifest.name));
        if (manifest.description) text.append(el('span', undefined, manifest.description));
        const missing = (manifest.requires?.data ?? []).filter((name) => !(name in data));
        if (missing.length > 0) text.append(el('span', 'palette-note', `This site has no ${missing.join(' or ')} data`));
        const button = el('button', 'icon-button', '+');
        button.type = 'button';
        button.ariaLabel = `Add ${manifest.name}`;
        button.addEventListener('click', () => void this.add(manifest));
        item.append(text, button);
        this.draggable(item, manifest.name, null, (slot) => void this.add(manifest, this.store.state.scene.length - slot));
        group.append(item);
      }
      root.append(group);
    }
    return root;
  }

  // ---- Stack ----------------------------------------------------------------

  private render(): void {
    const { store } = this;
    this.rows.clear();
    const rows: HTMLElement[] = [];
    // The list reads like a pile: what is drawn last, on top, comes first.
    for (const id of [...store.state.scene].reverse()) {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      if (manifest) rows.push(this.row(id, manifest, state));
    }
    if (rows.length === 0) rows.push(el('p', 'stack-empty', 'The scene is empty. Drag a layer here to start.'));
    this.list.replaceChildren(...rows);
  }

  private row(id: string, manifest: LayerManifest, initial: LayerState): HTMLElement {
    const name = instanceTitle(id, manifest);
    const open = this.selected === id;
    const row = el('div', 'stack-row');
    row.dataset.layer = id;
    row.classList.toggle('is-selected', open);

    const head = el('div', 'stack-head');
    const grip = el('span', 'stack-grip', '⠿');
    grip.title = 'Drag to reorder';
    const title = el('button', 'stack-title');
    title.type = 'button';
    title.ariaExpanded = String(open);
    title.append(el('strong', undefined, name), el('span', undefined, manifest.category ?? 'analysis'));
    title.addEventListener('click', () => this.select(open ? null : id));

    const visible = el('input');
    Object.assign(visible, { type: 'checkbox', className: 'switch', ariaLabel: `Show ${name}` });
    visible.addEventListener('change', () => void this.send('scene.set', { layer: id, active: visible.checked }));
    const remove = el('button', 'icon-button', '×');
    remove.type = 'button';
    remove.ariaLabel = `Remove ${name}`;
    remove.addEventListener('click', () => void this.send('scene.remove', { layer: id }));
    head.append(grip, title, visible, remove);
    row.append(head);

    this.draggable(head, name, row, (slot) => {
      const scene = this.store.state.scene;
      const from = scene.length - 1 - scene.indexOf(id);
      if (slot === from || slot === from + 1) return;
      const position = slot > from ? slot - 1 : slot;
      void this.send('scene.move', { layer: id, index: scene.length - 1 - position });
    });

    let widgets: Widget[] = [];
    if (open) {
      const settings = el('div', 'stack-settings controls');
      const send = paramSender(this.connection, id, 'scene.set');
      widgets = (manifest.controls ?? []).map((control) =>
        widget(
          control,
          (value) => send({ [control.id]: value }),
          () => void this.connection.request('layer.action', { layer: id, action: control.id }).catch(() => {}),
        ),
      );
      if (widgets.length === 0) settings.append(el('p', 'palette-empty', 'This layer has no settings'));
      settings.append(...widgets.map((w) => w.row));
      row.append(settings);
    }

    const sync = (state: LayerState) => {
      visible.checked = state.active;
      row.classList.toggle('is-off', !state.active);
      for (const w of widgets) {
        w.row.hidden = !isVisible(w.control, state.params);
        w.sync(state.params[w.control.id]);
      }
    };
    sync(initial);
    this.rows.set(id, sync);
    return row;
  }

  // ---- Drag and drop --------------------------------------------------------

  /**
   * Makes `handle` draggable into the stack with mouse, pen or touch. `onDrop` gets
   * the gap the pointer was over, counted from the top of the list (0 is above the first row).
   * `moving` is the row being reordered, if any.
   */
  private draggable(handle: HTMLElement, label: string, moving: HTMLElement | null, onDrop: (slot: number) => void): void {
    handle.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || (down.target as HTMLElement).closest('button, input')) return;
      let ghost: HTMLElement | null = null;
      let slot: number | null = null;
      const line = el('div', 'drop-line');

      const move = (event: PointerEvent) => {
        if (!ghost) {
          if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_START_PX) return;
          ghost = el('div', 'drag-ghost', label);
          document.body.append(ghost);
          document.body.classList.add('is-dragging');
          moving?.classList.add('is-moving');
        }
        ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
        slot = this.slotAt(event.clientX, event.clientY);
        if (slot === null) {
          line.remove();
        } else {
          const rows = [...this.list.querySelectorAll<HTMLElement>('.stack-row')];
          const listBox = this.list.getBoundingClientRect();
          const edge = slot < rows.length ? rows[slot]!.getBoundingClientRect().top : (rows[rows.length - 1]?.getBoundingClientRect().bottom ?? listBox.top + 8);
          line.style.top = `${edge - listBox.top + this.list.scrollTop - 1}px`;
          this.list.append(line);
        }
      };
      const end = (event: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        line.remove();
        moving?.classList.remove('is-moving');
        document.body.classList.remove('is-dragging');
        if (!ghost) return;
        ghost.remove();
        if (slot !== null && event.type === 'pointerup') onDrop(slot);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }

  /** The gap in the stack under the pointer, or null when the pointer is not over a drop zone. */
  private slotAt(x: number, y: number): number | null {
    const inside = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    };
    const [stack, preview] = this.dropZones;
    // Dropping on the table itself puts the layer on top.
    if (inside(preview!)) return 0;
    if (!inside(stack!)) return null;
    const rows = [...this.list.querySelectorAll<HTMLElement>('.stack-row')];
    return rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return y > box.top + box.height / 2;
    }).length;
  }
}
