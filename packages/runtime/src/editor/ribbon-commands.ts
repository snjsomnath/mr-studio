// The editor's ribbon as drawn, and what its commands do (#392, #540): the facts each command reads,
// the handlers, the help, theme and diagnostics tools. The commands and layout themselves are data in
// commands.ts, layout.ts and ribbon-layout.ts. Moved from editor.ts as functions of the one editor state.
import { el, isAmbient, isAtRest, layerButton, visibleControls } from '../controls.ts';
import { deleteCustomDialog, newCustomLayer, paletteDialog } from './builder.ts';
import { paletteTheme, paletteThemeChoice } from './palette-theme.ts';
import { keys as shortcut, mac } from './file-menu.ts';
import { RIBBON } from './layout.ts';
import type { WidgetId } from './layout.ts';
import { columns, drawTab } from './ribbon-layout.ts';
import type { CommandHandlers } from './ribbon-layout.ts';
import { setting } from './settings-list.ts';
import { runTour } from './tour.ts';
import { START, chosenTheme, themeChoice, themeSwatch } from './wizard.ts';
import { THEMES } from '@mrstudio/dashboard';
import { comesOn, resetLayer } from './format-pane.ts';
import { duplicate, removeLayer, rename, selection } from './layer-rows.ts';
import type { Editor } from './editor.ts';
import { shell, desktop, openView, openHelp, button } from './editor.ts';
import { openDialog, setPhone } from './dialogs.ts';
import { fileAction, menuAction } from './file-keys.ts';
import { showChecks } from './ready-checks.ts';
import { addMedia, addData, gallery } from './adding.ts';
import { openWizard, closeWizard } from './setup-guide.ts';

/**
 * What `target` (a layer, map life or an item; the selection when left out) allows, for the
 * Selection commands: whether it can be shown or hidden, and its neighbours to move past.
 */
export function facts(ed: Editor, target?: string | null) {
  const id = target ?? (ed.wizard ? null : ed.target());
  const instances = ed.instances();
  const live = id ? instances.find((i) => i.id === id) : undefined;
  const parent = live?.state.parent ?? null;
  const parentState = parent ? ed.store.state.layers[parent] : undefined;
  const sequence = Boolean(parentState && ed.store.manifest(parentState.layer)?.sequence);
  const onMap = live ? isAmbient(live.manifest) || parent !== null : false;
  const canShow = Boolean(live && onMap && !(parent && sequence));
  const on = live && canShow ? (parent ? comesOn(ed, live.id) : live.state.active) : false;
  // Up and down step over the neighbours in the same list: map life among itself,
  // layers among themselves, and a layer's items among themselves. `peers` runs top first.
  const peers = live ? instances.filter((i) => (i.state.parent ?? null) === parent && (parent !== null || isAmbient(i.manifest) === onMap)).map((i) => i.id) : [];
  const at = live ? peers.indexOf(live.id) : -1;
  return { live, parent, onMap, canShow, on, front: at > 0 ? peers[at - 1] : undefined, behind: at >= 0 ? peers[at + 1] : undefined, list: ed.siblings(parent) };
}

