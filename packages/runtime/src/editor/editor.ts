// The editor (#540): one editor state, wired together around the parts that draw and act on it.
// Each part is a module of functions that take this state: save-state.ts (Saved, Saving…),
// layer-list.ts (the list's rules) and layer-rows.ts (the list as drawn), format-pane.ts (the
// right-hand pane), canvas.ts (the map, controller and phone previews), dialogs.ts, chrome.ts (title
// and status bars), ribbon-commands.ts, file-keys.ts (File menu, keys, commands), adding.ts,
// setup-guide.ts and ready-checks.ts. Fields the parts share are not private.
import type { Connection, LayerManifest, LayerState, MediaKind } from '@mrstudio/sdk';

import { el, isAmbient, isAtRest, layerButton } from '../controls.ts';
import type { Store } from '../store.ts';
import './gallery.css';
import { DisplayTab } from './display-tab.ts';
import { MediaTab } from './media-tab.ts';
import { ModelImporter } from './model-import.ts';
import { DrawingFrame } from './drawing-frame.ts';
import type { MediaItem } from '../media.ts';
import type { BuilderHost } from './builder.ts';
import { icon } from './icons.ts';
import { HistoryControls } from './history.ts';
import { SaveState } from './save-state.ts';
import type { SaveWords } from './save-state.ts';
import { CanvasTools } from './canvas-tools.ts';
import { fitRibbon } from './ribbon-fit.ts';
import type { RailFit } from '../rail-fit.ts';
import type { PanelFit } from '../dashboard.ts';

/** The controller's word that an open layer's controls scroll because of its legend (#660). */
export interface LegendFit {
  type: 'mrs-legend-fit';
  layer: string;
  scrolls: boolean;
  mode: string;
}
import { FIRST_TAB, RIBBON } from './layout.ts';
import type { CommandHandlers } from './ribbon-layout.ts';
import { FetchAll } from './fetch-all.ts';
import { TimeBar } from './time-bar.ts';
import { Rehearsal } from './rehearse.ts';
import { Wizard } from './wizard.ts';
import './editor.css';
import { renderInspector } from './format-pane.ts';
import { clickToSelect, drawPhone, follow, renderCanvas, show, shrinkControls } from './canvas.ts';
import { listRails, renderTree } from './layer-rows.ts';
import { commandHandlers, renderRibbon } from './ribbon-commands.ts';
import { inspectorResize, statusBar, titleBar } from './chrome.ts';
import { closeDialog, drawMedia, openDialog } from './dialogs.ts';
import { add, listenForFile, listenForKeys, menuAction, setDrawer } from './file-keys.ts';
import { fixCheck, readyChecks, showChecks } from './ready-checks.ts';
import { addData, addMedia, addWith, gallery } from './adding.ts';
import { closeWizard, drawGuideButton, openWizard, startTour } from './setup-guide.ts';

/**
 * What is being edited. The ribbon, the canvas header and the inspector follow it,
 * so only the tools that fit are on show. MR Studio has three surfaces: the map on
 * the table, which is visual and carries almost no text; the controller, the screen
 * beside it with the layer buttons, controls, legend and dashboard; and phones.
 */
export type Context = { kind: 'home' } | { kind: 'layer'; id: string } | { kind: 'controller' } | { kind: 'phone' };

type Invoke = (command: string, args?: object) => Promise<unknown>;

/** The desktop app's commands, or undefined in a browser. */
export function shell(): Invoke | undefined {
  return (window as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;
}
/** The same, for where `shell` names the editor's element. */
export const desktop = (): Invoke | undefined => shell();

/**
 * Opens one view of the table in a window of its own. The desktop app is asked directly,
 * as Present is: macOS does not reliably let `window.open` out of the webview (#51). A
 * browser, or an older app without the command, opens a window the usual way.
 */
export function openView(role: 'table' | 'tv' | 'dev'): void {
  const fallback = () => window.open(`/${role}`, `mrstudio-${role}`);
  const invoke = shell();
  if (invoke) invoke('open_view', { role }).catch(fallback);
  else fallback();
}

/**
 * Opens the Help window (#271) at a page. The page goes through local storage, so a Help
 * window that is already open turns to it too; a browser opens /help#page.
 */
export function openHelp(page: string): void {
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

/**
 * Every button says what it does when the pointer rests on it (#88): one with only an icon and
 * an aria-label shows that label, so no control in the editor is a mystery.
 */
function tooltips(root: HTMLElement): void {
  const fill = (node: Element): void => {
    if (!(node instanceof HTMLButtonElement) || node.title) return;
    const label = node.ariaLabel ?? node.getAttribute('aria-label');
    if (label) node.title = label;
  };
  const all = (node: Node): void => {
    if (!(node instanceof Element)) return;
    fill(node);
    node.querySelectorAll('button[aria-label]:not([title])').forEach(fill);
  };
  all(root);
  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'attributes') fill(change.target as Element);
      else change.addedNodes.forEach(all);
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] });
}

