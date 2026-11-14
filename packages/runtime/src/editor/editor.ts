import { isVisible } from '@mrstudio/sdk';
import type { Connection, LayerManifest, LayerState } from '@mrstudio/sdk';

import { el, layerButton, widget } from '../controls.ts';
import type { Widget } from '../controls.ts';
import { paramSender } from '../layer-manager.ts';
import type { Store } from '../store.ts';
import { LAYER_ICONS, icon } from './icons.ts';
import './editor.css';

/**
 * What is being edited. The ribbon, the canvas header and the inspector follow it,
 * so only the tools that fit are on show. MR Studio has three surfaces: the map on
 * the table, which is visual and carries almost no text; the controller, the screen
 * beside it with the layer buttons, controls, legend and dashboard; and phones.
 */
type Context = { kind: 'home' } | { kind: 'layer'; id: string } | { kind: 'controller' } | { kind: 'phone' };

type Tab = 'home' | 'insert' | 'view';

/** Layers of these categories are the table at rest: they belong to the home screen. */
function isAmbient(manifest: LayerManifest): boolean {
  return manifest.category === 'base' || manifest.category === 'ambient';
}

function button(className: string, label: string, iconName?: string, size = 16): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName, size));
  node.append(el('span', undefined, label));
  return node;
}

/**
 * The editor: the authoring window around the live table. Every change goes to the
 * host as a `scene.*` request, which also writes it to site.json, so there is no
 * separate save.
 */
export class Editor {
  /** Where the live table goes. */
  readonly canvas = el('div', 'ed-canvas');

  private context: Context = { kind: 'home' };
  /** The home screen item whose settings are open. */
  private homeItem: string | null = null;
  private tab: Tab = 'insert';
  /** A layer this editor just added, to select once it is in the scene. */
  private added: string | null = null;
  private sync = new Map<string, (state: LayerState) => void>();

  private readonly store: Store;
  private readonly connection: Connection;
  private readonly tabs = el('div', 'ed-tabs');
  private readonly ribbon = el('div', 'ed-ribbon');
  private readonly tree = el('nav', 'ed-tree');
  private readonly canvasHead = el('header', 'ed-canvas-head');
  private readonly notice = el('div', 'ed-notice');
  private readonly inspector = el('aside', 'ed-inspector');
  private readonly saved = el('span', 'ed-saved');

  constructor(root: HTMLElement, store: Store, connection: Connection) {
    this.store = store;
    this.connection = connection;

    const shell = el('div', 'ed');
    const left = el('aside', 'ed-left');
    const name = el('header', 'ed-left-head');
    name.append(el('strong', undefined, store.state.site.name));
    left.append(name, this.tree);

    const centre = el('main', 'ed-centre');
    this.notice.hidden = true;
    centre.append(this.canvasHead, this.canvas, this.notice);

    const body = el('div', 'ed-body');
    body.append(left, centre, this.inspector);
    shell.append(this.titleBar(), this.tabs, this.ribbon, body, this.statusBar());
    root.append(shell);

    this.setSaved();
    this.render();
    store.onScene(() => this.render());
    store.onLayer((id, state) => this.sync.get(id)?.(state));
  }

  // ---- Requests -------------------------------------------------------------

  private async send(method: string, params: object): Promise<any> {
    try {
      const result = await this.connection.request(method, params);
      this.setSaved();
      return result;
    } catch (error) {
      this.setSaved((error as Error).message);
      return null;
    }
  }

  private setSaved(problem?: string): void {
    this.saved.replaceChildren(icon(problem ? 'alert' : 'check', 14), el('span', undefined, problem ?? 'Saved'));
    this.saved.classList.toggle('is-error', Boolean(problem));
  }