/** What each command in commands-list.ts does and when it is greyed out. TypeScript checks none is missing. */
export function commandHandlers(ed: Editor): CommandHandlers {
  const k = (key: string, shift = false) => shortcut(key, shift);
  const none = 'Select something in the list on the left first';
  const app = 'This needs the MR Studio app';
  const selected = (target?: string): string | null => target ?? (ed.wizard ? null : ed.target());
  const needs = (target?: string) => (selected(target) && facts(ed, target).live ? undefined : none);
  /** A layer with a button: the open layer itself, not one of its items. */
  const buttonOf = (target?: string): string | null => {
    if (target) {
      const state = ed.store.state.layers[target];
      const manifest = state && ed.store.manifest(state.layer);
      return state && manifest && !state.parent && !isAtRest(manifest, state) ? target : null;
    }
    return ed.context.kind === 'layer' && !ed.layerItem && !ed.wizard ? ed.context.id : null;
  };
  /** The layer Add inside… puts things into (#453): a layer with a button, not a slideshow (its slides are its items). */
  const insideOf = (target?: string): string | null => {
    const id = buttonOf(target);
    const state = id ? ed.store.state.layers[id] : undefined;
    const manifest = state && ed.store.manifest(state.layer);
    return id && manifest && !manifest.sequence ? id : null;
  };
  const basemap = (): string | undefined => ed.instances().find((i) => i.manifest.id === 'basemap' && !i.state.parent)?.id;
  const view = (v: 'map' | 'controller' | 'both') => ({ pressed: () => ed.canvasTools.view === v, run: () => menuAction(ed, `view-${v}`) });
  const style = (value: 'icons' | 'labelled') => ({
    pressed: () => (ed.store.state.site.tv?.rail_style ?? 'icons') === value,
    run: () => void ed.send('site.tv', { tv: { rail_style: value === 'icons' ? null : value } }),
  });
  return {
    'layer.new': { run: () => gallery(ed) },
    'dialog.inside': {
      disabled: (t) => (insideOf(t) ? undefined : 'Select a layer first: what you add goes inside it and comes on with it'),
      run: (t) => {
        const id = insideOf(t);
        const state = id ? ed.store.state.layers[id] : undefined;
        const manifest = state && ed.store.manifest(state.layer);
        if (id && state && manifest) gallery(ed, undefined, { id, name: layerButton(id, manifest, state).name });
      },
    },
    'layer.duplicate': { keys: k('D'), disabled: needs, run: (t) => withSelected(ed, t, (id) => duplicate(ed, id)) },
    'layer.remove': {
      keys: mac ? '⌫' : 'Del',
      disabled: needs,
      run: async (t) => {
        for (const id of selection(ed, t)) await removeLayer(ed, id);
        ed.also.clear();
      },
    },
    'layer.toggle': {
      label: (t) => (facts(ed, t).on ? 'Hide' : 'Show'),
      icon: (t) => (facts(ed, t).on ? 'eye-off' : 'eye'),
      disabled: (t) => {
        const f = facts(ed, t);
        return !f.live ? none : !f.canShow ? 'A layer shows when its button is pressed on the controller' : undefined;
      },
      run: (t) => {
        const f = facts(ed, t);
        if (!f.live || !f.canShow) return;
        // With several rows selected, each follows the first: all hidden, or all shown.
        for (const id of selection(ed, t)) {
          const each = id === f.live.id ? f : facts(ed, id);
          if (!each.live || !each.canShow) continue;
          if (each.parent) ed.itemOn.set(each.live.id, !f.on);
          void ed.send('scene.set', { layer: each.live.id, active: !f.on });
        }
      },
    },
    'layer.up': {
      disabled: (t) => (!facts(ed, t).live ? none : facts(ed, t).front ? undefined : 'It is already at the top of its list'),
      run: (t) => {
        const f = facts(ed, t);
        if (f.live && f.front) void ed.send('scene.move', { layer: f.live.id, index: f.list.indexOf(f.front) });
      },
    },
    'layer.down': {
      disabled: (t) => (!facts(ed, t).live ? none : facts(ed, t).behind ? undefined : 'It is already at the bottom of its list'),
      run: (t) => {
        const f = facts(ed, t);
        if (f.live && f.behind) void ed.send('scene.move', { layer: f.live.id, index: f.list.indexOf(f.behind) });
      },
    },
    'layer.rename': { keys: 'F2', disabled: (t) => (buttonOf(t) ? undefined : 'Select a layer with a button first'), run: (t) => withSelected(ed, buttonOf(t) ?? undefined, (id) => rename(ed, id)) },
    'layer.reset': {
      disabled: (t) => {
        const f = facts(ed, t);
        return !f.live ? none : visibleControls(f.live.manifest.controls).some((c) => 'default' in c) ? undefined : 'This has no settings to reset';
      },
      run: (t) => withSelected(ed, t, (id) => resetLayer(ed, id)),
    },
    'commands.search': { keys: k('K'), run: () => menuAction(ed, 'commands') },
    'layer.custom': { run: () => newCustomLayer(ed.builderHost(), ed.shell) },
    'layer.forget': {
      disabled: () => (ed.store.manifests.some((m) => m.custom) ? undefined : 'This table has no custom layers'),
      run: () => deleteCustomDialog(ed.builderHost(), ed.shell),
    },
    'data.file': { run: () => addData(ed) },
    'data.open': { run: () => openDialog(ed, 'open-data') },
    'media.picture': { run: () => void addMedia(ed, ['picture']) },
    'media.video': { run: () => void addMedia(ed, ['video']) },
    'media.sound': { run: () => void addMedia(ed, ['sound']) },
    'media.model': { run: () => openDialog(ed, 'model') },
    'buttons.icons': style('icons'),
    'buttons.labelled': style('labelled'),
    'map.basemap': {
      disabled: () => (basemap() ? undefined : 'This table has no base map. Insert › New layer › Map life adds one.'),
      run: () => {
        const id = basemap();
        if (!id) return;
        if (ed.wizard) closeWizard(ed);
        ed.homeItem = id;
        ed.go({ kind: 'home' });
      },
    },
    'map.palette': { run: () => paletteDialog(ed.builderHost(), ed.shell) },
    'dialog.place': { run: () => openDialog(ed, 'place') },
    'dialog.welcome': { run: () => openDialog(ed, 'welcome') },
    'dialog.pages': { run: () => openDialog(ed, 'pages') },
    // The starter tables have a home outside the guide (#469): the guide opens at Start from….
    'dialog.starters': { run: () => (ed.wizard ? undefined : openWizard(ed, false, START)) },
    'present.check': { run: () => showChecks(ed) },
    'present.rehearse': {
      label: () => (ed.rehearsal.on ? 'Finish rehearsal' : 'Rehearse'),
      icon: () => (ed.rehearsal.on ? 'check' : 'people'),
      pressed: () => ed.rehearsal.on,
      tip: () => (ed.rehearsal.on ? 'Put every layer back as it was (Esc)' : undefined),
      run: () => (ed.rehearsal.on ? void ed.rehearsal.finish() : ed.rehearsal.start()),
    },
    'present.start': { keys: k('Enter'), run: () => ed.presentButton.click() },
    'dialog.screens': { run: () => openDialog(ed, 'screens') },
    // Operator mode (#394): the app's own window takes over from this editor until the PIN is given.
    'present.operator': { disabled: () => (shell() ? undefined : app), run: () => void shell()?.('open_operator').catch(() => {}) },
    'file.share': { disabled: () => (shell() ? undefined : app), run: () => fileAction(ed, 'share') },
    'file.export': { disabled: () => (shell() ? undefined : app), run: () => fileAction(ed, 'export') },
    'dialog.starter': { run: () => fileAction(ed, 'starter') },
    'view.map': view('map'),
    'view.controller': view('controller'),
    'view.both': view('both'),
    'view.phone': { pressed: () => ed.phoneShown, run: () => setPhone(ed, !ed.phoneShown) },
    'zoom.fit': { keys: k('0'), run: () => menuAction(ed, 'zoom-fit') },
    'zoom.100': { keys: k('1'), run: () => menuAction(ed, 'zoom-100') },
    'view.outline': { pressed: () => ed.canvasTools.outlined, run: () => menuAction(ed, 'outline') },
    'dialog.media': { run: () => openDialog(ed, 'media') },
    'window.table': { run: () => openView('table') },
    'window.tv': { run: () => openView('tv') },
    'window.dev': { run: () => openView('dev') },
    'help.tour': { run: () => void runTour(ed.shell) },
    'help.features': { run: () => openHelp('features') },
    'help.troubleshooting': { run: () => openHelp('troubleshooting') },
    'help.shortcuts': { keys: k('/'), run: () => menuAction(ed, 'shortcuts') },
    'help.report': { run: () => menuAction(ed, 'report') },
    'edit.undo': { keys: k('Z'), run: () => void ed.history.step('undo') },
    'edit.redo': { keys: mac ? k('Z', true) : 'Ctrl+Y', run: () => void ed.history.step('redo') },
    'edit.history': { run: () => ed.history.toggle(ed.saved) },
    'file.save': { keys: k('S'), run: () => fileAction(ed, 'save') },
  };
}