export function button(className: string, label: string, iconName?: string, size = 16): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName, size));
  node.append(el('span', undefined, label));
  return node;
}

/** What a layer in trouble shows in words (#259). */
export function troubleText(health: NonNullable<LayerState['health']>): string {
  const again = health.status === 'retrying' ? (health.retry_in ? ` Trying again in ${Math.round(health.retry_in)} s.` : ' Trying again.') : '';
  return `Not running: ${health.reason}.${again}`;
}

/** A red dot on a layer's row while it is in trouble, with why in its tooltip (#259). */
export function markTrouble(row: HTMLElement, state: LayerState | undefined): void {
  const health = state?.health;
  row.classList.toggle('is-trouble', Boolean(health));
  if (health) row.title = troubleText(health);
  else if (row.dataset.troubleTitle !== undefined) row.title = row.dataset.troubleTitle;
}

/** A tab of the ribbon, as layout.ts names it. Not part of what is being edited: opening one changes the ribbon only (#385). */
type RibbonTab = string;
/** The dialogs of whole-table and this-computer settings (docs/editor-ui.md, rule 5). */
export type DialogId = 'place' | 'welcome' | 'pages' | 'screens' | 'media' | 'open-data' | 'model';
/** A window too narrow for the list, the map and the settings side by side (#66); the CSS uses the same width. */
export const NARROW = matchMedia('(max-width: 1099px)');
/** The ribbon tab to come back to after the page reloads, as after moving the table. */
const TAB_KEY = 'mrs-ribbon-tab';
/** The dialog to open again after that reload. */
const DIALOG_KEY = 'mrs-dialog';

/**
 * The editor: the authoring window around the live table. Every change goes to the
 * host as a `scene.*` request, which also writes it to site.json, so there is no
 * separate save: File > Save makes sure nothing is still on its way and says so (#130).
 */
/** A picture's side file (#52): the picture's name and its edges on the map. Null for anything else. */
export function sideFile(text: string): { image?: unknown; bounds?: Record<string, unknown> } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { image?: unknown; bounds?: Record<string, unknown> }) : null;
  } catch {
    return null;
  }
}

/** Opened read-only from Home (#565): the app runs a copy, so nothing done here reaches the table. */
export function readOnly(): boolean {
  return new URLSearchParams(location.search).get('readonly') === '1';
}

export class Editor {
  /** Where the live table goes. */
  readonly canvas = el('div', 'ed-canvas');
  /** Takes a picture of the table, once the table is up; kept for Home when the table is left (#131). */
  snapshot: (() => Promise<Blob | null>) | null = null;
  /** What drew under a point of the map, topmost first, and which layers read clicks themselves; set once the table is up (#425). */
  picker: { hits(clientX: number, clientY: number): string[]; listens(id: string): boolean } | null = null;
  /** The last File action and when, so one asked for twice at once (menu and keys) runs once. */
  lastFile: { action: string; at: number } | null = null;

  context: Context = { kind: 'home' };
  /** The home screen item whose settings are open. */
  homeItem: string | null = null;
  /** The item of the open layer whose settings are open. */
  layerItem: string | null = null;
  /** Whether each item comes on with its layer, as last seen while its layer was open or as set here. */
  itemOn = new Map<string, boolean>();
  /** A layer this editor just added, to select once it is in the scene. */
  added: string | null = null;
  sync = new Map<string, (state: LayerState) => void>();

