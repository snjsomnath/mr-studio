import { isVisible } from '@mrstudio/sdk';
import type { Connection, LayerManifest, LayerState, MediaKind } from '@mrstudio/sdk';

import { defaultSideOf, el, isAmbient, isAtRest, isOffered, layerButton, visibleControls, widget } from '../controls.ts';
import type { Widget } from '../controls.ts';
import { paramSender } from '../layer-manager.ts';
import type { Store } from '../store.ts';
import { builderSection, deleteCustomDialog, layerFromImport, newCustomLayer, paletteDialog } from './builder.ts';
import { DisplayTab } from './display-tab.ts';
import { MediaTab } from './media-tab.ts';
import { MODEL_ROW } from './model-import.ts';
import { ACCEPT, kindOf, mediaChanged, mediaItems, routeOf } from '../media.ts';
import type { MediaItem } from '../media.ts';
import type { BuilderHost } from './builder.ts';
import { LAYER_ICONS, icon } from './icons.ts';
import { HistoryControls } from './history.ts';
import { Importer, targetFor } from './importer.ts';
import { confirmLeave, actionFor, fileButton } from './file-menu.ts';
import type { FileAction } from './file-menu.ts';
import { slidesSection } from './slides.ts';
import { tableSettings } from './table-settings.ts';
import { AT_REST, BUTTONS, REST, WHERE, Wizard, chosenTheme, themeChoice, themeSwatch } from './wizard.ts';
import { THEMES } from '@mrstudio/dashboard';
import './editor.css';

/**
 * What is being edited. The ribbon, the canvas header and the inspector follow it,
 * so only the tools that fit are on show. MR Studio has three surfaces: the map on
 * the table, which is visual and carries almost no text; the controller, the screen
 * beside it with the layer buttons, controls, legend and dashboard; and phones.
 */
type Context = { kind: 'home' } | { kind: 'layer'; id: string } | { kind: 'controller' } | { kind: 'phone' } | { kind: 'table' };


type Invoke = (command: string, args?: object) => Promise<unknown>;

/** The desktop app's commands, or undefined in a browser. */
function shell(): Invoke | undefined {
  return (window as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;
}
/** The same, for where `shell` names the editor's element. */
const desktop = (): Invoke | undefined => shell();

/**
 * Opens one view of the table in a window of its own. The desktop app is asked directly,
 * as Present is: macOS does not reliably let `window.open` out of the webview (#51). A
 * browser, or an older app without the command, opens a window the usual way.
 */
function openView(role: 'table' | 'tv' | 'dev'): void {
  const fallback = () => window.open(`/${role}`, `mrstudio-${role}`);
  const invoke = shell();
  if (invoke) invoke('open_view', { role }).catch(fallback);
  else fallback();
}

/**
 * Opens the Help window (#271) at a page. The page goes through local storage, so a Help
 * window that is already open turns to it too; a browser opens /help#page.
 */
function openHelp(page: string): void {
  try {
    localStorage.setItem('mrstudio.help.page', page);
  } catch {
    /* storage off: the window opens at its first page */
  }
  const fallback = () => window.open(`/help#${page}`, 'mrstudio-help');
  const invoke = shell();
  if (invoke) invoke('open_view', { role: 'help' }).catch(fallback);
  else fallback();
}

function button(className: string, label: string, iconName?: string, size = 16): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName, size));
  node.append(el('span', undefined, label));
  return node;
}

type SetupTab = 'place' | 'rest' | 'design';
type RibbonTab = 'edit' | SetupTab | 'display' | 'media' | 'help';
/** Each setup tab and the step of the guide it opens. */
const SETUP_STEP: Record<SetupTab, number> = { place: WHERE, rest: REST, design: BUTTONS };
const isSetupTab = (tab: RibbonTab): tab is SetupTab => tab in SETUP_STEP;
/** The ribbon tab to come back to after the page reloads, as after moving the table. */
const TAB_KEY = 'mrs-ribbon-tab';

/**
 * The editor: the authoring window around the live table. Every change goes to the
 * host as a `scene.*` request, which also writes it to site.json, so there is no
 * separate save: File > Save makes sure nothing is still on its way and says so (#130).
 */
export class Editor {
  /** Where the live table goes. */
  readonly canvas = el('div', 'ed-canvas');
  /** Takes a picture of the table, once the table is up; kept for Home when the table is left (#131). */
  snapshot: (() => Promise<Blob | null>) | null = null;
  /** Changes sent to the host and not yet answered. */
  private pending = 0;
  /** Why the last change could not be saved, until one is. */
  private problem: string | null = null;
  /** The last File action and when, so one asked for twice at once (menu and keys) runs once. */
  private lastFile: { action: string; at: number } | null = null;

  private context: Context = { kind: 'home' };
  /** The home screen item whose settings are open. */
  private homeItem: string | null = null;
  /** The item of the open layer whose settings are open. */
  private layerItem: string | null = null;
  /** Whether each item comes on with its layer, as last seen while its layer was open or as set here. */
  private itemOn = new Map<string, boolean>();
  /** A layer this editor just added, to select once it is in the scene. */
  private added: string | null = null;
  private sync = new Map<string, (state: LayerState) => void>();

  private readonly store: Store;
  private readonly connection: Connection;
  private readonly ribbon = el('div', 'ed-ribbon');
  /**
   * The ribbon's two tabs (#151): Edit, the one ribbon that follows the selection (#21),
   * and Display, the colour pass and projector of this computer's displays (app settings, #73).
   */
  private readonly tabs = el('div', 'ed-tabs');
  private ribbonTab: RibbonTab = 'edit';
  /**
   * The setup tabs (#311, #312, #313): each opens its step of the guide as a panel beside the map,
   * made once and kept, so a half-typed place survives a change of tab.
   */
  private readonly panels = new Map<SetupTab, Wizard>();
  /** The Help tab's list of guides, from help.json (#271); fetched the first time the tab opens. */
  private helpPages: { id: string; kind: string; title: string; summary: string }[] | null = null;
  private readonly displayTab: DisplayTab;
  /** The Media tab (#306): everything the table has, and Add media. */
  private readonly mediaTab: MediaTab;
  private readonly tree = el('nav', 'ed-tree');
  private readonly canvasHead = el('header', 'ed-canvas-head');
  private readonly surfaces = el('div', 'ed-surfaces');
  private readonly notice = el('div', 'ed-notice');
  /** The one thing this table still lacks, with the way to it. */
  private readonly next = el('div', 'ed-next');
  private readonly inspector = el('aside', 'ed-inspector');
  private readonly saved = el('button', 'ed-saved');
  /** Undo, redo and the History panel, on the host's revision history (#57, #72). */
  private history!: HistoryControls;
  private readonly titleName = el('strong');
  private readonly shell = el('div', 'ed');
  private readonly body = el('div', 'ed-body');
  /** The live controller, shown in the middle in place of the map. */
  private readonly preview = el('div', 'ed-preview');
  private presentButton!: HTMLButtonElement;
  private guideButton!: HTMLButtonElement;
  private wizard: Wizard | null = null;
  /** The guide step to come back at after the next reload, when it is not the one on show. */
  private resumeStep: number | null = null;
  /** While held, a change of site waits to reload the page; `true` once one came in. */
  private held = false;
  private reloadWaiting = false;