/** Runs `act` on `target`, or on the selection. */
export function withSelected(ed: Editor, target: string | undefined, act: (id: string) => unknown): void | Promise<void> {
  const id = target ?? (ed.wizard ? null : ed.target());
  if (!id) return;
  const result = act(id);
  if (result instanceof Promise) return result.then(() => {});
}

/** The parts of the ribbon the editor draws itself, named by the layout file. */
export function widgets(ed: Editor): Record<WidgetId, () => HTMLElement[]> {
  return {
    themes: () => [themeGallery(ed)],
    'help.guides': () => {
      const guides = help(ed).filter((p) => p.kind === 'guide');
      const open = helpTool(ed, 'Open the guide', 'info', guides[0]?.id ?? '', 'Every feature and step-by-step guides, in a window of their own', true);
      return [open, ...columns(guides.map((g) => helpTool(ed, g.title, 'route', g.id, g.summary)))];
    },
    'help.diagnostics': () => columns(diagnosticsTools(ed)),
    'help.news': () => {
      const latest = help(ed).find((p) => p.kind === 'release');
      return [helpTool(ed, latest ? latest.title.replace('MR Studio ', 'Version ') : 'What’s new', 'sparkle', latest?.id ?? 'features', 'What the newest versions brought', true)];
    },
  };
}