  readonly store: Store;
  readonly connection: Connection;
  readonly ribbon = el('div', 'ed-ribbon');
  /**
   * The ribbon's tabs, from the layout file (layout.ts, #392). They hold commands only: the
   * selection, the canvas and the map are the editor's state, and no tab changes them (#382, #385).
   */
  private readonly tabs = el('div', 'ed-tabs');
  ribbonTab: RibbonTab = FIRST_TAB;
  /** What every command does, by its id in commands-list.ts (#392). */
  readonly handlers: CommandHandlers;
  /** The open dialog of whole-table or this-computer settings, if any. */
  dialog: { id: DialogId; element: HTMLDialogElement } | null = null;
  /** Table size and place (#382, was the Name and place tab): the guide's first step, made once so a half-typed place survives. */
  placePanel: Wizard | null = null;
  modelImporter: ModelImporter | null = null;
  /** Open data, made once so a fetch under way survives closing its dialog (#310). */
  fetchAll: FetchAll | null = null;
  /** The Help tab's list of guides, from help.json (#271); fetched the first time the tab opens. */
  helpPages: { id: string; kind: string; title: string; summary: string }[] | null = null;
  /** Screens and calibration (#382, was the Display tab): this computer's displays, in a dialog. */
  readonly displayTab: DisplayTab;
  /** The media library (#306, #382): everything the table has, in a dialog from View. */
  readonly mediaTab: MediaTab;
  /** A Masterplan's frame on the map, to place its drawing by hand (#301). */
  readonly drawingFrame = new DrawingFrame({
    site: () => this.store.state.site,
    place: (corners) => {
      const id = this.framedDrawing;
      if (id) void this.send('scene.set', { layer: id, params: { corners } });
    },
    drawing: () => {
      const params = this.framedDrawing ? this.store.state.layers[this.framedDrawing]?.params : undefined;
      return params ? { dataset: String(params.dataset ?? ''), turn: Number(params.turn ?? 0) || 0 } : null;
    },
  });
  /** The Masterplan whose frame is shown. */
  framedDrawing: string | null = null;
  /** Each Masterplan's turn when last seen, to keep its shape when it changes. */
  readonly drawingTurns = new Map<string, number>();
  readonly tree = el('nav', 'ed-tree');
  readonly canvasHead = el('header', 'ed-canvas-head');
  readonly surfaces = el('div', 'ed-surfaces');
  /** Map, controller or both in the middle, the map's zoom and its outline (#60). */
  readonly canvasTools: CanvasTools;
  /** Scrubs a layer that runs on time through the day in the preview (#61). */
  private readonly timeBar: TimeBar;
  readonly notice = el('div', 'ed-notice');
  /** The one thing this table still lacks, with the way to it. */
  private readonly next = el('div', 'ed-next');
  readonly inspector = el('aside', 'ed-inspector');
  readonly saved = el('button', 'ed-saved');
  /** Changes on their way to the host, and what the saved button says about them (#68). */
  readonly saving = new SaveState((words) => this.drawSaved(words), readOnly);
  /** Undo, redo and the History panel, on the host's revision history (#57, #72). */
  history!: HistoryControls;
  readonly titleName = el('strong');
  readonly shell = el('div', 'ed');
  readonly body = el('div', 'ed-body');
  /** The live controller, shown in the middle in place of the map. */
  readonly preview = el('div', 'ed-preview');
  presentButton!: HTMLButtonElement;
  /** Share by email (#372), in the app only; off while the table is being packed. */
  shareButton?: HTMLButtonElement;
  guideButton!: HTMLButtonElement;
  wizard: Wizard | null = null;
  /** The guide step to come back at after the next reload, when it is not the one on show. */
  resumeStep: number | null = null;
  /** While held, a change of site waits to reload the page; `true` once one came in. */
  private held = false;
  /** The projector calibration (calibration.json `projector`) is saved on this computer (#657). */
  projectorCalibrated = false;
  private reloadWaiting = false;
  lastAction: { action: string; at: number; from: string } | null = null;
  /** Rehearse (#97): the table as a visitor sees it, from here, with nothing saved. */
  rehearsal!: Rehearsal;
  /** Ready to present? (#63): the count of what is left to check, and the list behind it. */
  readonly checksButton = el('button', 'ed-checks');
  /**
   * Buttons that do not fit on a side of the controller (#614), as the live controller in the
   * canvas measures them: it is laid out like the TV, so it fits as many as the TV does.
   */
  readonly railNote = el('button', 'ed-rail-note');
  railFits: Partial<Record<'left' | 'right', RailFit>> = {};
  /** The open layers whose controls scroll on the controller because of their legend (#660). */
  legendScrolls = new Map<string, string>();
  /** Panels on the live controller whose content spills out of their box, by canvas (#681). */
  panelSpills = new Map<string, PanelFit['panels']>();
  /** How many were out of sight when the author was last told, so a warning comes once, and again only if it gets worse. */
  railWarned = 0;
  railRetry = 0;
  /** In a narrow window the inspector is a drawer over the right of the map, opened from here (#66). */
  readonly drawerToggle = el('button', 'ed-button ed-drawer-toggle');

