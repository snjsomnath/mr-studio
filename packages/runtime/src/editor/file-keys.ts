// The editor's File menu, keys and commands (#130, #540): opening and saving tables, the keyboard
// shortcuts, the menu actions, the command search and adding layers. Moved from editor.ts as
// functions of the one editor state; no change in behaviour.
import type { LayerManifest } from '@mrstudio/sdk';
import { defaultSideOf, isAmbient, layerButton } from '../controls.ts';
import { confirmLeave, actionFor, keys as shortcut, mac } from './file-menu.ts';
import { typing } from './tree-tools.ts';
import { RIBBON } from './layout.ts';
import { searchable } from './ribbon-layout.ts';
import { commandSearch, shortcutSheet } from './commands.ts';
import type { Command } from './commands.ts';
import type { FileAction } from './file-menu.ts';
import { openStarterPack } from './starter-pack.ts';
import { AT_REST } from './wizard.ts';
import { duplicate } from './layer-rows.ts';
import { copyDiagnostics } from './ribbon-commands.ts';
import { ask, closeDialog, openDialog } from './dialogs.ts';
import { Editor } from './editor.ts';
import { type Context, shell, openHelp, NARROW } from './editor.ts';
import { closeWizard } from './setup-guide.ts';

/** Stores a picture of the table for its card on Home. Never in the way of leaving. */
export async function keepPicture(ed: Editor): Promise<void> {
  try {
    const blob = await ed.snapshot?.();
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
export async function fileAction(ed: Editor, action: FileAction): Promise<void> {
  const now = performance.now();
  if (ed.lastFile && ed.lastFile.action === action && now - ed.lastFile.at < 600) return;
  ed.lastFile = { action, at: now };
  const invoke = shell();
  await ed.settled();
  if (action === 'starter') {
    openStarterPack(invoke, ed.store.state.site.name);
    return;
  }
  if (action === 'history') {
    ed.history.open(ed.saved);
    return;
  }
  if (action === 'save') {
    if (ed.saving.pending > 0) ed.setSaved('Still saving. Is the table connected?');
    else if (ed.saving.problem) ed.setSaved(ed.saving.problem);
    else ed.setSaved();
    ed.saved.classList.remove('is-flash');
    void ed.saved.offsetWidth;
    ed.saved.classList.add('is-flash');
    void keepPicture(ed);
    if (invoke) void invoke('file_action', { action, checked: true }).catch(() => {});
    return;
  }
  if (!invoke) return;
  const leaving = action === 'close' || action === 'home' || action === 'open' || action === 'new' || action === 'save_as';
  if (leaving) {
    const problem = ed.saving.pending > 0 ? 'it is still on its way to the table' : ed.saving.problem;
    if (problem && !(await confirmLeave(problem))) return;
    await keepPicture(ed);
  }
  try {
    await invoke('file_action', { action, checked: true });
  } catch (error) {
    // An older app without the File menu: Home is the way out it has.
    if (action === 'home' || action === 'close' || action === 'open') await invoke('open_home').catch(() => {});
    else ed.setSaved(String(error));
  }
}

export function listenForFile(ed: Editor): void {
  const invoke = shell();
  window.addEventListener('keydown', (event) => {
    const action = actionFor(event, Boolean(invoke));
    if (!action) return;
    event.preventDefault();
    void fileAction(ed, action);
  });
  // The app's native menu (src-tauri/src/file_menu.rs) asks the page to check first.
  window.addEventListener('mrs-file', (event) => {
    const detail = (event as CustomEvent<{ action: string; then?: FileAction; message?: string; detail?: string }>).detail;
    if (detail.action === 'ask' && detail.then) void fileAction(ed, detail.then);
    if (detail.action === 'problem' && detail.message) ed.setSaved(detail.message);
    if (detail.action === 'sharing') {
      if (ed.shareButton) ed.shareButton.disabled = true;
      if (detail.message) ed.history.notify(detail.message);
    }
    if (detail.action === 'exported' && ed.shareButton) ed.shareButton.disabled = false;
    if (detail.action === 'problem' && ed.shareButton) ed.shareButton.disabled = false;
    if (detail.action === 'exported' && detail.message) ed.history.notify(detail.message, detail.detail);
    // Help > Copy diagnostics in the app's menu (#260).
    if (detail.action === 'diagnostics') void copyDiagnostics(ed);
  });
  // The window's own close button: the app waits a moment for this before it closes.
  (window as { mrsBeforeLeave?: () => void }).mrsBeforeLeave = () => void keepPicture(ed);
}

/**
 * The editor's own keys (#58, #65): Delete removes what is selected, with Undo on the notice;
 * Cmd/Ctrl+D duplicates it; F2 renames a layer's button; Escape closes the guide or selects
 * nothing; the arrow keys move through the list on the left when it has the focus.
 */
export function listenForKeys(ed: Editor): void {
  window.addEventListener('keydown', (event) => {
    const mod = mac ? event.metaKey : event.ctrlKey;
    // A dialog that leaves the editor in view (Screens and calibration) closes with Escape too.
    if (event.key === 'Escape' && ed.dialog && !Editor.DIALOGS[ed.dialog.id].modal && !document.querySelector('dialog[open]:modal')) {
      event.preventDefault();
      closeDialog(ed);
      return;
    }
    // Command search and the shortcut sheet open from anywhere, a field included (#65).
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      menuAction(ed, 'commands', 'key');
      return;
    }
    if (mod && !event.altKey && (event.key === '/' || event.key === '?')) {
      event.preventDefault();
      menuAction(ed, 'shortcuts', 'key');
      return;
    }
    if (typing(event) || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (mod && !event.altKey && event.key === 'Enter') {
      event.preventDefault();
      ed.presentButton.click();
      return;
    }
    const target = ed.wizard ? null : ed.target();
    // The keys run the same commands as the ribbon (#392).
    const run = (id: 'layer.remove' | 'layer.duplicate' | 'layer.rename'): void => {
      event.preventDefault();
      if (ed.handlers[id].disabled?.() === undefined) void ed.handlers[id].run();
    };
    if ((event.key === 'Delete' || event.key === 'Backspace') && !mod && target) run('layer.remove');
    else if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd' && target) run('layer.duplicate');
    else if (event.key === 'F2' && ed.context.kind === 'layer' && !ed.layerItem) run('layer.rename');
    else if (event.key === 'Escape' && !document.querySelector('.ed-context, .ed-add-menu, .ed-history')) {
      if (ed.shell.classList.contains('is-drawer-open')) setDrawer(ed, false);
      else if (ed.wizard) closeWizard(ed);
      else if (ed.context.kind !== 'home' || ed.homeItem) {
        ed.homeItem = null;
        ed.go({ kind: 'home' });
      }
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && ed.tree.contains(document.activeElement)) {
      event.preventDefault();
      const rows = [...ed.tree.querySelectorAll<HTMLElement>('.ed-row')];
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
      next?.focus();
      next?.click();
      // The list is drawn again on a change of selection: the focus follows the row.
      const id = next?.dataset.layer ?? next?.dataset.context;
      requestAnimationFrame(() => ed.tree.querySelector<HTMLElement>(`.ed-row[data-layer="${id}"], .ed-row[data-context="${id}"]`)?.focus());
    }
  });
}

export function setDrawer(ed: Editor, open: boolean): void {
  const on = open && NARROW.matches;
  ed.shell.classList.toggle('is-drawer-open', on);
  ed.drawerToggle.setAttribute('aria-expanded', String(on));
}

/** What the native menus, the command search and the keys ask for by name (#65, #88). */
export function menuAction(ed: Editor, action: string, from: 'menu' | 'key' | 'page' = 'page'): void {
  // The app's menu shortcut and the page's own key can both bring the same press: once is enough.
  const now = performance.now();
  const last = ed.lastAction;
  ed.lastAction = { action, at: now, from };
  if (last && last.action === action && last.from !== from && from !== 'page' && last.from !== 'page' && now - last.at < 400) return;
  switch (action) {
    case 'table-settings':
      openDialog(ed, 'place');
      break;
    case 'starter-pack':
      void fileAction(ed, 'starter');
      break;
    case 'version-history':
      void fileAction(ed, 'history');
      break;
    case 'commands':
      commandSearch(() => commands(ed), ed.shell);
      break;
    case 'shortcuts':
      shortcutSheet(shortcutGroups(ed), ed.shell);
      break;
    case 'report':
      void reportProblem(ed);
      break;
    case 'help':
      openHelp('');
      break;
    case 'duplicate': {
      const target = ed.target();
      if (target) void duplicate(ed, target);
      break;
    }
    case 'view-map':
    case 'view-controller':
    case 'view-both':
      ed.canvasTools.setView(action.slice(5) as 'map' | 'controller' | 'both');
      break;
    case 'zoom-in':
      ed.canvasTools.step(1);
      break;
    case 'zoom-out':
      ed.canvasTools.step(-1);
      break;
    case 'zoom-fit':
      ed.canvasTools.setZoom('fit');
      break;
    case 'zoom-100':
      ed.canvasTools.setZoom(1);
      break;
    case 'outline':
      ed.canvasTools.setOutline(!ed.canvasTools.outlined);
      break;
  }
}

/** Every key the editor knows, for the sheet (Cmd/Ctrl+/) and the Help tab. */
export function shortcutGroups(ed: Editor): { name: string; keys: [string, string][] }[] {
  const k = (key: string, shift = false) => shortcut(key, shift);
  return [
    {
      name: 'Anywhere',
      keys: [
        ['Search commands, layers and settings', k('K')],
        ['Keyboard shortcuts', k('/')],
        ['Present', k('Enter')],
        ['Undo', k('Z')],
        ['Redo', mac ? k('Z', true) : 'Ctrl+Y'],
        ['Save', k('S')],
        ['Close the guide, or select nothing', 'Esc'],
      ],
    },
    {
      name: 'The selected layer',
      keys: [
        ['Rename its button', 'F2'],
        ['Duplicate', k('D')],
        ['Remove (Undo puts it back)', mac ? '⌫' : 'Delete'],
        ['Move through the list', '↑ ↓'],
        ['Reset one setting', `${mac ? '⌥' : 'Alt'}+click its name`],
        ['Type a value exactly', 'Click the number'],
      ],
    },
    {
      name: 'The map in the middle',
      keys: [
        ['Zoom in', k('+')],
        ['Zoom out', k('-')],
        ['Fit the map', k('0')],
        ['100 %, as on the projector', k('1')],
        ['Zoom around the pointer', `${mac ? '⌘' : 'Ctrl'}+scroll`],
        ['Move around a zoomed map', 'Space+drag'],
      ],
    },
  ];
}

/**
 * The command search's list (#65): going to each layer and place, adding each layer, the
 * ribbon's tools, the view of the map, and Help. Asked afresh each time it opens.
 */
export function commands(ed: Editor): Command[] {
  const list: Command[] = [];
  const goTo = (context: Context, item: string | null = null) => () => {
    if (ed.wizard) closeWizard(ed);
    ed.go(context, item);
  };
  for (const { id, manifest, state } of ed.instances()) {
    const name = layerButton(id, manifest, state, defaultSideOf(ed.store, id)).name;
    if (state.parent) {
      const parent = ed.store.state.layers[state.parent];
      const parentManifest = parent && ed.store.manifest(parent.layer);
      const parentName = parent && parentManifest ? layerButton(state.parent, parentManifest, parent).name : '';
      list.push({ id: `go:${id}`, label: `${manifest.name} in ${parentName}`, group: 'Go to', icon: manifest.icon, also: `open edit ${manifest.id}`, run: goTo({ kind: 'layer', id: state.parent }, id) });
    } else if (isAmbient(manifest)) {
      list.push({ id: `go:${id}`, label: `${manifest.name} at rest`, group: 'Go to', icon: manifest.icon, also: `open edit map life ${manifest.id}`, run: () => {
        if (ed.wizard) closeWizard(ed);
        ed.homeItem = id;
        ed.go({ kind: 'home' });
      } });
    } else {
      list.push({ id: `go:${id}`, label: name, group: 'Go to', icon: manifest.icon, also: `layer open edit ${manifest.name} ${manifest.id}`, run: goTo({ kind: 'layer', id }) });
    }
  }
  list.push(
    { id: 'go:home', label: AT_REST, group: 'Go to', icon: 'home', also: 'home map life', run: goTo({ kind: 'home' }) },
    { id: 'go:controller', label: 'Controller', group: 'Go to', icon: 'tv', also: 'buttons screen dashboard', run: goTo({ kind: 'controller' }) },
    { id: 'go:phone', label: 'Phones', group: 'Go to', icon: 'phone', also: 'visitors mobile', run: goTo({ kind: 'phone' }) },
  );
  // Every command of the ribbon, by the same name and with the same reason when it is greyed out (#392).
  list.push(...searchable(ed.handlers));
  for (const manifest of ed.store.manifests.filter((m) => !isAmbient(m))) {
    list.push({ id: `add:${manifest.id}`, label: `Add ${manifest.name}`, group: 'Add a layer', icon: manifest.icon, also: `new ${manifest.description ?? ''}`, run: () => {
      if (ed.wizard) closeWizard(ed);
      void addChecked(ed, manifest);
    } });
  }
  for (const manifest of ed.store.manifests.filter((m) => isAmbient(m))) {
    list.push({ id: `life:${manifest.id}`, label: `Add ${manifest.name} at rest`, group: 'Map life', icon: manifest.icon, also: 'ambient home', run: () => {
      if (ed.wizard) closeWizard(ed);
      void addChecked(ed, manifest);
    } });
  }
  for (const tab of RIBBON) list.push({ id: `tab:${tab.id}`, label: `${tab.label} tab`, group: 'Ribbon', icon: 'next', also: tab.tip, run: () => ed.setRibbonTab(tab.id) });
  for (const page of ed.helpPages ?? []) list.push({ id: `help:${page.id}`, label: page.title, group: 'Help', icon: 'info', also: `guide ${page.summary}`, run: () => openHelp(page.id) });
  return list;
}

/**
 * Report a problem (#88): a GitHub issue, filled in with the version, the system and what is
 * on the table, for the person to finish and send. Nothing leaves this computer until they do.
 */
export async function reportProblem(ed: Editor): Promise<void> {
  const invoke = shell();
  let version = '';
  try {
    version = invoke
      ? ((await invoke('presenting_state')) as { version: string }).version
      : ((await (await fetch('/help.json')).json()) as { version: string }).version;
  } catch {
    // The version is left for the person to fill in.
  }
  const layers = ed.instances()
    .filter((i) => !i.state.parent)
    .map((i) => i.manifest.id)
    .join(', ');
  const body = [
    '**What happened**',
    '',
    '',
    '**What I expected**',
    '',
    '',
    '**Steps to see it**',
    '1. ',
    '',
    '---',
    `- MR Studio: ${version || '(version)'}`,
    `- System: ${navigator.userAgent}`,
    `- Screen: ${screen.width}×${screen.height} at ${devicePixelRatio}×`,
    `- Layers: ${layers || 'none'}`,
  ].join('\n');
  const url = `https://github.com/snjsomnath/mr-studio/issues/new?labels=bug&body=${encodeURIComponent(body)}`;
  if (invoke) await invoke('open_link', { url }).catch(() => window.open(url, '_blank', 'noopener'));
  else window.open(url, '_blank', 'noopener');
}

/** Adds a layer to the table, or with `parent` into that layer as an item that comes and goes with it. */
export async function add(ed: Editor, manifest: LayerManifest, parent?: string): Promise<string | null> {
  if (parent) {
    const result = await ed.send('scene.add', { use: manifest.id, parent });
    if (result?.id) ed.added = result.id;
    ed.render();
    return result?.id ?? null;
  }
  // Ambient life belongs to the home screen, which lies under the layers: it goes above the last ambient layer, not on top.
  // A base map goes under everything, above any other base map (#368): above the map life it covers it.
  let index: number | undefined;
  if (isAmbient(manifest)) {
    const base = manifest.category === 'base';
    const tops = ed.siblings(null);
    let last = -1;
    tops.forEach((id, at) => {
      const other = ed.store.manifest(ed.store.state.layers[id]?.layer ?? '');
      if (other && (base ? other.category === 'base' : isAmbient(other))) last = at;
    });
    if (last >= 0 || base) index = last + 1;
  }
  // A new button goes on the side of the controller with fewer, so neither side stands empty.
  let button: { side: 'left' | 'right' } | undefined;
  if (!isAmbient(manifest)) {
    const count = { left: 0, right: 0 };
    for (const { id, manifest: other, state } of ed.instances()) if (!isAmbient(other) && !state.parent) count[layerButton(id, other, state, defaultSideOf(ed.store, id)).side]++;
    button = { side: count.right < count.left ? 'right' : 'left' };
  }
  const result = await ed.send('scene.add', { use: manifest.id, index, button });
  // The reply can arrive before the scene event that brings the new layer; it is selected when it does.
  if (result?.id) ed.added = result.id;
  ed.render();
  return result?.id ?? null;
}

/**
 * Adds from the ribbon, but asks first when the same kind is already in the place it would go (#183):
 * the table's layers, the map at rest, or the open layer's items.
 */
export async function addChecked(ed: Editor, manifest: LayerManifest, parent?: string): Promise<void> {
  const ambient = isAmbient(manifest);
  const same = ed.instances().find(
    (i) => i.manifest.id === manifest.id && (i.state.parent ?? undefined) === parent && (parent !== undefined || isAmbient(i.manifest) === ambient),
  );
  if (!same) return void (await add(ed, manifest, parent));
  const name = layerButton(same.id, same.manifest, same.state, defaultSideOf(ed.store, same.id));
  const parentState = parent ? ed.store.state.layers[parent] : undefined;
  const parentManifest = parentState && ed.store.manifest(parentState.layer);
  const where = parent && parentState && parentManifest ? `in ${layerButton(parent, parentManifest, parentState).name}` : ambient ? `on the map at rest` : `on this table`;
  const detail = parent
    ? `It already comes on with that layer. A second one draws on top of the first.`
    : ambient
      ? `A second one draws on top of the first.`
      : `It already has a button on the ${name.side} of the controller${name.name !== manifest.name ? `, named ${name.name}` : ''}. A second one gets a button of its own.`;
  const choice = await ask(ed, `${manifest.name} is already ${where}`, detail, [
    { id: 'show', label: 'Show the one I have' },
    { id: 'add', label: 'Add another', primary: true },
  ]);
  if (choice === 'add') return void (await add(ed, manifest, parent));
  if (choice === 'show') {
    if (parent) ed.go({ kind: 'layer', id: parent }, same.id);
    else if (ambient) {
      ed.homeItem = same.id;
      ed.go({ kind: 'home' });
    } else ed.go({ kind: 'layer', id: same.id });
  }
}