  constructor(root: HTMLElement, store: Store, connection: Connection) {
    this.store = store;
    this.connection = connection;
    this.history = new HistoryControls(connection, () => store.surface, (problem) => this.setSaved(problem));
    this.saved.type = 'button';
    this.saved.addEventListener('click', () => this.history.toggle(this.saved));

    const { shell, body } = this;
    const left = el('aside', 'ed-left');
    const name = el('header', 'ed-left-head');
    // The table's name opens its settings (#62, #73).
    const tableName = el('button', 'ed-table-name');
    tableName.type = 'button';
    tableName.title = 'Table settings: name, time zone, place, and what the controller says';
    const drawName = (): void => tableName.replaceChildren(el('strong', undefined, store.state.site.name), icon('settings', 14));
    drawName();
    tableName.addEventListener('click', () => this.go({ kind: 'table' }));
    store.onSettings(() => {
      drawName();
      this.titleName.textContent = store.state.site.name;
      if (this.context.kind === 'table') this.render();
    });
    window.addEventListener('mrs-edit', (event) => {
      if ((event as CustomEvent<{ action: string }>).detail.action === 'table-settings') {
        if (this.wizard) this.closeWizard();
        this.go({ kind: 'table' });
      }
    });
    name.append(tableName);
    left.append(name, this.tree);

    const centre = el('main', 'ed-centre');
    this.notice.hidden = true;
    // The two surfaces an author shapes, side by side and live: what the table shows, and what a visitor gets to press.
    const surface = (kind: string, title: string, detail: string, content: HTMLElement) => {
      const box = el('section', `ed-surface is-${kind}`);
      const caption = el('h3', 'ed-surface-caption');
      caption.append(el('strong', undefined, title), el('span', undefined, detail));
      box.append(caption, content);
      return box;
    };
    this.surfaces.append(surface('map', 'Map', 'Projected on the table. Visual only.', this.canvas), surface('controller', 'Controller', 'The screen beside the table. Buttons, words and controls.', this.preview));
    centre.append(this.canvasHead, this.next, this.surfaces, this.notice);
    this.mediaTab = new MediaTab({
      store,
      addMedia: (kinds) => this.addMedia(kinds),
      addLayer: (use, params) => this.addWith(use, params),
      openLayer: (id) => {
        this.setRibbonTab('edit');
        const state = store.state.layers[id];
        if (state?.parent) this.go({ kind: 'layer', id: state.parent }, id);
        else if (state && isAtRest(store.manifest(state.layer)!, state)) this.go({ kind: 'home' });
        else this.go({ kind: 'layer', id });
      },
      openSources: desktop() ? () => void desktop()?.('open_sources') : undefined,
      hold: (on) => this.hold(on),
      changed: () => {
        if (this.ribbonTab === 'media') this.render();
      },
    });
    centre.append(this.mediaTab.view);

    body.append(left, centre, this.inspector);
    const invoke = desktop();
    this.displayTab = new DisplayTab(invoke, connection, this.canvas, () => void invoke?.('open_settings'));
    this.displayTab.setQuality(this.store.state.site.display?.quality ?? 'good');
    this.store.onDisplay((quality) => this.displayTab.setQuality(quality));
    this.tabs.setAttribute('role', 'tablist');
    this.tabs.ariaLabel = 'Ribbon';
    this.ribbon.setAttribute('role', 'tabpanel');
    shell.append(this.titleBar(), this.tabs, this.ribbon, body, this.statusBar());
    this.drawTabs();
    root.append(shell);
    this.listenForFile();
    // A list of media in a layer's settings asks for Add media (#306).
    (window as { mrsAddsMedia?: boolean }).mrsAddsMedia = true;
    window.addEventListener('mrs-media-add', (event) => {
      const { kinds, done } = (event as CustomEvent<{ kinds: MediaKind[]; done: (item: MediaItem | null) => void }>).detail;
      event.preventDefault();
      void this.addMedia(kinds).then(done);
    });

    this.setSaved();
    this.drawGuideButton();
    this.render();
    store.onScene(() => this.render());
    // A new theme or button style shows as chosen on the Design tab.
    store.onTv(() => this.ribbonTab === 'design' && this.renderRibbon(this.instances()));
    // A custom layer was saved or removed: it is offered on the ribbon (the builder in the inspector keeps its own copy).
    store.onCatalog(() => {
      if (!this.wizard) this.renderRibbon(this.instances());
    });
    store.onLayer((id, state) => {
      this.sync.get(id)?.(state);
      this.follow(id, state);
    });

    // A new table opens in the setup guide, and so does one with nothing on it yet.
    const query = new URLSearchParams(location.search);
    const created = query.has('welcome') || query.has('setup');
    // After data is brought in the page reloads; the guide comes back at the step it was on.
    let resume: number | undefined;
    try {
      const kept = sessionStorage.getItem('mrs-setup-step');
      sessionStorage.removeItem('mrs-setup-step');
      if (kept !== null) resume = Number(kept);
    } catch {
      // No session storage: the guide starts over.
    }
    if (resume !== undefined || created || this.instances().every((i) => isAmbient(i.manifest))) this.openWizard(created, resume);
    else {
      // After a reload (moving the table, bringing data in), the editor comes back on the tab it was on.
      let tab: string | null = null;
      try {
        tab = sessionStorage.getItem(TAB_KEY);
      } catch {
        // As above.
      }
      if (tab === 'place' || tab === 'rest' || tab === 'design' || tab === 'media') this.setRibbonTab(tab);
    }
    connection.on('site.changed', () => {
      if (this.held) {
        this.reloadWaiting = true;
        return;
      }
      this.reload();
    });
  }

  /** Two changes that must land as one (move the table, then bring in a file) hold back the reload in between. */
  private hold(on: boolean): void {
    this.held = on;
    if (!on && this.reloadWaiting) this.reload();
  }

  /** Starts again with the site as it now is, coming back to the guide's step. */
  private reload(): void {
    try {
      const step = this.resumeStep ?? this.wizard?.step;
      if (step !== undefined) sessionStorage.setItem('mrs-setup-step', String(step));
    } catch {
      // As above.
    }
    location.reload();
  }

  // ---- The setup guide --------------------------------------------------------

  private openWizard(created = false, step?: number): void {
    if (this.wizard) return;
    this.wizard = new Wizard(
      {
        store: this.store,
        send: (method, params) => this.send(method, params),
        add: (manifest) => this.add(manifest),
        show: (id) => this.show(id),
        controller: (shown) => this.showController(shown),
        present: () => this.presentButton.click(),
        close: () => this.closeWizard(),
        resumeAt: (step) => (this.resumeStep = step < 0 ? null : step),
        hold: (on) => this.hold(on),
      },
      { created, step },
    );
    this.setRibbonTab('edit');
    this.shell.classList.add('is-setup');
    this.body.prepend(this.wizard.element);
    this.drawGuideButton();
    this.render();
  }

  /** The guide's button says which way it goes: into the guide, or out of it into the editor. */
  private drawGuideButton(): void {
    const open = this.wizard !== null;
    const guide = this.guideButton;
    guide.replaceChildren(icon(open ? 'check' : 'route', 16), el('span', undefined, open ? 'Close guide' : 'Setup guide'));
    guide.setAttribute('aria-pressed', String(open));
    guide.classList.toggle('is-pressed', open);
    guide.title = open ? 'Leave the guide and work in the full editor. The guide stays one click away.' : 'Walk through setting up this table, step by step';
  }