/** The guides, from help.json (#271), fetched the first time they are needed. */
export function help(ed: Editor): { id: string; kind: string; title: string; summary: string }[] {
  if (!ed.helpPages) {
    ed.helpPages = [];
    fetch('/help.json')
      .then((r) => r.json())
      .then((help: { pages: { id: string; kind: string; title: string; summary: string }[] }) => {
        ed.helpPages = help.pages;
        if (ed.ribbonTab === 'help') renderRibbon(ed, ed.instances());
      })
      .catch(() => {});
  }
  return ed.helpPages;
}

export function helpTool(ed: Editor, label: string, iconName: string, page: string, tip: string, large = false): HTMLButtonElement {
  const node = button(large ? 'ed-tool is-large' : 'ed-tool', label, iconName, large ? 20 : 16);
  node.title = tip;
  node.addEventListener('click', () => openHelp(page));
  return node;
}

/** The controller's theme as a gallery, as PowerPoint's Design tab has: the one home of the theme (#382). */
export function themeGallery(ed: Editor): HTMLElement {
  const chosen = chosenTheme(ed.store.state.site.tv);
  const gallery = setting('controller.theme', 'ribbon:design', el('div', 'ed-themes'));
  gallery.setAttribute('role', 'radiogroup');
  gallery.ariaLabel = 'Controller theme';
  const card = (id: string, name: string, title: string, swatch: HTMLElement, pick: () => void): HTMLElement => {
    const node = el('button', 'ed-theme');
    node.type = 'button';
    node.dataset.theme = id;
    node.setAttribute('role', 'radio');
    node.setAttribute('aria-checked', String(chosen === id));
    node.title = title;
    node.append(swatch, el('span', undefined, name));
    node.addEventListener('click', pick);
    return node;
  };
  // The table's palette as a theme (#93): the controller in the map's own colours.
  const own = paletteTheme(ed.store.state.site.palette);
  gallery.append(card(own.id, own.name, `${own.name}: ${own.description} It follows the palette when the palette changes.`, themeSwatch(own), () => void ed.send('site.tv', paletteThemeChoice(ed.store.state.site.palette))));
  THEMES.forEach((theme, index) => gallery.append(card(theme.id, theme.name, `${theme.name}: ${theme.description}`, themeSwatch(theme), () => void ed.send('site.tv', themeChoice(index)))));
  return gallery;
}

/**
 * The ribbon: the open tab of the layout file, drawn from the commands (#392). It is the same
 * whatever is selected (#182): a command that does not apply right now is greyed out with the
 * reason, never taken away.
 */
export function renderRibbon(ed: Editor, _instances?: unknown): void {
  const tab = RIBBON.find((t) => t.id === ed.ribbonTab) ?? RIBBON[0]!;
  const groups = drawTab(tab, ed.handlers, widgets(ed));
  // The button style is a setting of the table, edited only here (docs/editor-ui.md).
  const buttons = groups.find((g) => g.dataset.group === 'Controller');
  if (buttons) setting('controller.buttons', 'ribbon:design', buttons);
  ed.ribbon.replaceChildren(...groups);
}