  static readonly DIALOGS: Record<DialogId, { title: string; lead: string; modal: boolean }> = {
    place: { title: 'Table size and place', lead: 'What the table is called, where it is, how much ground it covers and how it stands in the room.', modal: true },
    welcome: { title: 'Welcome and languages', lead: 'What the controller says when nobody is using the table, and the languages visitors read.', modal: true },
    pages: { title: 'Controller pages', lead: 'Pages of panels made by hand: numbers, charts, keys and maps that read what layers publish. Without pages, the controller shows the open layers’ own panels.', modal: true },
    screens: { title: 'Screens and calibration', lead: 'This computer’s screens, projector, colour and quality. They are the same for every table on this computer.', modal: true },
    media: { title: 'Media library', lead: 'Every file and online source of this table, where each is used, and the files it still needs.', modal: true },
    model: { title: '3D model', lead: 'A model of the buildings, from Rhino, SketchUp or a scan. It is set on the ground and fitted to the buildings, and gives them their heights.', modal: true },
    'open-data': { title: 'Open data', lead: 'Fetch what this place has in OpenStreetMap and open elevation data, in one go. It is copied into the table and stays on this computer.', modal: true },
  };

  /** View › Phone (#389): a visitor's phone beside the map, live. Remembered on this computer. */
  phoneShown = false;

  readonly phoneBox = el('section', 'ed-surface is-phone');

  /** The empty table's card on the map (#399). */
  readonly emptyCanvas = el('div', 'ed-canvas-empty');

  /** A change came in while a name was being typed in the list; the list is drawn once the name is done. */
  treeWaiting = false;

  /** Rows added to the selection with Ctrl, ⌘ or Shift (#399), besides the one being edited. */
  readonly also = new Set<string>();