  /** The ribbon's tabs. Display is the colour and post-processing of each display, and the projector. */
  private drawTabs(): void {
    const tab = (id: RibbonTab, label: string, tip: string) => {
      const node = el('button', 'ed-tab', label);
      node.type = 'button';
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(this.ribbonTab === id));
      node.dataset.tab = id;
      node.title = tip;
      node.addEventListener('click', () => this.setRibbonTab(id));
      return node;
    };
    this.tabs.replaceChildren(
      tab('edit', 'Edit', 'Add layers and data, and work on what is selected'),
      tab('place', 'Name and place', 'What the table is called, where it is and how much ground it covers'),
      tab('rest', AT_REST, 'What the map shows when no layer is open'),
      tab('design', 'Design', 'How the controller looks, and the words and side of each button'),
      tab('display', 'Display', 'Colour and post-processing for each display, layer strength and projector calibration'),
      tab('media', 'Media', 'Every file and online source of this table, in one place, and Add media'),
      tab('help', 'Help', 'Every feature and step-by-step guides, in a window of their own'),
    );
  }

  private setRibbonTab(id: RibbonTab): void {
    if (id === this.ribbonTab) return;
    this.ribbonTab = id;
    if (id === 'display') void this.displayTab.show();
    else this.displayTab.hide();
    this.shell.classList.toggle('is-media', id === 'media');
    // The tab comes back after the reload that bringing data in causes.
    try {
      if (id === 'media') sessionStorage.setItem('mrs-ribbon-tab', id);
      else sessionStorage.removeItem('mrs-ribbon-tab');
    } catch {
      // No session storage: the editor opens at Edit.
    }
    this.drawTabs();
    this.showPanel();
    if (id === 'media') void this.mediaTab.load();
    this.render();
  }

  /** Adds the layer `use`, set to these params, and opens it (Media's Show on the table). */
  private async addWith(use: string, params: Record<string, unknown>): Promise<void> {
    const manifest = this.store.manifests.find((m) => m.id === use);
    if (!manifest) return;
    this.setRibbonTab('edit');
    await this.add(manifest);
    if (this.added) await this.send('layer.set', { layer: this.added, params });
  }

  /**
   * Add media (#306): any file, sent where it belongs. Map data, tables, rasters and drawings go
   * through the importer of Add data (#71), which names them as datasets; pictures, video and
   * sounds are kept as they came; a 3D model is placed in the guide's Your place. Answers what
   * was added, once it is listed, or null. A dataset brought in reloads the editor, which comes
   * back on the Media tab.
   */
  private addMedia(kinds?: readonly MediaKind[]): Promise<MediaItem | null> {
    return new Promise((resolve) => {
      const routes = new Set((kinds?.length ? kinds : (['map', 'table', 'raster', 'drawing', 'picture', 'video', 'sound', 'model'] as MediaKind[])).map((k) => (k === 'picture' || k === 'video' ? 'media' : k === 'sound' ? 'sound' : k === 'model' ? 'model' : 'dataset')));
      // A video for a Video walk may also come in as a dataset.
      if (kinds?.includes('video')) routes.add('media');
      const accept = [...routes].flatMap((r) => ACCEPT[r as keyof typeof ACCEPT]);
      const input = el('input');
      Object.assign(input, { type: 'file', accept: accept.join(','), multiple: !routes.has('dataset') && !routes.has('model') });
      input.addEventListener('cancel', () => resolve(null));
      input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        if (files.length === 0) return resolve(null);
        void this.takeMedia(files).then(resolve, (error: Error) => {
          this.setSaved(error.message);
          resolve(null);
        });
      });
      input.click();
    });
  }

  /** Brings files in, one after another; answers the last one added. */
  private async takeMedia(files: File[]): Promise<MediaItem | null> {
    let last: MediaItem | null = null;
    for (const file of files) {
      const route = routeOf(file.name);
      if (route === 'dataset') {
        this.addData(file);
        return null;
      }
      if (route === 'model') {
        // A model is set on the ground and fitted to the buildings: Your place's 3D model row, here in Media.
        if (this.ribbonTab !== 'media') this.setRibbonTab('media');
        this.mediaTab.bringIn(MODEL_ROW);
        this.history.notify('Place the 3D model', 'Choose its file in the 3D model panel on the right: it is set on the ground and fitted to the buildings.');
        return null;
      }
      if (!route) throw new Error(`${file.name} is not a kind of file MR Studio takes.`);
      const answer = await fetch(`/api/data/${route === 'sound' ? 'sounds' : 'media'}?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      const page = (await answer.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!answer.ok || !page.path) throw new Error(page.error ?? `${file.name} could not be added.`);
      mediaChanged();
      last = (await mediaItems()).find((i) => i.path === page.path) ?? { kind: kindOf(page.path), path: page.path };
      this.history.notify(`Added ${file.name}`, 'It is in the Media tab, and every list of the editor offers it.');
    }
    return last;
  }

  /** The panel of a setup tab, made the first time the tab opens. */
  private panel(tab: SetupTab): Wizard {
    let panel = this.panels.get(tab);
    if (!panel) {
      panel = new Wizard(
        {
          store: this.store,
          send: (method, params) => this.send(method, params),
          add: (manifest) => this.add(manifest),
          show: (id) => this.show(id),
          controller: () => {},
          present: () => this.presentButton.click(),
          close: () => this.setRibbonTab('edit'),
          // Moving the table reloads every surface; the editor comes back on this tab.
          resumeAt: (step) => {
            try {
              if (step < 0) sessionStorage.removeItem(TAB_KEY);
              else sessionStorage.setItem(TAB_KEY, tab);
            } catch {
              // No session storage: the editor comes back on Edit.
            }
          },
          hold: (on) => this.hold(on),
          bringIn: (target) => this.bringIn(target),
        },
        { step: SETUP_STEP[tab], panel: true },
      );
      panel.onPending = () => this.ribbonTab === 'place' && this.renderRibbon(this.instances());
      this.panels.set(tab, panel);
    }
    return panel;
  }

  /** Puts the open setup tab's panel beside the map, where the inspector is, and closes the others. */
  private showPanel(): void {
    const tab = this.ribbonTab;
    for (const [id, panel] of this.panels) {
      if (id === tab) continue;
      panel.setShown(false);
      panel.element.remove();
    }
    this.shell.classList.toggle('is-panel', isSetupTab(tab));
    if (!isSetupTab(tab)) return;
    const panel = this.panel(tab);
    if (!panel.element.isConnected) this.body.append(panel.element);
    panel.setShown(true);
  }

  /** The Add data dialog: the same importer as "Your place", with the kind of data left to the author. */
  private addData(file?: File): void {
    const dialog = el('dialog', 'im-dialog');
    dialog.ariaLabel = 'Add data';
    const head = el('header', 'im-dialog-head');
    const close = el('button', 'ed-icon-button', '×');
    close.type = 'button';
    close.ariaLabel = 'Close';
    close.addEventListener('click', () => dialog.close());
    head.append(el('h2', undefined, 'Add data'), close);
    /** Adds the layer that shows a file just brought in, set to that file. */
    const showWith = async (id: string, params: Record<string, unknown>) => {
      const manifest = this.store.manifests.find((m) => m.id === id);
      if (manifest) {
        await this.add(manifest);
        if (this.added) await this.send('layer.set', { layer: this.added, params });
      }
      dialog.close();
    };
    const importer = new Importer({
      site: () => this.store.state.site,
      hold: (on) => this.hold(on),
      cancel: () => dialog.close(),
      // Coloured as it came in (#94): the data gets a layer of its own on the table.
      showAs: async (layer) => {
        await layerFromImport(this.builderHost(), layer);
        dialog.close();
      },
      // A plan drawing (#193): a Masterplan layer that reveals it phase by phase.
      showPlan: (dataset) => showWith('plan', { dataset }),
      // A video (#194): a Video walk that plays it on the controller.
      showVideo: (dataset) => showWith('walkthrough', { video: dataset }),
    });
    dialog.append(head, el('p', 'wz-lead', 'Bring a file into the table, or fetch it from OpenStreetMap. It is copied into the table and stays on this computer.'), importer.element);
    // From Add media: the file is already chosen, and its kind guessed from its name.
    if (file) importer.takeFile(file);
    dialog.addEventListener('close', () => dialog.remove());
    this.shell.append(dialog);
    dialog.showModal();
  }

  /** Opens the guide at "Your place", at the row for `target`. */
  private bringIn(target: string): void {
    this.openWizard(false, 1);
    this.wizard?.bringIn(target);
  }

  private closeWizard(): void {
    // A reload must not open the guide again once the author has left it.
    const url = new URL(location.href);
    if (url.searchParams.has('welcome') || url.searchParams.has('setup')) {
      url.searchParams.delete('welcome');
      url.searchParams.delete('setup');
      history.replaceState(history.state, '', url);
    }
    this.wizard?.element.remove();
    this.wizard = null;
    this.shell.classList.remove('is-setup');
    this.drawGuideButton();
    this.context = { kind: 'home' };
    this.show(null);
    this.render();
  }

  /** Opens one layer on the map and closes the rest, as its button on the controller does. Null leaves the map at rest. */
  private show(id: string | null): void {
    const { store, connection } = this;
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
  private showController(only: boolean): void {
    if (!this.preview.firstChild) {
      const frame = el('iframe');
      frame.src = '/tv';
      frame.title = 'The controller, live';
      this.preview.append(frame);
      // The controller is laid out for a full screen; it is scaled down to fit.
      const fit = (): void => {
        const scale = Math.min((this.preview.clientWidth - 32) / 1600, (this.preview.clientHeight - 32) / 900);
        frame.style.transform = `translate(-50%, -50%) scale(${Math.max(0.1, scale)})`;
      };
      new ResizeObserver(fit).observe(this.preview);
    }
    // The map and the controller are on show together; `only` gives the controller the whole space.
    this.surfaces.classList.toggle('is-controller-only', only);
  }

  /** A press on the live controller selects that layer here, so the two stay in step. */
  private follow(id: string, state: LayerState): void {
    if (this.wizard || (this.context.kind !== 'home' && this.context.kind !== 'layer')) return;
    const manifest = this.store.manifest(state.layer);
    // A slideshow showing a layer is not someone opening that layer.
    if (!manifest || isAtRest(manifest, state) || state.parent || state.shown_by) return;
    const mine = this.context.kind === 'layer' && this.context.id === id;
    if (state.active && !mine && !manifest.alongside) this.context = { kind: 'layer', id };
    else if (!state.active && mine) this.context = { kind: 'home' };
    else return;
    this.render();
  }

  // ---- Requests -------------------------------------------------------------

  private async send(method: string, params: object): Promise<any> {
    this.pending++;
    try {
      const result = await this.connection.request(method, params);
      this.setSaved();
      return result;
    } catch (error) {
      this.setSaved((error as Error).message);
      return null;
    } finally {
      this.pending--;
    }
  }

  private setSaved(problem?: string): void {
    this.problem = problem ?? null;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.saved.replaceChildren(icon(problem ? 'alert' : 'check', 14), el('span', undefined, problem ?? `Saved ${time}`));
    this.saved.title = problem ? 'This change could not be saved. Click for the history.' : `Every change is saved as you make it. Last saved at ${time}. Click for the history.`;
    this.saved.classList.toggle('is-error', Boolean(problem));
  }

  // ---- File (#130) ----------------------------------------------------------

  /** Waits until every change sent to the host has been answered, for up to five seconds. */
  private async settled(): Promise<void> {
    for (let waited = 0; this.pending > 0 && waited < 5000; waited += 50) await new Promise((r) => setTimeout(r, 50));
  }

  /** Stores a picture of the table for its card on Home. Never in the way of leaving. */
  private async keepPicture(): Promise<void> {
    try {
      const blob = await this.snapshot?.();
      if (blob) await fetch('/api/site/thumbnail', { method: 'POST', body: blob });
    } catch (error) {
      // Home shows a plain card instead.
      console.warn('The picture of the table was not kept:', error);
    }
  }

  /**
   * One File action, from the File button, the keys or the app's native menu. Save checks
   * that every change has reached the host. Anything that leaves the table also asks
   * before leaving a change that failed, and keeps a picture of the table for Home.
   */
  private async file(action: FileAction): Promise<void> {
    const now = performance.now();
    if (this.lastFile && this.lastFile.action === action && now - this.lastFile.at < 600) return;
    this.lastFile = { action, at: now };
    const invoke = shell();
    await this.settled();
    if (action === 'save') {
      if (this.pending > 0) this.setSaved('Still saving. Is the table connected?');
      else if (this.problem) this.setSaved(this.problem);
      else this.setSaved();
      this.saved.classList.remove('is-flash');
      void this.saved.offsetWidth;
      this.saved.classList.add('is-flash');
      void this.keepPicture();
      if (invoke) void invoke('file_action', { action, checked: true }).catch(() => {});
      return;
    }
    if (!invoke) return;
    const leaving = action === 'close' || action === 'home' || action === 'open' || action === 'new' || action === 'save_as';
    if (leaving) {
      const problem = this.pending > 0 ? 'it is still on its way to the table' : this.problem;
      if (problem && !(await confirmLeave(problem))) return;
      await this.keepPicture();
    }
    try {
      await invoke('file_action', { action, checked: true });
    } catch (error) {
      // An older app without the File menu: Home is the way out it has.
      if (action === 'home' || action === 'close' || action === 'open') await invoke('open_home').catch(() => {});
      else this.setSaved(String(error));
    }
  }

  private listenForFile(): void {
    const invoke = shell();
    window.addEventListener('keydown', (event) => {
      const action = actionFor(event, Boolean(invoke));
      if (!action) return;
      event.preventDefault();
      void this.file(action);
    });
    // The app's native menu (src-tauri/src/file_menu.rs) asks the page to check first.
    window.addEventListener('mrs-file', (event) => {
      const detail = (event as CustomEvent<{ action: string; then?: FileAction; message?: string; detail?: string }>).detail;
      if (detail.action === 'ask' && detail.then) void this.file(detail.then);
      if (detail.action === 'problem' && detail.message) this.setSaved(detail.message);
      if (detail.action === 'exported' && detail.message) this.history.notify(detail.message, detail.detail);
    });
    // The window's own close button: the app waits a moment for this before it closes.
    (window as { mrsBeforeLeave?: () => void }).mrsBeforeLeave = () => void this.keepPicture();
  }

  /** Adds a layer to the table, or with `parent` into that layer as an item that comes and goes with it. */
  private async add(manifest: LayerManifest, parent?: string): Promise<void> {
    if (parent) {
      const result = await this.send('scene.add', { use: manifest.id, parent });
      if (result?.id) this.added = result.id;
      this.render();
      return;
    }
    // Ambient life belongs to the home screen, which lies under the layers: it goes above the last ambient layer, not on top.
    let index: number | undefined;
    if (isAmbient(manifest)) {
      const tops = this.siblings(null);
      let last = -1;
      tops.forEach((id, at) => {
        const other = this.store.manifest(this.store.state.layers[id]?.layer ?? '');
        if (other && isAmbient(other)) last = at;
      });
      if (last >= 0) index = last + 1;
    }
    // A new button goes on the side of the controller with fewer, so neither side stands empty.
    let button: { side: 'left' | 'right' } | undefined;
    if (!isAmbient(manifest)) {
      const count = { left: 0, right: 0 };
      for (const { id, manifest: other, state } of this.instances()) if (!isAmbient(other) && !state.parent) count[layerButton(id, other, state, defaultSideOf(this.store, id)).side]++;
      button = { side: count.right < count.left ? 'right' : 'left' };
    }
    const result = await this.send('scene.add', { use: manifest.id, index, button });
    // The reply can arrive before the scene event that brings the new layer; it is selected when it does.
    if (result?.id) this.added = result.id;
    this.render();
  }

  /**
   * Adds from the ribbon, but asks first when the same kind is already in the place it would go (#183):
   * the table's layers, the map at rest, or the open layer's items.
   */
  private async addChecked(manifest: LayerManifest, parent?: string): Promise<void> {
    const ambient = isAmbient(manifest);
    const same = this.instances().find(
      (i) => i.manifest.id === manifest.id && (i.state.parent ?? undefined) === parent && (parent !== undefined || isAmbient(i.manifest) === ambient),
    );
    if (!same) return this.add(manifest, parent);
    const name = layerButton(same.id, same.manifest, same.state, defaultSideOf(this.store, same.id));
    const parentState = parent ? this.store.state.layers[parent] : undefined;
    const parentManifest = parentState && this.store.manifest(parentState.layer);
    const where = parent && parentState && parentManifest ? `in ${layerButton(parent, parentManifest, parentState).name}` : ambient ? `on the map at rest` : `on this table`;
    const detail = parent
      ? `It already comes on with that layer. A second one draws on top of the first.`
      : ambient
        ? `A second one draws on top of the first.`
        : `It already has a button on the ${name.side} of the controller${name.name !== manifest.name ? `, named ${name.name}` : ''}. A second one gets a button of its own.`;
    const choice = await this.ask(`${manifest.name} is already ${where}`, detail, [
      { id: 'show', label: 'Show the one I have' },
      { id: 'add', label: 'Add another', primary: true },
    ]);
    if (choice === 'add') return this.add(manifest, parent);
    if (choice === 'show') {
      if (parent) this.go({ kind: 'layer', id: parent }, same.id);
      else if (ambient) {
        this.homeItem = same.id;
        this.go({ kind: 'home' });
      } else this.go({ kind: 'layer', id: same.id });
    }
  }

  /** A small question in a dialog. Resolves to the chosen id, or null when it is closed with Escape or ×. */
  private ask(title: string, text: string, choices: { id: string; label: string; primary?: boolean }[]): Promise<string | null> {
    return new Promise((resolve) => {
      const dialog = el('dialog', 'im-dialog ed-ask');
      dialog.ariaLabel = title;
      const head = el('header', 'im-dialog-head');
      const close = el('button', 'ed-icon-button', '\u00d7');
      close.type = 'button';
      close.ariaLabel = 'Cancel';
      close.addEventListener('click', () => dialog.close());
      head.append(el('h2', undefined, title), close);
      const actions = el('div', 'ed-ask-actions');
      let chosen: string | null = null;
      for (const choice of choices) {
        const node = button(choice.primary ? 'ed-button is-primary' : 'ed-button', choice.label);
        node.dataset.choice = choice.id;
        node.addEventListener('click', () => {
          chosen = choice.id;
          dialog.close();
        });
        actions.append(node);
      }
      dialog.append(head, el('p', 'wz-lead', text), actions);
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(chosen);
      });
      this.shell.append(dialog);
      dialog.showModal();
      actions.querySelector<HTMLElement>('.is-primary')?.focus();
    });
  }

  /** What the layer builder and the palette need from the editor. */
  private builderHost(): BuilderHost {
    return {
      store: this.store,
      send: (method, params) => this.send(method, params),
      addData: () => this.addData(),
      hold: (on) => this.hold(on),
      addLayer: async (use) => {
        const id = use.replace(/^custom:/, '');
        // The new layer reaches this surface with the host's catalogue event; wait for it briefly.
        for (let i = 0; i < 40 && !this.store.manifest(id); i++) await new Promise((r) => setTimeout(r, 50));
        const manifest = this.store.manifest(id);
        if (manifest) await this.add(manifest);
      },
    };
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

  /** The ids in one list of the scene, bottom first: the table's own layers (`null`), or one layer's items. */
  private siblings(parent: string | null): string[] {
    const { scene, layers } = this.store.state;
    return scene.filter((id) => (layers[id]?.parent ?? null) === parent);
  }

  /** The instance the ribbon's tools act on. */
  private target(): string | null {
    if (this.context.kind === 'layer') return this.layerItem ?? this.context.id;
    if (this.context.kind === 'home') return this.homeItem;
    return null;
  }

  private go(context: Context, item: string | null = null): void {
    // Choosing something to edit brings back its settings, which a setup tab's panel and Media cover.
    if (isSetupTab(this.ribbonTab) || this.ribbonTab === 'media') this.setRibbonTab('edit');
    if (context.kind !== 'layer' || this.context.kind !== 'layer' || this.context.id !== context.id || item !== null) this.layerItem = item;
    this.context = context;
    // Choosing a layer shows it on the map, the way pressing its button does; the home screen is the map at rest.
    if (context.kind === 'layer') this.show(context.id);
    if (context.kind === 'home') this.show(null);
    this.render();
  }

  // ---- Chrome ---------------------------------------------------------------

  private titleBar(): HTMLElement {
    const bar = el('header', 'ed-title');
    const invoke = shell();
    // The brand is the way home, as a logo is (#130). It checks that everything is saved first.
    const brand = el(invoke ? 'button' : 'div', 'ed-brand');
    brand.append(icon('layers', 18), el('span', undefined, 'MR Studio'));
    if (brand instanceof HTMLButtonElement) {
      brand.type = 'button';
      brand.title = 'All tables. Everything here is already saved.';
      brand.addEventListener('click', () => void this.file('home'));
    }
    // In the app the File menu is native (the Mac menu bar, the editor window's menu bar on
    // Windows), so the button would repeat it (#148). A browser has no menu: it gets the button.
    const file = invoke ? null : fileButton(false, (action) => void this.file(action));
    const name = el('div', 'ed-name');
    this.titleName.textContent = this.store.state.site.name;
    name.append(this.titleName, this.saved);
    const steps = el('div', 'ed-steps');
    steps.append(this.history.undoButton, this.history.redoButton);

    const actions = el('div', 'ed-actions');
    const preview = button('ed-button', 'Preview', 'play');
    preview.title = 'Open the table in a window on this screen';
    preview.addEventListener('click', () => openView('table'));
    const guide = button('ed-button', 'Setup guide', 'route');
    this.guideButton = guide;
    guide.addEventListener('click', () => (this.wizard ? this.closeWizard() : this.openWizard()));
    actions.append(guide);
    const present = button('ed-button is-primary', 'Present', 'tv');
    this.presentButton = present;
    // Tells the desktop shell that this page has its own Present control.
    present.dataset.shellPresent = '';
    let presenting = false;
    const draw = (): void => {
      present.replaceChildren(icon(presenting ? 'stop' : 'tv', 16), el('span', undefined, presenting ? 'Stop presenting' : 'Present'));
      present.classList.toggle('is-primary', !presenting);
      present.title = presenting
        ? 'Take the map off the projector and the controller off its screen'
        : invoke
          ? 'Show the map on the projector and the controller on its screen. Ctrl+Shift+E on a full screen brings this editor back.'
          : 'Open the map and the controller in two windows';
    };
    const refresh = async (): Promise<void> => {
      if (!invoke) return;
      try {
        presenting = ((await invoke('presenting_state')) as { presenting: boolean }).presenting;
        draw();
      } catch {
        // An older shell: the button stays as Present.
      }
    };
    present.addEventListener('click', async () => {
      if (!invoke) {
        window.open('/table', 'mrstudio-table');
        window.open('/tv', 'mrstudio-tv');
        return;
      }
      present.disabled = true;
      try {
        await invoke(presenting ? 'stop_presenting' : 'present');
        this.saved.classList.remove('is-error');
      } catch (error) {
        this.saved.textContent = String(error);
        this.saved.classList.add('is-error');
      }
      present.disabled = false;
      await refresh();
    });
    draw();
    if (invoke) {
      // Inside the desktop app: the way back to the list of sites and the displays.
      // "Home" is the button visitors press on the controller; this one leaves the table.
      const sites = button('ed-button', 'All tables', 'grid');
      sites.title = 'Back to your tables: open another one or start a new one. Everything here is already saved.';
      sites.addEventListener('click', () => void this.file('home'));
      actions.append(sites);
      window.addEventListener('focus', () => void refresh());
      void refresh();
    }
    actions.append(preview, present);
    bar.append(brand, ...(file ? [file] : []), steps, name, actions);
    return bar;
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
    // What only the operator needs to know lives here, never on the visitors' controller.
    const phones = el('span', 'ed-phones');
    const showPhones = (): void => {
      const { join_url: url, code } = this.store.state.session;
      phones.textContent = url ? `Phones join with ${code}` : 'Phones cannot join';
      phones.title = url
        ? `Visitors join at ${url}`
        : 'Phones on this network cannot join yet. Turn on "Let phones on this network join" in Displays and settings, or start with --lan from the command line.';
      phones.classList.toggle('is-off', !url);
    };
    showPhones();
    this.store.onParticipants(showPhones);
    const engine = el('span', 'ed-engine');
    void this.connection
      .request<{ backend: string; adapter: string | null }>('engine.info')
      .then((info) => {
        engine.textContent = info.adapter ? `Engine: ${info.adapter}` : `Engine: ${info.backend}, no graphics card`;
      })
      .catch(() => {});
    bar.append(el('span', undefined, shell() ? 'Changes are saved as you make them. File > Save As makes a copy.' : 'Changes are saved as you make them'), el('span', 'ed-grow'), phones, engine, connected, el('span', undefined, `${Math.round(width_m)} × ${Math.round(height_m)} m`));
    return bar;
  }

  // ---- Render ---------------------------------------------------------------

  private render(): void {
    const instances = this.instances();
    const added = instances.find((i) => i.id === this.added);
    if (added) {
      this.added = null;
      if (added.state.parent) {
        // A new item opens with its layer, selected.
        this.context = { kind: 'layer', id: added.state.parent };
        this.layerItem = added.id;
        this.show(added.state.parent);
      } else {
        this.context = isAmbient(added.manifest) ? { kind: 'home' } : { kind: 'layer', id: added.id };
        if (isAmbient(added.manifest)) this.homeItem = added.id;
        // A new layer opens on the map too, as if its button had been pressed.
        else this.show(added.id);
      }
    }
    // The edited layer may have been removed, here or by someone else.
    if (this.context.kind === 'layer' && !instances.some((i) => i.id === (this.context as { id: string }).id)) this.context = { kind: 'home' };
    if (this.homeItem && !instances.some((i) => i.id === this.homeItem)) this.homeItem = null;
    const open = this.context.kind === 'layer' ? this.context.id : null;
    if (this.layerItem && !instances.some((i) => i.id === this.layerItem && i.state.parent === open)) this.layerItem = null;
    this.sync.clear();
    this.renderRibbon(instances);
    this.renderTree(instances);
    this.renderCanvas(instances);
    this.renderInspector(instances);
    this.renderNext(instances);
    for (const { id, state } of instances) this.sync.get(id)?.(state);
  }

  /** A table that is not ready yet says what it still lacks, one thing at a time, and offers the step of the guide that gives it. */
  private renderNext(all: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    const instances = all.filter((i) => !i.state.parent);
    const data = this.store.state.site.data ?? {};
    let lack: { text: string; action: string; step: number; target?: string } | null = null;
    if (!('buildings' in data)) lack = { text: 'This table has no buildings yet, so the map is empty.', action: 'Bring in your place', step: 1 };
    else if (!instances.some((i) => isAmbient(i.manifest))) lack = { text: 'The map shows nothing when no layer is open.', action: `Choose what shows ${AT_REST.toLowerCase()}`, step: 2 };
    else if (instances.every((i) => isAmbient(i.manifest))) lack = { text: 'There are no layers yet. Each layer becomes a button on the controller.', action: 'Choose layers', step: 3 };
    else if (instances.some((i) => i.manifest.id === 'cars') && !('roads' in data)) lack = { text: 'Traffic has no streets to drive on, so no cars are shown.', action: 'Bring in streets', step: 1, target: 'data:roads' };
    this.next.hidden = lack === null || this.wizard !== null;
    if (!lack) return;
    const go = button('ed-button is-primary', lack.action, 'route');
    const { step, target } = lack;
    go.addEventListener('click', () => (target ? this.bringIn(target) : this.openWizard(false, step)));
    this.next.replaceChildren(el('strong', undefined, 'Next'), el('span', undefined, lack.text), go);
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

  private insertTool(manifest: LayerManifest, large: boolean, parent?: string): HTMLButtonElement {
    const tool = button(large ? 'ed-tool is-large' : 'ed-tool', manifest.name, manifest.icon, large ? 20 : 16);
    tool.dataset.layer = manifest.id;
    const data = this.store.state.site.data ?? {};
    const missing = (manifest.requires?.data ?? []).filter((name) => !(name in data));
    const source = missing[0] ? targetFor(missing[0])?.target : undefined;
    tool.title = missing.length > 0 ? `${manifest.description ?? manifest.name}. This table has no ${missing.join(' or ')} data yet.${source ? ' Click to bring it in.' : ''}` : (manifest.description ?? manifest.name);
    tool.classList.toggle('is-needs', missing.length > 0);
    // A layer that needs data takes the author to the place to bring it in, rather than doing nothing.
    tool.disabled = missing.length > 0 && !source;
    tool.addEventListener('click', () => {
      if (missing.length === 0) void this.addChecked(manifest, parent);
      else if (source) this.bringIn(source);
    });
    return tool;
  }

  private renderRibbon(instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    if (this.ribbonTab === 'help') {
      this.renderHelpRibbon();
      return;
    }
    if (isSetupTab(this.ribbonTab)) {
      this.renderSetupRibbon(this.ribbonTab, instances);
      return;
    }
    if (this.ribbonTab === 'media') {
      const tool = (label: string, iconName: string, large = false) => button(large ? 'ed-tool is-large' : 'ed-tool', label, iconName, large ? 20 : 16);
      this.ribbon.replaceChildren(...this.mediaTab.ribbon(tool, (name, ...children) => this.group(name, ...children), (tools) => this.column(tools)));
      return;
    }
    if (this.ribbonTab === 'display') {
      // The Display tab keeps its own controls, so a slider being dragged is not rebuilt when the scene changes.
      if (this.ribbon.firstElementChild !== this.displayTab.groups[0]) this.ribbon.replaceChildren(...this.displayTab.groups);
      this.displayTab.refresh();
      return;
    }
    const groups: HTMLElement[] = [];
    const target = this.target();
    const selected = instances.find((i) => i.id === target);

    // The ribbon is the same whatever is selected (#182): the same groups in the same places, and a
    // tool that does not apply right now is greyed out with the reason, never taken away.
    const { kind } = this.context;
    const ambient = this.store.manifests.filter((m) => isAmbient(m) && isOffered(m));
    const layers = this.store.manifests.filter((m) => !isAmbient(m) && isOffered(m));
    // Map life goes into the layer that is open, or onto the map at rest; the group says which.
    const openId = kind === 'layer' ? (this.context as { id: string }).id : undefined;
    const opened = openId ? this.store.state.layers[openId] : undefined;
    const openedManifest = opened && this.store.manifest(opened.layer);
    // A slideshow's items are its slides, added from its Slides list.
    const sequence = Boolean(openedManifest?.sequence);
    const openName = openId && openedManifest && opened ? layerButton(openId, openedManifest, opened).name : undefined;
    if (ambient.length > 0) {
      const into = openId && !sequence ? openId : undefined;
      const tools = ambient.map((m) => {
        const tool = this.insertTool(m, false, into);
        if (sequence) {
          tool.disabled = true;
          tool.title = 'A slideshow shows its slides, not map life. Pick At rest or another layer to add this.';
        }
        return tool;
      });
      const name = sequence ? 'Map life' : `Map life: adds to ${openName ?? AT_REST}`;
      const group = this.group(name, ...this.column(tools));
      group.title = openName && !sequence ? `These go into ${openName} and show while it is open` : `These go onto the map at rest, under every layer`;
      groups.push(group);
    }
    if (layers.length > 0) groups.push(this.group('Add a layer', ...layers.map((m) => this.insertTool(m, true))));
    // Make a layer of your own from the table's data, and the colours every layer shares (#38, #93).
    const custom = button('ed-tool is-large', 'Custom layer', 'brush', 20);
    custom.title = 'Make a layer from your own data: choose the data, then style it, move it and save it as a button';
    custom.addEventListener('click', () => newCustomLayer(this.builderHost(), this.shell));
    const palette = button('ed-tool is-large', 'Palette', 'palette', 20);
    palette.title = 'The colours every custom layer uses. Change one and the whole table follows.';
    palette.addEventListener('click', () => paletteDialog(this.builderHost(), this.shell));
    const forget = button('ed-tool', 'Delete custom', 'trash');
    const saved = this.store.manifests.filter((m) => m.custom).length;
    forget.disabled = saved === 0;
    forget.title = saved ? 'Delete custom layers this table no longer needs, wherever they are used' : 'This table has no custom layers';
    forget.addEventListener('click', () => deleteCustomDialog(this.builderHost(), this.shell));
    groups.push(this.group('Make your own', custom, palette, ...this.column([forget])));

    // The selection: always the same four tools, greyed out when nothing is selected or a tool does not apply.
    {
      const live = selected && (kind === 'home' || kind === 'layer') ? selected : undefined;
      const parent = live?.state.parent ?? null;
      const onMap = live ? isAmbient(live.manifest) || parent !== null : false;
      const none = 'Select something in the list on the left first';
      const canShow = Boolean(live && onMap && !(parent && sequence));
      const on = live && canShow ? (parent ? this.comesOn(live.id) : live.state.active) : false;
      const show = button('ed-tool', on ? 'Hide' : 'Show', on ? 'eye-off' : 'eye');
      show.disabled = !canShow;
      show.title = !live ? none : !canShow ? 'A layer shows when its button is pressed on the controller' : parent ? 'Whether this comes on when its layer opens' : 'Show or hide this when no layer is open';
      show.addEventListener('click', () => {
        if (!live) return;
        if (parent) this.itemOn.set(live.id, !on);
        void this.send('scene.set', { layer: live.id, active: !on });
      });
      // Up and down step over the neighbours in the same list: map life among itself,
      // layers among themselves, and a layer's items among themselves.
      const list = this.siblings(parent);
      const peers = live ? instances.filter((i) => (i.state.parent ?? null) === parent && (parent !== null || isAmbient(i.manifest) === onMap)).map((i) => i.id) : [];
      const place = live ? peers.indexOf(live.id) : -1;
      // `peers` runs top first, so the one in front is the one before.
      const front = place > 0 ? peers[place - 1] : undefined;
      const behind = place >= 0 ? peers[place + 1] : undefined;
      const up = button('ed-tool', 'Move up', 'up');
      up.title = !live ? none : onMap ? 'Draw this above the next one on the map' : 'Move this button up on the controller';
      up.disabled = !front;
      up.addEventListener('click', () => live && front && void this.send('scene.move', { layer: live.id, index: list.indexOf(front) }));
      const down = button('ed-tool', 'Move down', 'down');
      down.title = !live ? none : onMap ? 'Draw this below the previous one on the map' : 'Move this button down on the controller';
      down.disabled = !behind;
      down.addEventListener('click', () => live && behind && void this.send('scene.move', { layer: live.id, index: list.indexOf(behind) }));
      const remove = button('ed-tool', 'Remove', 'trash');
      remove.title = live ? 'Take this out of the table' : none;
      remove.disabled = !live;
      remove.addEventListener('click', () => live && void this.send('scene.remove', { layer: live.id }));
      const name = live ? `Selected: ${layerButton(live.id, live.manifest, live.state).name}` : 'Nothing selected';
      groups.push(this.group(name, ...this.column([show, up, down]), ...this.column([remove])));
    }

    const open = (label: string, iconName: string, role: 'table' | 'tv' | 'dev', tip: string) => {
      const tool = button('ed-tool', label, iconName);
      tool.title = tip;
      tool.addEventListener('click', () => openView(role));
      return tool;
    };
    const data = button('ed-tool is-large', 'Add data', 'map', 20);
    data.title = 'Bring in a file or OpenStreetMap data: buildings, ground, trees, streets, walking paths, trips or a dataset of your own';
    data.addEventListener('click', () => this.addData());
    groups.push(this.group('Your place', data));

    const windows = this.group(
      'Open in a window',
      ...this.column([open('Map', 'table', 'table', 'The map projected on the table'), open('Controller', 'tv', 'tv', 'The screen beside the table'), open('Developer', 'code', 'dev', 'The workbench: map, controls, widget gallery, live values, action log and problems')]),
    );
    windows.classList.add('is-last');
    groups.push(windows);
    this.ribbon.replaceChildren(...groups);
  }

  /**
   * The ribbons of the setup tabs (#311, #312, #313). The panel beside the map holds the step of
   * the guide; the ribbon holds the quick tools for it, PowerPoint-style.
   */
  private renderSetupRibbon(tab: SetupTab, instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    const groups: HTMLElement[] = [];
    const addData = (): HTMLButtonElement => {
      const data = button('ed-tool is-large', 'Add data', 'map', 20);
      data.title = 'Bring in a file or OpenStreetMap data for the table';
      data.addEventListener('click', () => this.addData());
      return data;
    };
    if (tab === 'place') {
      const panel = this.panel('place');
      const move = button('ed-tool is-large', 'Move the table', 'route', 20);
      move.disabled = !panel.pending;
      move.title = panel.pending ? 'Rename, move, resize or turn the table as the panel says. Undo puts it back.' : 'Change the name or the place in the panel first';
      move.addEventListener('click', () => panel.moveTable());
      const back = button('ed-tool', 'Put back', 'undo');
      back.disabled = !panel.pending;
      back.title = 'Forget the changes in the panel';
      back.addEventListener('click', () => panel.putBack());
      groups.push(this.group('Place', move, ...this.column([back])));
      groups.push(this.group('Your place', addData()));
    } else if (tab === 'rest') {
      // Each piece of map life switches on and off here; the panel has the words and the base map's style.
      const ambient = this.store.manifests.filter((m) => isAmbient(m) && isOffered(m));
      const data = this.store.state.site.data ?? {};
      const tools = ambient.map((manifest) => {
        const mine = instances.filter((i) => i.manifest.id === manifest.id && !i.state.parent);
        const on = mine.length > 0;
        const tool = button('ed-tool', manifest.name, manifest.icon);
        tool.dataset.layer = manifest.id;
        tool.setAttribute('aria-pressed', String(on));
        tool.classList.toggle('is-pressed', on);
        const missing = (manifest.requires?.data ?? []).filter((name) => !(name in data));
        tool.disabled = !on && missing.length > 0;
        tool.title = on ? `Take ${manifest.name.toLowerCase()} off the map at rest` : missing.length ? `Needs ${missing.join(' and ')} data first` : (manifest.description ?? manifest.name);
        tool.addEventListener('click', async () => {
          tool.disabled = true;
          if (on) for (const { id } of mine) await this.send('scene.remove', { layer: id });
          else await this.add(manifest);
        });
        return tool;
      });
      if (tools.length) groups.push(this.group('Map life', ...this.column(tools)));
      groups.push(this.group('Your place', addData()));
    } else {
      // The controller's theme as a gallery, as PowerPoint's Design tab has, and the button style.
      const tv = this.store.state.site.tv;
      const chosen = chosenTheme(tv);
      const gallery = el('div', 'ed-themes');
      gallery.setAttribute('role', 'radiogroup');
      gallery.ariaLabel = 'Controller theme';
      THEMES.forEach((theme, index) => {
        const card = el('button', 'ed-theme');
        card.type = 'button';
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', String(theme.id === chosen));
        card.title = `${theme.name}: ${theme.description}`;
        card.append(themeSwatch(theme), el('span', undefined, theme.name));
        card.addEventListener('click', () => void this.send('site.tv', themeChoice(index)));
        gallery.append(card);
      });
      groups.push(this.group('Theme', gallery));
      const style = tv?.rail_style ?? 'icons';
      const styles = (['icons', 'labelled'] as const).map((value) => {
        const tool = button('ed-tool', value === 'icons' ? 'Icons' : 'Icons and names', value === 'icons' ? 'grid' : 'bars');
        tool.setAttribute('aria-pressed', String(style === value));
        tool.classList.toggle('is-pressed', style === value);
        tool.title = value === 'icons' ? 'Each button is its icon; the name shows when it is pressed' : 'Each button shows its icon and its name';
        tool.addEventListener('click', () => void this.send('site.tv', { tv: { rail_style: value === 'icons' ? null : value } }));
        return tool;
      });
      groups.push(this.group('Buttons', ...this.column(styles)));
      const controller = button('ed-tool is-large', 'Controller', 'tv', 20);
      controller.title = 'Open the controller in a window of its own';
      controller.addEventListener('click', () => openView('tv'));
      const window = this.group('Window', controller);
      window.classList.add('is-last');
      groups.push(window);
    }
    this.ribbon.replaceChildren(...groups);
  }

  /**
   * The Help tab (#271): the guide opens in a window of its own, at the page a tool names.
   * The guides come from help.json, which is built from docs/guide when the app is built.
   */
  private renderHelpRibbon(): void {
    if (!this.helpPages) {
      this.helpPages = [];
      fetch('/help.json')
        .then((r) => r.json())
        .then((help: { pages: { id: string; kind: string; title: string; summary: string }[] }) => {
          this.helpPages = help.pages;
          if (this.ribbonTab === 'help') this.renderHelpRibbon();
        })
        .catch(() => {});
    }
    const pages = this.helpPages;
    const tool = (label: string, iconName: string, page: string, tip: string, large = false) => {
      const node = button(large ? 'ed-tool is-large' : 'ed-tool', label, iconName, large ? 20 : 16);
      node.title = tip;
      node.addEventListener('click', () => openHelp(page));
      return node;
    };
    const guides = pages.filter((p) => p.kind === 'guide');
    const latest = pages.find((p) => p.kind === 'release');
    const groups = [
      this.group('Guide', tool('Open the guide', 'info', guides[0]?.id ?? '', 'Every feature and step-by-step guides, in a window of their own', true)),
      this.group('Step by step', ...this.column(guides.map((g) => tool(g.title, 'route', g.id, g.summary)))),
      this.group('Features', tool('Everything on the table', 'layers', 'features', 'Every layer, what it shows and where to find it', true)),
      this.group('Problems', tool('When something is wrong', 'alert', 'troubleshooting', 'The usual problems and how to fix them: projection, phones, empty layers, speed, updates', true)),
    ];
    const news = this.group("What's new", tool(latest ? latest.title.replace('MR Studio ', 'Version ') : "What's new", 'sparkle', latest?.id ?? 'features', 'What the newest versions brought', true));
    news.classList.add('is-last');
    groups.push(news);
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

  /**
   * The + beside Layers (#305): a menu of the layers this table can add, the same tools and
   * data checks as the ribbon's Add a layer group, then a custom layer or new data.
   */
  private newLayerMenu(anchor: HTMLButtonElement): void {
    document.querySelector('.ed-add-menu')?.remove();
    if (anchor.getAttribute('aria-expanded') === 'true') {
      anchor.setAttribute('aria-expanded', 'false');
      return;
    }
    const menu = el('div', 'ed-file-menu ed-add-menu');
    menu.setAttribute('role', 'menu');
    menu.ariaLabel = 'New layer';
    const close = (): void => {
      menu.remove();
      anchor.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
    };
    const outside = (event: PointerEvent): void => {
      if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
    };
    const item = (node: HTMLButtonElement): HTMLButtonElement => {
      node.className = `ed-file-item ed-add-item${node.classList.contains('is-needs') ? ' is-needs' : ''}`;
      node.setAttribute('role', 'menuitem');
      node.addEventListener('click', close);
      return node;
    };
    const offered = this.store.manifests.filter((m) => !isAmbient(m) && isOffered(m));
    for (const manifest of offered) menu.append(item(this.insertTool(manifest, false)));
    if (offered.length > 0) menu.append(el('hr'));
    const custom = item(button('ed-tool', 'Custom layer…', 'brush'));
    custom.title = 'Make a layer from your own data: choose the data, then style it, move it and save it as a button';
    custom.addEventListener('click', () => newCustomLayer(this.builderHost(), this.shell));
    const data = item(button('ed-tool', 'Add data…', 'map'));
    data.title = 'Bring in a file or OpenStreetMap data';
    data.addEventListener('click', () => this.addData());
    menu.append(custom, data);
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        anchor.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const rows = [...menu.querySelectorAll<HTMLButtonElement>('.ed-add-item:not(:disabled)')];
        const at = rows.indexOf(document.activeElement as HTMLButtonElement);
        rows[(at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
      }
    });
    const box = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${box.bottom + 4}px`;
    menu.style.left = `${Math.max(8, box.left)}px`;
    menu.style.maxHeight = `${Math.max(160, window.innerHeight - box.bottom - 16)}px`;
    this.shell.append(menu);
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    menu.querySelector<HTMLButtonElement>('.ed-add-item:not(:disabled)')?.focus();
  }

  private renderTree(instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    const { context } = this;
    const ambient = instances.filter((i) => isAtRest(i.manifest, i.state) && !i.state.parent);
    const layers = instances.filter((i) => !isAtRest(i.manifest, i.state) && !i.state.parent);
    const nodes: HTMLElement[] = [];

    nodes.push(el('h2', 'ed-tree-title', 'Map'));
    const home = this.treeRow(AT_REST, ambient.length > 0 ? ambient.map((i) => i.manifest.name).join(', ') : 'Nothing yet', 'moon', context.kind === 'home', () => this.go({ kind: 'home' }));
    home.dataset.context = 'home';
    nodes.push(home);

    const title = el('h2', 'ed-tree-title', 'Layers');
    const plus = el('button', 'ed-icon-button');
    plus.type = 'button';
    plus.ariaLabel = 'New layer';
    plus.title = 'New layer';
    plus.append(icon('plus', 14));
    plus.setAttribute('aria-haspopup', 'menu');
    plus.setAttribute('aria-expanded', 'false');
    plus.addEventListener('click', () => this.newLayerMenu(plus));
    title.append(plus);
    nodes.push(title);
    if (layers.length === 0) nodes.push(el('p', 'ed-empty', 'No layers yet. Each layer becomes a button on the controller. Add one with the + above, or under Add a layer in the ribbon.'));
    for (const { id, manifest, state } of layers) {
      const as = layerButton(id, manifest, state);
      const row = this.treeRow(as.name, '', as.icon, context.kind === 'layer' && context.id === id, () => this.go({ kind: 'layer', id }));
      row.dataset.layer = id;
      const side = el('span', 'ed-row-side');
      row.append(side);
      this.sync.set(id, (next) => {
        const button = layerButton(id, manifest, next, defaultSideOf(this.store, id));
        row.querySelector('.ed-row-label')!.textContent = button.name;
        row.querySelector('.ed-row-icon')!.replaceChildren(icon(button.icon));
        side.textContent = button.side === 'right' ? 'Right' : 'Left';
      });
      nodes.push(row);
      // Its items, indented under it: they show only while it is open.
      for (const item of instances.filter((i) => i.state.parent === id)) {
        const child = this.treeRow(item.manifest.name, '', item.manifest.icon, context.kind === 'layer' && context.id === id && this.layerItem === item.id, () =>
          this.go({ kind: 'layer', id }, item.id),
        );
        child.classList.add('is-item');
        child.dataset.layer = item.id;
        child.title = `${item.manifest.name}: shows while ${as.name} is open`;
        child.classList.toggle('is-off', !this.comesOn(item.id));
        const previous = this.sync.get(item.id);
        this.sync.set(item.id, (next) => {
          previous?.(next);
          child.classList.toggle('is-off', !this.comesOn(item.id));
        });
        nodes.push(child);
      }
    }

    nodes.push(el('h2', 'ed-tree-title', 'Around the table'));
    nodes.push(this.treeRow('Controller', 'Buttons, controls and dashboard', 'tv', context.kind === 'controller', () => this.go({ kind: 'controller' })));
    nodes.push(this.treeRow('Phones', 'Personal controllers', 'phone', context.kind === 'phone', () => this.go({ kind: 'phone' })));
    this.tree.replaceChildren(...nodes);
  }

  private renderCanvas(instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    const { context } = this;
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
      notice = `Visitors join with the code ${this.store.state.session.code}. Choosing which layers a phone may control comes with a later step of the editor.`;
    } else if (context.kind === 'table') {
      iconName = 'settings';
      title = 'Table settings';
      detail = 'This table only. The controller shows its title and welcome line.';
    } else if (context.kind === 'controller') {
      iconName = 'tv';
      title = 'Controller';
      detail = 'The screen beside the table: layer buttons, controls, legend and dashboard';
      notice = 'The map stays visual. Words, buttons and numbers live on the controller. Arranging it here comes with a later step of the editor. ';
    }
    if (this.wizard) return;
    if (this.ribbonTab === 'media') {
      const badge = el('span', 'ed-row-icon');
      badge.append(icon('folder'));
      this.canvasHead.replaceChildren(badge, el('strong', undefined, 'Media'), el('span', undefined, 'Every file and online source this table can show'));
      this.notice.hidden = true;
      this.mediaTab.drawView();
      return;
    }
    const showsController = context.kind === 'controller' || context.kind === 'table';
    this.showController(showsController);
    if (showsController) notice = null;
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

    // The group of buttons it sits in on its rail. The groups already in use are offered.
    const group = el('input');
    const known = el('datalist');
    known.id = `ed-groups-${id}`;
    Object.assign(group, { type: 'text', maxLength: 40, placeholder: 'None, for example Simulations' });
    group.setAttribute('list', known.id);
    group.addEventListener('focus', () => {
      const names = new Set(Object.values(this.store.state.layers).flatMap((l) => (l.button?.group ? [l.button.group] : [])));
      known.replaceChildren(...[...names].sort().map((n) => Object.assign(el('option'), { value: n })));
    });
    group.addEventListener('change', () => set({ group: group.value.trim() || null }));

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
    section.append(el('h3', undefined, 'Button on the controller'), field('Name', name), field('Description', description), field('Group', group), known, row, iconRow);

    const previous = this.sync.get(id);
    this.sync.set(id, (state) => {
      previous?.(state);
      const button = layerButton(id, manifest, state, defaultSideOf(this.store, id));
      if (document.activeElement !== name) name.value = state.button?.name ?? '';
      if (document.activeElement !== description) description.value = state.button?.description ?? '';
      if (document.activeElement !== group) group.value = state.button?.group ?? '';
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
  private settings(id: string, manifest: LayerManifest, title = 'Settings'): HTMLElement {
    const section = el('section', 'ed-section');
    const parentState = this.store.state.layers[this.store.state.layers[id]?.parent ?? ''];
    const item = Boolean(parentState);
    // A slide comes on when the slideshow reaches it, so it has no switch of its own.
    const slide = Boolean(parentState && this.store.manifest(parentState.layer)?.sequence);
    const shown = el('div', 'control control-toggle');
    const label = el('label', 'control-label', item ? 'Comes on with the layer' : 'Shown on the map');
    // A layer is opened by its button, so only the map's own things and a layer's items have this switch.
    shown.hidden = (!isAmbient(manifest) && !item) || slide;
    const power = el('input');
    Object.assign(power, { type: 'checkbox', className: 'switch', id: `shown-${id}` });
    label.htmlFor = power.id;
    power.addEventListener('change', () => {
      if (item) this.itemOn.set(id, power.checked);
      void this.send('scene.set', { layer: id, active: power.checked });
    });
    shown.append(label, power);

    const send = paramSender(this.connection, id, { method: 'scene.set' });
    const widgets: Widget[] = visibleControls(manifest.controls).map((control) =>
      widget(
        control,
        (value) => send({ [control.id]: value }),
        () => void this.connection.request('layer.action', { layer: id, action: control.id }).catch(() => {}),
      ),
    );
    // Each control has an eye: closed, the controller and phones leave the control out. It stays here.
    const offered = !isAmbient(manifest) && !item;
    const rows = widgets.map((w) => {
      const row = el('div', 'ed-setting');
      const eye = el('button', 'ed-eye');
      eye.type = 'button';
      eye.setAttribute('role', 'switch');
      eye.ariaLabel = `Show ${w.control.label} on the controller`;
      eye.addEventListener('click', () => {
        const hide = new Set(this.store.state.layers[id]?.hide ?? []);
        if (hide.has(w.control.id)) hide.delete(w.control.id);
        else hide.add(w.control.id);
        void this.send('scene.set', { layer: id, hide: [...hide] });
      });
      row.append(w.row);
      if (offered) row.append(eye);
      return { row, eye, w };
    });
    const controls = el('div', 'controls');
    controls.append(shown, ...rows.map((r) => r.row));
    const heading = el('h3', 'ed-settings-head', title);
    // A core layer has a page of its own in the Help window (#291).
    if (!manifest.custom && manifest.id) {
      const help = button('ed-help-link', 'How to use it', 'info', 14);
      help.title = `How to use ${manifest.name ?? 'this layer'}: what it needs, each setting and tips`;
      help.ariaLabel = help.title;
      help.addEventListener('click', () => openHelp(`layer-${manifest.id}`));
      heading.append(help);
    }
    section.append(heading, controls);
    if (offered && rows.length > 0) section.append(el('p', 'ed-empty', 'The eye beside a setting decides whether visitors get it on the controller and their phones.'));

    const previous = this.sync.get(id);
    this.sync.set(id, (state) => {
      previous?.(state);
      power.checked = item ? this.comesOn(id) : state.active;
      for (const { row, eye, w } of rows) {
        row.hidden = !isVisible(w.control, state.params);
        w.sync(state.params[w.control.id], state.params);
        const hidden = Boolean(state.hide?.includes(w.control.id));
        eye.setAttribute('aria-checked', String(!hidden));
        eye.title = hidden ? 'Hidden from the controller and phones. Click to show it.' : 'Shown on the controller. Click to hide it from visitors.';
        eye.replaceChildren(icon(hidden ? 'eye-off' : 'eye', 14));
        row.classList.toggle('is-hidden', hidden);
      }
    });
    return section;
  }

  /** Whether an item is set to come on when its layer opens, as saved in the table. */
  private comesOn(id: string): boolean {
    const state = this.store.state.layers[id];
    if (!state?.parent) return Boolean(state?.active);
    // While the layer is open the item's state says it; while it is closed, the saved choice is not sent, so ask the layer.
    const layer = this.store.state.layers[state.parent];
    if (layer?.active) this.itemOn.set(id, state.active);
    return this.itemOn.get(id) ?? true;
  }

  /** What a layer holds: the items that show while it is open, with a way to add more. */
  private itemsSection(layer: string, name: string, instances: { id: string; manifest: LayerManifest; state: LayerState }[]): HTMLElement {
    const section = el('section', 'ed-section');
    section.dataset.items = layer;
    section.append(el('h3', undefined, 'In this layer'));
    const items = instances.filter((i) => i.state.parent === layer);
    if (items.length === 0) section.append(el('p', 'ed-empty', `Nothing yet. Public transport, traffic, trees or lights added from "Add to this layer" above show only while ${name} is open.`));
    for (const { id, manifest } of items) {
      const row = this.treeRow(manifest.name, '', manifest.icon, this.layerItem === id, () => {
        this.layerItem = this.layerItem === id ? null : id;
        this.render();
      });
      row.dataset.layer = id;
      row.classList.toggle('is-off', !this.comesOn(id));
      const previous = this.sync.get(id);
      this.sync.set(id, (next) => {
        previous?.(next);
        row.classList.toggle('is-off', !this.comesOn(id));
      });
      section.append(row);
    }
    return section;
  }

  private renderInspector(instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
    if (this.ribbonTab === 'media' && !this.wizard) {
      this.inspector.replaceChildren(...this.mediaTab.inspector());
      return;
    }
    const { context } = this;
    const nodes: HTMLElement[] = [];
    const head = (iconName: string | undefined, title: string, detail: string) => {
      const header = el('header', 'ed-inspector-head');
      header.append(icon(iconName), el('strong', undefined, title), el('span', undefined, detail));
      return header;
    };

    if (context.kind === 'home') {
      nodes.push(head('moon', AT_REST, 'When no layer is open'));
      const ambient = instances.filter((i) => isAtRest(i.manifest, i.state) && !i.state.parent);
      const section = el('section', 'ed-section');
      section.append(el('h3', undefined, 'On the map'));
      if (ambient.length === 0) section.append(el('p', 'ed-empty', 'Nothing yet. Add a base map and some ambient life from the toolbar above.'));
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
    } else if (context.kind === 'table') {
      nodes.push(head('settings', 'Table settings', this.store.state.site.name));
      const invoke = desktop();
      nodes.push(
        ...tableSettings({
          store: this.store,
          send: (method, params) => this.send(method, params),
          place: () => this.setRibbonTab('place'),
          appSettings: invoke ? () => void invoke('open_settings') : null,
        }),
      );
    } else if (context.kind === 'layer') {
      const layer = instances.find((i) => i.id === context.id)!;
      const as = layerButton(layer.id, layer.manifest, layer.state);
      nodes.push(head(as.icon, as.name, layer.manifest.custom ? 'Custom layer' : 'Layer'));
      // A custom layer is styled here: data, look, motion and interaction, with its button as the last tab.
      if (layer.manifest.custom) nodes.push(builderSection(this.builderHost(), layer.manifest, this.buttonSection(layer.id, layer.manifest)));
      else nodes.push(this.buttonSection(layer.id, layer.manifest));
      // A slideshow's slides come before its settings: they are what the author works on.
      if (!layer.manifest.sequence && (layer.manifest.controls?.length ?? 0) + (layer.manifest.custom ? 0 : 1) > 0) nodes.push(this.settings(layer.id, layer.manifest));
      if (layer.manifest.sequence) {
        nodes.push(
          slidesSection(
            {
              store: this.store,
              send: (method, params) => this.send(method, params),
              select: (item) => {
                this.layerItem = item;
                this.render();
              },
              open: (other) => this.go({ kind: 'layer', id: other }),
              watch: (callback) => {
                const previous = this.sync.get(layer.id);
                this.sync.set(layer.id, (next) => {
                  previous?.(next);
                  callback(next);
                });
              },
              selected: this.layerItem,
            },
            layer.id,
          ),
        );
        nodes.push(this.settings(layer.id, layer.manifest));
      } else nodes.push(this.itemsSection(layer.id, as.name, instances));
      const open = instances.find((i) => i.id === this.layerItem && i.state.parent === layer.id);
      if (open) nodes.push(this.settings(open.id, open.manifest, open.manifest.name));
    } else {
      nodes.push(head(context.kind === 'controller' ? 'tv' : 'phone', context.kind === 'controller' ? 'Controller' : 'Phones', ''));
      nodes.push(
        el(
          'p',
          'ed-empty',
          context.kind === 'controller'
            ? 'This is the controller as visitors see it, live. Press a button to try it. To change a button, choose its layer on the left.'
            : `Visitors join with the code ${this.store.state.session.code}. Choosing what phones may control comes later.`,
        ),
      );
    }
    this.inspector.replaceChildren(...nodes);
  }
}