  private async add(manifest: LayerManifest): Promise<void> {
    // Ambient life belongs to the home screen, which lies under the layers: it goes above the last ambient layer, not on top.
    let index: number | undefined;
    if (isAmbient(manifest)) {
      const scene = this.store.state.scene;
      let last = -1;
      scene.forEach((id, at) => {
        const other = this.store.manifest(this.store.state.layers[id]?.layer ?? '');
        if (other && isAmbient(other)) last = at;
      });
      if (last >= 0) index = last + 1;
    }
    const result = await this.send('scene.add', { use: manifest.id, index });
    // The reply can arrive before the scene event that brings the new layer; it is selected when it does.
    if (result?.id) this.added = result.id;
    this.render();
  }

  // ---- What is in the scene -------------------------------------------------

  /** Scene instances with their manifests, top of the scene first. */
  private instances(): { id: string; manifest: LayerManifest; state: LayerState }[] {
    const { store } = this;
    const list = [];
    for (const id of [...store.state.scene].reverse()) {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      if (manifest) list.push({ id, manifest, state });
    }
    return list;
  }

  /** The instance the Home tab's tools act on. */
  private target(): string | null {
    if (this.context.kind === 'layer') return this.context.id;
    if (this.context.kind === 'home') return this.homeItem;
    return null;
  }

  private go(context: Context): void {
    this.context = context;
    this.render();
  }

  // ---- Chrome ---------------------------------------------------------------

  private titleBar(): HTMLElement {
    const bar = el('header', 'ed-title');
    const brand = el('div', 'ed-brand');
    brand.append(icon('layers', 18), el('span', undefined, 'MR Studio'));
    const name = el('div', 'ed-name');
    name.append(el('strong', undefined, this.store.state.site.name), this.saved);

    const actions = el('div', 'ed-actions');
    const preview = button('ed-button', 'Preview', 'play');
    preview.title = 'Open the table in a window on this screen';
    preview.addEventListener('click', () => window.open('/table', 'mrstudio-preview'));
    const present = button('ed-button is-primary', 'Present', 'tv');
    present.title = 'Show the map on the projector and the controller on its screen';
    // Tells the desktop shell that this page has its own Present control.
    present.dataset.shellPresent = '';
    present.addEventListener('click', () => void this.present());
    actions.append(preview, present);
    bar.append(brand, name, actions);
    return bar;
  }

  /** Inside the desktop app the shell places the windows; in a browser the table opens in a tab. */
  private async present(): Promise<void> {
    const invoke = (window as any).__TAURI__?.core?.invoke as ((command: string, args?: object) => Promise<unknown>) | undefined;
    if (invoke) {
      try {
        await invoke('present');
        return;
      } catch {
        // The shell has no such command yet: fall through to a plain window.
      }
    }
    window.open('/table', 'mrstudio-table');
    window.open('/tv', 'mrstudio-tv');
  }

  private statusBar(): HTMLElement {
    const bar = el('footer', 'ed-status');
    const connected = el('span', 'ed-connected', 'Connected to the table');
    this.connection.on('disconnected', () => {
      connected.textContent = 'Reconnecting';
      connected.classList.add('is-off');
    });
    this.connection.on('welcome', () => {
      connected.textContent = 'Connected to the table';
      connected.classList.remove('is-off');
    });
    const { width_m, height_m } = this.store.state.site.extent;
    bar.append(el('span', undefined, 'Changes are saved as you make them'), el('span', 'ed-grow'), connected, el('span', undefined, `${Math.round(width_m)} × ${Math.round(height_m)} m`));
    return bar;
  }

  // ---- Render ---------------------------------------------------------------

  private render(): void {
    const instances = this.instances();
    const added = instances.find((i) => i.id === this.added);
    if (added) {
      this.added = null;
      this.context = isAmbient(added.manifest) ? { kind: 'home' } : { kind: 'layer', id: added.id };
      if (isAmbient(added.manifest)) this.homeItem = added.id;
    }
    // The edited layer may have been removed, here or by someone else.
    if (this.context.kind === 'layer' && !instances.some((i) => i.id === (this.context as { id: string }).id)) this.context = { kind: 'home' };
    if (this.homeItem && !instances.some((i) => i.id === this.homeItem)) this.homeItem = null;
    this.sync.clear();
    this.renderTabs();
    this.renderRibbon(instances);
    this.renderTree(instances);
    this.renderCanvas(instances);
    this.renderInspector(instances);
    for (const { id, state } of instances) this.sync.get(id)?.(state);
  }