  constructor(root: HTMLElement, store: Store, connection: Connection) {
    this.store = store;
    this.connection = connection;
    this.history = new HistoryControls(connection, () => store.surface, (problem) => this.setSaved(problem));
    // The panel names layers and settings as the editor does (#395).
    this.history.names = {
      layer: (use) => store.manifests.find((m) => m.id === use)?.name,
      control: (use, id) => {
        const control = store.manifests.find((m) => m.id === use)?.controls?.find((c) => c.id === id);
        return control ? { label: control.label, unit: 'unit' in control ? (control.unit as string | undefined) : undefined, default: 'default' in control ? control.default : undefined } : undefined;
      },
    };
    this.saved.type = 'button';
    this.saved.addEventListener('click', () => this.history.toggle(this.saved));
    this.handlers = commandHandlers(this);

    const { shell, body } = this;
    const left = el('aside', 'ed-left');
    const name = el('header', 'ed-left-head');
    // The table's name opens Table size and place (#62, #382), as Design does.
    const tableName = el('button', 'ed-table-name');
    tableName.type = 'button';
    tableName.title = 'Table size and place: its name, where it is, its size and time zone';
    const drawName = (): void => tableName.replaceChildren(el('strong', undefined, store.state.site.name), icon('settings', 14));
    drawName();
    tableName.addEventListener('click', () => openDialog(this, 'place'));
    store.onSettings(() => {
      drawName();
      this.titleName.textContent = store.state.site.name;
      if (this.dialog?.id === 'welcome') openDialog(this, 'welcome', true);
    });
    // The app's native menu (src-tauri/src/file_menu.rs) asks for these by name.
    window.addEventListener('mrs-edit', (event) => menuAction(this, (event as CustomEvent<{ action: string }>).detail.action, 'menu'));
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
    const controllerBox = surface('controller', 'Controller', 'The screen beside the table. Buttons, words and controls.', this.preview);
    const mapBox = surface('map', 'Map', 'Projected on the table. Visual only.', this.canvas);
    // An empty table (#399): the one hint the canvas carries, and the way to its first layer.
    const go = button('ed-button is-primary', 'Insert a layer', 'plus');
    go.dataset.command = 'layer.new';
    go.addEventListener('click', () => gallery(this));
    this.emptyCanvas.append(el('strong', undefined, 'No layers yet'), el('span', undefined, 'Each layer becomes a button on the controller.'), go);
    mapBox.append(this.emptyCanvas);
    this.surfaces.append(mapBox, controllerBox);
    shrinkControls(this, controllerBox);
    this.surfaces.append(this.phoneBox);
    try {
      this.phoneShown = localStorage.getItem('mrs-phone-preview') === '1';
    } catch {
      // No storage: the phone starts hidden.
    }
    this.timeBar = new TimeBar({
      site: () => store.state.site,
      connection,
      save: (layer, params) => this.send('scene.set', { layer, params }),
    });
    centre.append(this.canvasHead, this.next, this.surfaces, this.timeBar.element, this.notice);
    this.canvasTools = new CanvasTools({
      site: () => store.state.site,
      surfaces: this.surfaces,
      canvas: this.canvas,
    });
    clickToSelect(this);
    this.mediaTab = new MediaTab({
      store,
      addMedia: (kinds) => addMedia(this, kinds),
      addLayer: (use, params) => addWith(this, use, params),
      openLayer: (id) => {
        closeDialog(this);
        const state = store.state.layers[id];
        if (state?.parent) this.go({ kind: 'layer', id: state.parent }, id);
        else if (state && isAtRest(store.manifest(state.layer)!, state)) this.go({ kind: 'home' });
        else this.go({ kind: 'layer', id });
      },
      openSources: desktop() ? () => void desktop()?.('open_sources') : undefined,
      hold: (on) => this.hold(on),
      changed: () => {
        if (this.dialog?.id === 'media') drawMedia(this);
      },
    });
    centre.append(this.mediaTab.view);
    this.rehearsal = new Rehearsal({
      store,
      connection,
      shell: this.shell,
      centre,
      buttons: () => {
        const top = this.instances().filter((i) => !i.state.parent && !isAmbient(i.manifest));
        const rails = listRails(this, top);
        return [...rails.left, ...rails.right].flatMap((id) => {
          const i = top.find((t) => t.id === id);
          return i ? [{ id, name: layerButton(id, i.manifest, i.state).name, manifest: i.manifest }] : [];
        });
      },
      checks: () => readyChecks(this),
      showChecks: () => showChecks(this),
      changed: (on) => {
        if (on && this.wizard) closeWizard(this);
        setDrawer(this, false);
        renderRibbon(this, this.instances());
        if (!on) this.render();
      },
    });

    body.append(left, centre, inspectorResize(this), this.inspector);
    const invoke = desktop();
    this.displayTab = new DisplayTab(invoke, connection, this.canvas, () => void invoke?.('open_settings', { page: 'setup' }));
    this.displayTab.setQuality(this.store.state.site.display?.quality ?? 'good');
    this.store.onDisplay((quality) => this.displayTab.setQuality(quality));
    this.tabs.setAttribute('role', 'tablist');
    this.tabs.ariaLabel = 'Ribbon';
    this.ribbon.setAttribute('role', 'tabpanel');
    shell.append(titleBar(this), this.tabs, this.ribbon, body, statusBar(this));
    this.drawTabs();
    root.append(shell);
    listenForFile(this);
    // A list of media in a layer's settings asks for Add media (#306).
    (window as { mrsAddsMedia?: boolean }).mrsAddsMedia = true;
    window.addEventListener('mrs-media-add', (event) => {
      const { kinds, done } = (event as CustomEvent<{ kinds: MediaKind[]; done: (item: MediaItem | null) => void }>).detail;
      event.preventDefault();
      void addMedia(this, kinds).then(done);
    });

    this.setSaved();
    drawGuideButton(this);
    this.render();
    store.onScene(() => this.render());
    // A new theme or button style shows as chosen on the Design tab.
    store.onTv(() => renderRibbon(this, this.instances()));
    // A custom layer was saved or removed: it is offered on the ribbon (the builder in the inspector keeps its own copy).
    store.onCatalog(() => {
      if (!this.wizard) renderRibbon(this, this.instances());
    });
    // A button that moved, was renamed or hidden can come after the scene event: the list follows it.
    const buttons = new Map(Object.entries(store.state.layers).map(([id, state]) => [id, JSON.stringify(state.button ?? {})]));
    let redraw = 0;
    store.onLayer((id, state) => {
      const button = JSON.stringify(state.button ?? {});
      if (buttons.get(id) !== button) {
        cancelAnimationFrame(redraw);
        redraw = requestAnimationFrame(() => this.render());
      }
      buttons.set(id, button);
      this.sync.get(id)?.(state);
      this.timeBar.sync(id, state);
      follow(this, id, state);
    });

    // Back and Forward move between what was being edited (#47).
    window.addEventListener('popstate', () => {
      if (this.wizard) closeWizard(this);
      if (!this.goTo(location.hash)) this.go({ kind: 'home' }, null, false);
    });
    listenForKeys(this);
    tooltips(this.shell);
    // A 13-inch laptop (#66): the ribbon folds its big tools, and a narrow window turns the settings into a drawer.
    fitRibbon(this.ribbon);
    this.drawerToggle.type = 'button';
    this.drawerToggle.append(icon('settings', 14), el('span', undefined, 'Settings'));
    this.drawerToggle.title = 'Show the settings of what is selected';
    this.drawerToggle.addEventListener('click', () => setDrawer(this, !this.shell.classList.contains('is-drawer-open')));
    this.surfaces.addEventListener('pointerdown', () => setDrawer(this, false));
    NARROW.addEventListener('change', () => setDrawer(this, false));

    // A new table opens in the guide (#390). The guide only starts a table: an empty one shows Insert a layer instead.
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
    if (resume !== undefined || created) openWizard(this, created, resume);
    else {
      startTour(this);
      // After a reload (moving the table, bringing data in), the editor comes back on the tab and the dialog it was on.
      let tab: string | null = null;
      let dialog: string | null = null;
      try {
        tab = sessionStorage.getItem(TAB_KEY);
        dialog = sessionStorage.getItem(DIALOG_KEY);
        sessionStorage.removeItem(DIALOG_KEY);
      } catch {
        // As above.
      }
      if (tab && RIBBON.some((t) => t.id === tab)) this.setRibbonTab(tab);
      // A reload comes back to what was being edited.
      if (location.hash) this.goTo(location.hash);
      if (dialog === 'place' || dialog === 'media' || dialog === 'model') openDialog(this, dialog);
    }
    // The 2.0 calibration lives under `projector` in calibration.json, kept by the host (#657):
    // asked once and followed on every save, so the readiness warning clears without a reload.
    const projectorCalibrated = (p: { projector?: unknown } | null | undefined): void => {
      const now = Boolean(p?.projector);
      if (now === this.projectorCalibrated) return;
      this.projectorCalibrated = now;
      this.renderNext();
    };
    connection.on('calibration', projectorCalibrated);
    connection.on('welcome', () => void connection.request<{ projector?: unknown }>('calibration.get', {}).then(projectorCalibrated, () => {}));
    void connection.request<{ projector?: unknown }>('calibration.get', {}).then(projectorCalibrated, () => {});
    connection.on('site.changed', (p: { site?: { table?: unknown }; table_only?: boolean }) => {
      // The table's front edge or ribbons (#62): taken in place, the projector redraws on its own.
      if (p?.table_only && p.site) {
        // The map's own code takes the new table (main.ts); the outline follows it.
        requestAnimationFrame(() => this.canvasTools.apply());
        return;
      }
      if (this.held) {
        this.reloadWaiting = true;
        return;
      }
      this.reload();
    });
  }