/**
 * Copy diagnostics (#260): one report of how the table is doing, to paste into an issue. In the
 * desktop app it also has the computer, its displays and the end of the app's log; Save and
 * the log folder are there too.
 */
export function diagnosticsTools(ed: Editor): HTMLElement[] {
  const invoke = desktop();
  const copy = button('ed-tool', 'Copy diagnostics', 'file');
  copy.title = 'Copy a report of how the table and this computer are doing, to paste into an issue. Keys are never in it.';
  copy.addEventListener('click', () => void copyDiagnostics(ed));
  // The frame meter on the table and controller for this session (#262).
  const meterOn = () => ed.store.state.session.performance === true;
  const frames = button('ed-tool', meterOn() ? 'Hide frame meter' : 'Show frame meter', 'eye');
  frames.title = 'Show frames per second and what each layer costs in a corner of the table and controller. Ctrl+Shift+P shows it on one window.';
  frames.setAttribute('aria-pressed', String(meterOn()));
  frames.addEventListener('click', () => void ed.connection.request('session.performance', { on: !meterOn() }).catch(() => {}));
  ed.connection.on('session.changed', () => {
    frames.setAttribute('aria-pressed', String(meterOn()));
    const label = frames.querySelector('span');
    if (label) label.textContent = meterOn() ? 'Hide frame meter' : 'Show frame meter';
  });
  if (!invoke) return [copy, frames];
  const logs = button('ed-tool', 'Open log folder', 'folder');
  logs.title = "The app's log and the operator log, one file per day";
  logs.addEventListener('click', () => void invoke('open_operator_log').catch(() => {}));
  return [copy, frames, logs];
}

/**
 * Gathers the diagnostics report, copies it and shows it (#260), so it can be read before it
 * is pasted anywhere. Also from Help > Copy diagnostics in the app's menu, where the copy may
 * need the dialog's own Copy button.
 */
export async function copyDiagnostics(ed: Editor): Promise<void> {
  const invoke = desktop();
  let report: string;
  try {
    report = invoke
      ? ((await invoke('diagnostics_report')) as string)
      : await fetch('/api/diagnostics?format=text', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))));
  } catch (error) {
    ed.setSaved(`The diagnostics could not be gathered: ${(error as Error).message}`);
    return;
  }
  document.querySelector('.ed-diagnostics')?.remove();
  const dialog = el('dialog', 'im-dialog ed-ask ed-diagnostics');
  dialog.ariaLabel = 'Diagnostics';
  const head = el('header', 'im-dialog-head');
  const close = el('button', 'ed-icon-button', '\u00d7');
  close.type = 'button';
  close.ariaLabel = 'Close';
  close.addEventListener('click', () => dialog.close());
  head.append(el('h2', undefined, 'Diagnostics'), close);
  const lead = el('p', 'wz-lead');
  const text = el('textarea', 'ed-diagnostics-text');
  text.readOnly = true;
  text.spellcheck = false;
  text.value = report;
  const copied = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(report);
      return true;
    } catch {
      // Without a click (from the app's menu) the clipboard can refuse: copy what is selected instead.
      text.focus();
      text.select();
      return document.execCommand('copy');
    }
  };
  const say = (ok: boolean) =>
    (lead.textContent = ok
      ? 'Copied. Paste it into an issue or an email: it says how the table and this computer are doing. Keys are never in it.'
      : 'Press Copy, then paste it into an issue or an email. Keys are never in it.');
  const again = button('ed-button is-primary', 'Copy');
  again.addEventListener('click', async () => say(await copied()));
  const actions = el('div', 'ed-ask-actions');
  if (invoke) {
    const save = button('ed-button', 'Save as a file…');
    save.addEventListener('click', () => void invoke('save_diagnostics').catch(() => {}));
    actions.append(save);
  }
  actions.append(again);
  dialog.append(head, lead, text, actions);
  dialog.addEventListener('close', () => dialog.remove());
  ed.shell.append(dialog);
  dialog.showModal();
  say(await copied());
}