  private renderTabs(): void {
    const names: [Tab, string][] = [
      ['home', 'Home'],
      ['insert', 'Insert'],
      ['view', 'View'],
    ];
    this.tabs.setAttribute('role', 'tablist');
    this.tabs.replaceChildren(
      ...names.map(([id, label]) => {
        const tab = el('button', 'ed-tab', label);
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(this.tab === id));
        tab.addEventListener('click', () => {
          this.tab = id;
          this.render();
        });
        return tab;
      }),
    );
  }

  private group(name: string, ...children: HTMLElement[]): HTMLElement {
    const group = el('div', 'ed-group');
    const tools = el('div', 'ed-group-tools');
    tools.append(...children);
    group.append(tools, el('div', 'ed-group-name', name));
    return group;
  }

  /** A column of small tools, three to a column, as in a desktop ribbon. */
  private column(tools: HTMLElement[]): HTMLElement[] {
    const columns: HTMLElement[] = [];
    for (let i = 0; i < tools.length; i += 3) {
      const column = el('div', 'ed-tool-column');
      column.append(...tools.slice(i, i + 3));
      columns.push(column);
    }
    return columns;
  }

  private insertTool(manifest: LayerManifest, large: boolean): HTMLElement {
    const tool = button(large ? 'ed-tool is-large' : 'ed-tool', manifest.name, manifest.icon, large ? 20 : 16);
    tool.dataset.layer = manifest.id;
    const data = this.store.state.site.data ?? {};
    const missing = (manifest.requires?.data ?? []).filter((name) => !(name in data));
    tool.title = missing.length > 0 ? `${manifest.description ?? manifest.name}. This table has no ${missing.join(' or ')} data yet.` : (manifest.description ?? manifest.name);
    tool.disabled = missing.length > 0;
    tool.addEventListener('click', () => void this.add(manifest));
    return tool;
  }

  private renderRibbon(instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    const groups: HTMLElement[] = [];
    const target = this.target();
    const selected = instances.find((i) => i.id === target);

    if (this.tab === 'insert') {
      const ambient = this.store.manifests.filter(isAmbient);
      const layers = this.store.manifests.filter((m) => !isAmbient(m));
      // On the home screen the ambient life comes first; inside a layer it is not offered at all.
      if (this.context.kind === 'home' && ambient.length > 0) groups.push(this.group('Ambient life', ...this.column(ambient.map((m) => this.insertTool(m, false)))));
      if (layers.length > 0) groups.push(this.group('New layer', ...layers.map((m) => this.insertTool(m, true))));
    } else if (this.tab === 'home') {
      const show = button('ed-tool is-large', selected?.state.active ? 'Hide' : 'Show', selected?.state.active ? 'eye-off' : 'eye', 20);
      show.title = 'Show or hide this on the table';
      show.addEventListener('click', () => selected && void this.send('scene.set', { layer: selected.id, active: !selected.state.active }));
      // Forward and back step over the neighbours of the same kind: home screen items among themselves, layers among themselves.
      const scene = this.store.state.scene;
      const peers = selected ? instances.filter((i) => isAmbient(i.manifest) === isAmbient(selected.manifest)).map((i) => i.id) : [];
      const place = selected ? peers.indexOf(selected.id) : -1;
      // `peers` runs top first, so the one in front is the one before.
      const front = place > 0 ? peers[place - 1] : undefined;
      const behind = place >= 0 ? peers[place + 1] : undefined;
      const up = button('ed-tool', 'Bring forward', 'up');
      up.title = 'Draw this above the next one';
      up.disabled = !front;
      up.addEventListener('click', () => selected && front && void this.send('scene.move', { layer: selected.id, index: scene.indexOf(front) }));
      const down = button('ed-tool', 'Send back', 'down');
      down.title = 'Draw this below the previous one';
      down.disabled = !behind;
      down.addEventListener('click', () => selected && behind && void this.send('scene.move', { layer: selected.id, index: scene.indexOf(behind) }));
      const remove = button('ed-tool', 'Remove', 'trash');
      remove.title = 'Take this out of the table';
      remove.addEventListener('click', () => selected && void this.send('scene.remove', { layer: selected.id }));
      for (const tool of [show, remove]) tool.disabled = !selected;
      groups.push(this.group(selected ? layerButton(selected.id, selected.manifest, selected.state).name : 'Nothing selected', show, ...this.column([up, down, remove])));
    } else {
      const open = (label: string, iconName: string, path: string, tip: string) => {
        const tool = button('ed-tool is-large', label, iconName, 20);
        tool.title = tip;
        tool.addEventListener('click', () => window.open(path, `mrstudio-${label.toLowerCase()}`));
        return tool;
      };
      groups.push(
        this.group('Open in a window', open('Map', 'table', '/table', 'The map projected on the table'), open('Controller', 'tv', '/tv', 'The screen beside the table'), open('Developer', 'code', '/dev', 'Table, dashboard and every control on one page')),
      );
    }
    this.ribbon.replaceChildren(...groups);
  }

  private treeRow(label: string, detail: string, iconName: string | undefined, selected: boolean, onClick: () => void): HTMLButtonElement {
    const row = el('button', 'ed-row');
    row.type = 'button';
    row.setAttribute('aria-current', String(selected));
    const badge = el('span', 'ed-row-icon');
    badge.append(icon(iconName));
    const text = el('span', 'ed-row-text');
    text.append(el('span', 'ed-row-label', label));
    if (detail) text.append(el('span', 'ed-row-detail', detail));
    row.append(badge, text);
    row.addEventListener('click', onClick);
    return row;
  }

  private renderTree(instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    const { context } = this;
    const ambient = instances.filter((i) => isAmbient(i.manifest));
    const layers = instances.filter((i) => !isAmbient(i.manifest));
    const nodes: HTMLElement[] = [];

    nodes.push(el('h2', 'ed-tree-title', 'Map'));
    const home = this.treeRow('Home screen', ambient.length > 0 ? ambient.map((i) => i.manifest.name).join(', ') : 'Nothing yet', 'home', context.kind === 'home', () => this.go({ kind: 'home' }));
    home.dataset.context = 'home';
    nodes.push(home);

    const title = el('h2', 'ed-tree-title', 'Layers');
    const plus = el('button', 'ed-icon-button');
    plus.type = 'button';
    plus.ariaLabel = 'New layer';
    plus.title = 'New layer';
    plus.append(icon('plus', 14));
    plus.addEventListener('click', () => {
      this.tab = 'insert';
      this.render();
    });
    title.append(plus);
    nodes.push(title);
    if (layers.length === 0) nodes.push(el('p', 'ed-empty', 'No layers yet. Each layer becomes a button on the controller. Add one from Insert.'));
    for (const { id, manifest, state } of layers) {
      const as = layerButton(id, manifest, state);
      const row = this.treeRow(as.name, '', as.icon, context.kind === 'layer' && context.id === id, () => this.go({ kind: 'layer', id }));
      row.dataset.layer = id;
      const side = el('span', 'ed-row-side');
      row.append(side);
      this.sync.set(id, (next) => {
        const button = layerButton(id, manifest, next);
        row.classList.toggle('is-off', !next.active);
        row.querySelector('.ed-row-label')!.textContent = button.name;
        row.querySelector('.ed-row-icon')!.replaceChildren(icon(button.icon));
        side.textContent = button.side === 'right' ? 'Right' : 'Left';
      });
      nodes.push(row);
    }

    nodes.push(el('h2', 'ed-tree-title', 'Around the table'));
    nodes.push(this.treeRow('Controller', 'Buttons, controls and dashboard', 'tv', context.kind === 'controller', () => this.go({ kind: 'controller' })));
    nodes.push(this.treeRow('Phones', 'Personal controllers', 'phone', context.kind === 'phone', () => this.go({ kind: 'phone' })));
    this.tree.replaceChildren(...nodes);
  }

  private renderCanvas(instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    const { context } = this;
    let iconName: string | undefined = 'home';
    let title = 'Home screen';
    let detail = 'Shown when no layer is open';
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
      notice = `Visitors join with the code ${this.store.state.session.code}. Choosing which layers a phone may control comes with a later step of the editor.`;
    } else if (context.kind === 'controller') {
      iconName = 'tv';
      title = 'Controller';
      detail = 'The screen beside the table: layer buttons, controls, legend and dashboard';
      notice = 'The map stays visual. Words, buttons and numbers live on the controller. Arranging it here comes with a later step of the editor. Open it from View to see it live.';
    }
    const badge = el('span', 'ed-row-icon');
    badge.append(icon(iconName));
    this.canvasHead.replaceChildren(badge, el('strong', undefined, title), el('span', undefined, detail));
    this.notice.hidden = notice === null;
    this.notice.textContent = notice ?? '';
  }

  /**
   * How a layer is offered on the controller: its name, a line of description, an icon
   * and the side its button sits on. Empty fields fall back to the layer package's own.
   */
  private buttonSection(id: string, manifest: LayerManifest): HTMLElement {
    const section = el('section', 'ed-section');
    const set = (button: object) => void this.send('scene.set', { layer: id, button });
    const field = (label: string, input: HTMLElement) => {
      const row = el('label', 'ed-field');
      row.append(el('span', undefined, label), input);
      return row;
    };

    const name = el('input');
    Object.assign(name, { type: 'text', maxLength: 40, placeholder: manifest.name });
    name.addEventListener('change', () => set({ name: name.value.trim() || null }));
    const description = el('textarea');
    Object.assign(description, { rows: 2, maxLength: 200, placeholder: manifest.description ?? 'One line about what this layer shows' });
    description.addEventListener('change', () => set({ description: description.value.trim() || null }));

    const side = el('div', 'segmented');
    side.setAttribute('role', 'radiogroup');
    side.setAttribute('aria-label', 'Side of the controller');
    const sides = (['left', 'right'] as const).map((value) => {
      const option = el('button', undefined, value === 'left' ? 'Left' : 'Right');
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.addEventListener('click', () => set({ side: value }));
      side.append(option);
      return [value, option] as const;
    });

    const icons = el('div', 'ed-icons');
    icons.setAttribute('role', 'radiogroup');
    icons.setAttribute('aria-label', 'Icon');
    const names = LAYER_ICONS.includes(manifest.icon ?? '') || !manifest.icon ? LAYER_ICONS : [manifest.icon, ...LAYER_ICONS];
    const choices = names.map((value) => {
      const option = el('button', 'ed-icon-choice');
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.ariaLabel = value;
      option.title = value;
      option.append(icon(value));
      option.addEventListener('click', () => set({ icon: value === manifest.icon ? null : value }));
      icons.append(option);
      return [value, option] as const;
    });

    const row = el('div', 'ed-field');
    row.append(el('span', undefined, 'Side'), side);
    const iconRow = el('div', 'ed-field is-tall');
    iconRow.append(el('span', undefined, 'Icon'), icons);
    section.append(el('h3', undefined, 'Button on the controller'), field('Name', name), field('Description', description), row, iconRow);

    const previous = this.sync.get(id);
    this.sync.set(id, (state) => {
      previous?.(state);
      const button = layerButton(id, manifest, state);
      if (document.activeElement !== name) name.value = state.button?.name ?? '';
      if (document.activeElement !== description) description.value = state.button?.description ?? '';
      for (const [value, option] of sides) option.setAttribute('aria-checked', String(value === button.side));
      for (const [value, option] of choices) option.setAttribute('aria-checked', String(value === button.icon));
      // The headings that show the layer's name follow it.
      this.inspector.querySelector('.ed-inspector-head strong')!.textContent = button.name;
      this.inspector.querySelector('.ed-inspector-head svg')!.replaceWith(icon(button.icon));
      if (this.context.kind === 'layer' && this.context.id === id) this.renderCanvas(this.instances());
    });
    return section;
  }

  /** The settings form of one scene instance, generated from its manifest. */
  private settings(id: string, manifest: LayerManifest): HTMLElement {
    const section = el('section', 'ed-section');
    const shown = el('div', 'control control-toggle');
    const label = el('label', 'control-label', 'Shown on the table');
    const power = el('input');
    Object.assign(power, { type: 'checkbox', className: 'switch', id: `shown-${id}` });
    label.htmlFor = power.id;
    power.addEventListener('change', () => void this.send('scene.set', { layer: id, active: power.checked }));
    shown.append(label, power);

    const send = paramSender(this.connection, id, { method: 'scene.set' });
    const widgets: Widget[] = (manifest.controls ?? []).map((control) =>
      widget(
        control,
        (value) => send({ [control.id]: value }),
        () => void this.connection.request('layer.action', { layer: id, action: control.id }).catch(() => {}),
      ),
    );
    const controls = el('div', 'controls');
    controls.append(shown, ...widgets.map((w) => w.row));
    section.append(el('h3', undefined, 'Settings'), controls);

    const previous = this.sync.get(id);
    this.sync.set(id, (state) => {
      previous?.(state);
      power.checked = state.active;
      for (const w of widgets) {
        w.row.hidden = !isVisible(w.control, state.params);
        w.sync(state.params[w.control.id]);
      }
    });
    return section;
  }

  private renderInspector(instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    const { context } = this;
    const nodes: HTMLElement[] = [];
    const head = (iconName: string | undefined, title: string, detail: string) => {
      const header = el('header', 'ed-inspector-head');
      header.append(icon(iconName), el('strong', undefined, title), el('span', undefined, detail));
      return header;
    };

    if (context.kind === 'home') {
      nodes.push(head('home', 'Home screen', 'The table at rest'));
      const ambient = instances.filter((i) => isAmbient(i.manifest));
      const section = el('section', 'ed-section');
      section.append(el('h3', undefined, 'On the home screen'));
      if (ambient.length === 0) section.append(el('p', 'ed-empty', 'Nothing yet. Add a base map and some ambient life from Insert.'));
      for (const { id, manifest, state } of ambient) {
        const row = this.treeRow(layerButton(id, manifest).name, '', manifest.icon, this.homeItem === id, () => {
          this.homeItem = this.homeItem === id ? null : id;
          this.render();
        });
        row.dataset.layer = id;
        row.classList.toggle('is-off', !state.active);
        this.sync.set(id, (next) => row.classList.toggle('is-off', !next.active));
        section.append(row);
      }
      nodes.push(section);
      const open = ambient.find((i) => i.id === this.homeItem);
      if (open) nodes.push(this.settings(open.id, open.manifest));
    } else if (context.kind === 'layer') {
      const layer = instances.find((i) => i.id === context.id)!;
      const as = layerButton(layer.id, layer.manifest, layer.state);
      nodes.push(head(as.icon, as.name, 'Layer'));
      nodes.push(this.buttonSection(layer.id, layer.manifest));
      nodes.push(this.settings(layer.id, layer.manifest));
    } else {
      nodes.push(head(context.kind === 'controller' ? 'tv' : 'phone', context.kind === 'controller' ? 'Controller' : 'Phones', ''));
      nodes.push(el('p', 'ed-empty', 'Nothing to set here yet.'));
    }
    this.inspector.replaceChildren(...nodes);
  }
}