  /** Two changes that must land as one (move the table, then bring in a file) hold back the reload in between. */
  hold(on: boolean): void {
    this.held = on;
    if (!on && this.reloadWaiting) this.reload();
  }

  /** Starts again with the site as it now is, coming back to the guide's step. */
  private reload(): void {
    try {
      const step = this.resumeStep ?? this.wizard?.step;
      if (step !== undefined) sessionStorage.setItem('mrs-setup-step', String(step));
      // Moving the table or bringing a file in reloads the page: it comes back in the same dialog.
      if (this.dialog) sessionStorage.setItem(DIALOG_KEY, this.dialog.id);
    } catch {
      // As above.
    }
    location.reload();
  }

  /** The ribbon's tabs, as the layout file has them (#392). */
  private drawTabs(): void {
    this.tabs.replaceChildren(
      ...RIBBON.map(({ id, label, tip }) => {
        const node = el('button', 'ed-tab', label);
        node.type = 'button';
        node.setAttribute('role', 'tab');
        node.setAttribute('aria-selected', String(this.ribbonTab === id));
        node.dataset.tab = id;
        node.title = tip;
        node.addEventListener('click', () => this.setRibbonTab(id));
        return node;
      }),
    );
  }

  /**
   * Opens a tab of the ribbon. It changes the ribbon and nothing else: not the selection, the
   * canvas, the list or what the map shows (rule 3 of docs/editor-ui.md, #385).
   */
  setRibbonTab(id: RibbonTab): void {
    if (id === this.ribbonTab || !RIBBON.some((t) => t.id === id)) return;
    this.ribbonTab = id;
    try {
      sessionStorage.setItem(TAB_KEY, id);
    } catch {
      // No session storage: the editor opens at the first tab.
    }
    this.drawTabs();
    renderRibbon(this, this.instances());
  }

  // ---- Requests -------------------------------------------------------------

  async send(method: string, params: object): Promise<any> {
    return this.saving.send(() => this.connection.request(method, params));
  }

  setSaved(problem?: string): void {
    this.saving.saved(problem);
  }

  /** Draws the saved button: a spinner while saving, else its icon, and the words. */
  private drawSaved(words: SaveWords): void {
    let mark: Element;
    if (words.icon) mark = icon(words.icon, 14);
    else {
      mark = el('span', 'ed-spinner');
      mark.setAttribute('aria-hidden', 'true');
    }
    this.saved.replaceChildren(mark, el('span', undefined, words.text));
    this.saved.title = words.title;
    this.saved.classList.toggle('is-error', words.error);
  }

  /** Waits until every change sent to the host has been answered, for up to five seconds. */
  async settled(): Promise<void> {
    await this.saving.settled();
  }

  /** What the layer builder and the palette need from the editor. */
  builderHost(): BuilderHost {
    return {
      store: this.store,
      send: (method, params) => this.send(method, params),
      addData: () => addData(this),
      hold: (on) => this.hold(on),
      addLayer: async (use) => {
        const id = use.replace(/^custom:/, '');
        // The new layer reaches this surface with the host's catalogue event; wait for it briefly.
        for (let i = 0; i < 40 && !this.store.manifest(id); i++) await new Promise((r) => setTimeout(r, 50));
        const manifest = this.store.manifest(id);
        if (manifest) await add(this, manifest);
      },
    };
  }

  // ---- What is in the scene -------------------------------------------------

  /** Scene instances with their manifests, top of the scene first. */
  instances(): { id: string; manifest: LayerManifest; state: LayerState }[] {
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
  siblings(parent: string | null): string[] {
    const { scene, layers } = this.store.state;
    return scene.filter((id) => (layers[id]?.parent ?? null) === parent);
  }

  /** The instance the ribbon's tools act on. */
  target(): string | null {
    if (this.context.kind === 'layer') return this.layerItem ?? this.context.id;
    if (this.context.kind === 'home') return this.homeItem;
    return null;
  }

  go(context: Context, item: string | null = null, remember = true): void {
    if (context.kind !== 'layer' || this.context.kind !== 'layer' || this.context.id !== context.id || item !== null) this.layerItem = item;
    this.context = context;
    if (remember) this.remember();
    // Choosing something in a narrow window brings its settings out; At rest and the surfaces open the same way.
    if (remember && NARROW.matches) setDrawer(this, true);
    // Choosing a layer shows it on the map, the way pressing its button does; the home screen is the map at rest.
    if (context.kind === 'layer') show(this, context.id);
    if (context.kind === 'home') show(this, null);
    this.render();
  }

  /**
   * What is being edited goes into the window's history (#47), so Back and Forward (the mouse's
   * side buttons, Alt+arrows, a swipe) move between what was looked at instead of leaving the editor.
   * The address keeps it too, so a reload comes back to the same place.
   */
  private remember(): void {
    const where = this.where();
    if (location.hash === where) return;
    const url = new URL(location.href);
    url.hash = where;
    history.pushState({ editor: where }, '', url);
  }

  /** The address of what is being edited: #layer=wind, #item=trees-2, #controller... */
  private where(): string {
    const c = this.context;
    if (c.kind === 'layer') return this.layerItem ? `#item=${this.layerItem}` : `#layer=${c.id}`;
    if (c.kind === 'home') return this.homeItem ? `#rest=${this.homeItem}` : '#rest';
    return `#${c.kind}`;
  }

  /** Goes to an address made by `where`, as Back and a reload do. False when it names nothing on the table. */
  private goTo(hash: string): boolean {
    const [kind, id] = hash.replace(/^#/, '').split('=');
    const layers = this.store.state.layers;
    if (kind === 'layer' && id && layers[id]) this.go({ kind: 'layer', id }, null, false);
    else if (kind === 'item' && id && layers[id]?.parent) this.go({ kind: 'layer', id: layers[id].parent! }, id, false);
    else if (kind === 'rest') {
      this.homeItem = id && layers[id] ? id : null;
      this.go({ kind: 'home' }, null, false);
    } else if (kind === 'controller' || kind === 'phone') this.go({ kind }, null, false);
    else if (kind === 'table') openDialog(this, 'place');
    else return false;
    return true;
  }

  // ---- Render ---------------------------------------------------------------

  render(): void {
    const instances = this.instances();
    const added = instances.find((i) => i.id === this.added);
    if (added) {
      this.added = null;
      if (added.state.parent) {
        // A new item opens with its layer, selected.
        this.context = { kind: 'layer', id: added.state.parent };
        this.layerItem = added.id;
        show(this, added.state.parent);
      } else {
        this.context = isAmbient(added.manifest) ? { kind: 'home' } : { kind: 'layer', id: added.id };
        if (isAmbient(added.manifest)) this.homeItem = added.id;
        // A new layer opens on the map too, as if its button had been pressed.
        else show(this, added.id);
      }
    }
    // The edited layer may have been removed, here or by someone else.
    if (this.context.kind === 'layer' && !instances.some((i) => i.id === (this.context as { id: string }).id)) this.context = { kind: 'home' };
    if (this.homeItem && !instances.some((i) => i.id === this.homeItem)) this.homeItem = null;
    const open = this.context.kind === 'layer' ? this.context.id : null;
    if (this.layerItem && !instances.some((i) => i.id === this.layerItem && i.state.parent === open)) this.layerItem = null;
    this.sync.clear();
    renderRibbon(this, instances);
    renderTree(this, instances);
    for (const id of [...this.also]) {
      const row = this.tree.querySelector<HTMLElement>(`.ed-row[data-layer="${id}"]`);
      if (row) row.classList.add('is-also');
      else this.also.delete(id);
    }
    renderCanvas(this, instances);
    this.emptyCanvas.hidden = this.wizard !== null || instances.some((i) => !isAmbient(i.manifest) && !i.state.parent);
    drawPhone(this);
    renderInspector(this, instances);
    this.renderNext();
    // The time bar follows the open layer, in the editor proper (not the guide, not Media).
    const timed = this.wizard || this.context.kind !== 'layer' ? null : this.context.id;
    const timedState = timed ? this.store.state.layers[timed] : undefined;
    this.timeBar.open(timed, timedState && this.store.manifest(timedState.layer), timedState);
    for (const { id, state } of instances) this.sync.get(id)?.(state);
  }

  /**
   * A table that is not ready yet says the first thing it must have, with the way to it, and the
   * Checks button in the status bar counts everything else (#63). Both read the same rules.
   */
  private renderNext(): void {
    const checks = readyChecks(this);
    const first = checks.find((c) => c.level === 'must');
    this.next.hidden = !first || this.wizard !== null;
    if (first) {
      const go = button('ed-button is-primary', first.action, 'route');
      go.addEventListener('click', () => fixCheck(this, first));
      const more = checks.length > 1 ? el('button', 'ed-link', `${checks.length - 1} more to check`) : null;
      if (more) {
        (more as HTMLButtonElement).type = 'button';
        more.addEventListener('click', () => showChecks(this));
      }
      this.next.replaceChildren(el('strong', undefined, 'Next'), el('span', undefined, first.text), ...(more ? [more] : []), go);
    }
    const counted = checks.filter((c) => c.level !== 'nice').length;
    const worst = checks[0]?.level;
    this.checksButton.replaceChildren(icon(counted ? 'alert' : 'check', 12), el('span', undefined, counted ? `${counted} to check` : 'Ready to present'));
    this.checksButton.className = `ed-checks${worst === 'must' ? ' is-must' : counted ? ' is-should' : ' is-ready'}`;
    this.checksButton.title = counted ? 'What to check before presenting, and the way to fix each' : checks.length ? 'Ready to present. A few nice-to-haves are listed here.' : 'Nothing left to check';
  }
}
