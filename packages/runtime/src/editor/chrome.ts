// The editor's frame (#540): the title bar, the status bar with its notes, the inspector's resize
// handle and the warning when layer buttons stop fitting on the controller (#614). Moved from
// editor.ts as functions of the one editor state; no change in behaviour.
import { SLOW_SHARE, TARGET_FPS } from '../perf.ts';
import { el } from '../controls.ts';
import { icon } from './icons.ts';
import { fileButton, keys as shortcut } from './file-menu.ts';
import type { RailFit } from '../rail-fit.ts';
import type { Editor } from './editor.ts';
import { shell, button, readOnly } from './editor.ts';
import { openDialog, ask } from './dialogs.ts';
import { fileAction, menuAction } from './file-keys.ts';
import { showChecks, checkBeforePresent } from './ready-checks.ts';
import { closeWizard } from './setup-guide.ts';

export function titleBar(ed: Editor): HTMLElement {
  const bar = el('header', 'ed-title');
  const invoke = shell();
  // The brand is File › Open (#130, #393): the list of tables. It checks that everything is saved first.
  const brand = el(invoke ? 'button' : 'div', 'ed-brand');
  brand.append(icon('layers', 18), el('span', undefined, 'MR Studio'));
  if (brand instanceof HTMLButtonElement) {
    brand.type = 'button';
    brand.title = 'Open another table, or start a new one (File › Open…). Everything here is already saved.';
    brand.addEventListener('click', () => void fileAction(ed, 'open'));
  }
  // In the app the File menu is native (the Mac menu bar, the editor window's menu bar on
  // Windows), so the button would repeat it (#148). A browser has no menu: it gets the button.
  const file = invoke ? null : fileButton(false, (action) => void fileAction(ed, action));
  const name = el('div', 'ed-name');
  ed.titleName.textContent = ed.store.state.site.name;
  name.append(ed.titleName, ed.saved);
  // Opened read-only from Home: the app runs a copy, so nothing done here reaches the table.
  if (readOnly()) {
    const badge = el('span', 'ed-readonly', 'Read-only');
    badge.title = 'This is a copy of the table: nothing you change here is saved to it. File › Save As… keeps the changes as a new table.';
    name.append(badge);
  }
  const steps = el('div', 'ed-steps');
  steps.append(ed.history.undoButton, ed.history.redoButton);
  // Command search, where it is seen (#65).
  const search = el('button', 'ed-search');
  search.type = 'button';
  search.title = 'Find any command, layer or setting by a few words';
  search.append(icon('search', 14), el('span', undefined, 'Search'), el('kbd', undefined, shortcut('K')));
  search.addEventListener('click', () => menuAction(ed, 'commands'));

  // The title bar holds the file, Share and Present (docs/editor-ui.md); Rehearse and the windows are on Present and View.
  const actions = el('div', 'ed-actions');
  const guide = button('ed-button is-pressed', 'Close guide', 'check');
  ed.guideButton = guide;
  guide.addEventListener('click', () => closeWizard(ed));
  actions.append(guide);
  const present = button('ed-button is-primary', 'Present', 'tv');
  present.dataset.present = '';
  ed.presentButton = present;
  // Tells the desktop shell that this page has its own Present control.
  present.dataset.shellPresent = '';
  let presenting = false;
  const draw = (): void => {
    present.replaceChildren(icon(presenting ? 'stop' : 'tv', 16), el('span', undefined, presenting ? 'Stop presenting' : 'Present'));
    present.classList.toggle('is-primary', !presenting);
    present.title = presenting
      ? 'Take the map off the projector and the controller off its screen'
      : invoke
        ? `Show the map on the projector and the controller on its screen (${shortcut('Enter')}). Ctrl+Shift+E on a full screen brings this editor back.`
        : `Open the map and the controller in two windows (${shortcut('Enter')})`;
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
      if (!(await checkBeforePresent(ed))) return;
      window.open('/table', 'mrstudio-table');
      window.open('/tv', 'mrstudio-tv');
      return;
    }
    if (!presenting && !(await checkBeforePresent(ed))) return;
    present.disabled = true;
    try {
      await invoke(presenting ? 'stop_presenting' : 'present');
      ed.saved.classList.remove('is-error');
    } catch (error) {
      ed.saved.textContent = String(error);
      ed.saved.classList.add('is-error');
    }
    present.disabled = false;
    await refresh();
  });
  draw();
  if (invoke) {
    window.addEventListener('focus', () => void refresh());
    void refresh();
  }
  if (invoke) {
    // Share by email (#372): the table as one file, attached to a new email in this
    // computer's mail app, for someone to open on another computer, such as the studio PC.
    const share = button('ed-button', 'Share', 'share');
    share.title = 'Email this table as one file. Keys stay on this computer.';
    share.addEventListener('click', () => void fileAction(ed, 'share'));
    ed.shareButton = share;
    actions.append(share);
  }
  actions.append(present);
  bar.append(brand, ...(file ? [file] : []), steps, name, search, actions);
  return bar;
}

export function statusBar(ed: Editor): HTMLElement {
  const bar = el('footer', 'ed-status');
  const connected = el('span', 'ed-connected', 'Connected to the table');
  // Losing the table is said plainly, and edits wait until it is back (#68). The page reconnects by itself.
  const lost = el('div', 'ed-offline');
  lost.setAttribute('role', 'alert');
  lost.hidden = true;
  const lostText = el('div');
  lostText.append(el('strong', undefined, 'Lost connection to the table. Reconnecting…'), el('span', undefined, 'Changes wait until it is back. Nothing you made so far is lost.'));
  const spinner = el('span', 'ed-spinner');
  lost.append(spinner, lostText);
  ed.shell.append(lost);
  let since = 0;
  ed.connection.on('disconnected', () => {
    connected.textContent = 'Reconnecting…';
    connected.classList.add('is-off');
    since = performance.now();
    // A blink is not worth a banner.
    window.setTimeout(() => {
      if (connected.classList.contains('is-off') && performance.now() - since >= 700) {
        lost.hidden = false;
        ed.shell.classList.add('is-offline');
      }
    }, 800);
  });
  ed.connection.on('welcome', () => {
    connected.textContent = 'Connected to the table';
    connected.classList.remove('is-off');
    lost.hidden = true;
    ed.shell.classList.remove('is-offline');
  });
  // The engine working something out (a simulation settling, shadows for a new moment): a line in the status bar (#68).
  const work = el('span', 'ed-work');
  work.hidden = true;
  const streams = new Map<number, { progress: number; at: number }>();
  const drawWork = (): void => {
    const now = performance.now();
    for (const [id, s] of streams) if (now - s.at > 3000) streams.delete(id);
    work.hidden = streams.size === 0;
    if (work.hidden) return;
    const least = Math.min(...[...streams.values()].map((s) => s.progress));
    const bar = el('span', 'ed-work-bar');
    const fill = el('span');
    fill.style.width = `${Math.max(2, least * 100)}%`;
    bar.append(fill);
    work.replaceChildren(el('span', 'ed-spinner'), el('span', undefined, `The engine is working out the preview · ${Math.floor(least * 100)} %`), bar);
    work.title = 'A simulation is settling or a new moment is being worked out. The map fills in as it goes.';
  };
  ed.connection.on('engine.status', (p: { stream: number; state: string; progress: number; info?: { settled?: boolean } }) => {
    const finished = p.state !== 'running' || p.info?.settled === true || p.progress >= 0.999;
    if (finished) streams.delete(p.stream);
    else streams.set(p.stream, { progress: p.progress, at: performance.now() });
    drawWork();
  });
  window.setInterval(drawWork, 1500);
  ed.connection.on('disconnected', () => {
    streams.clear();
    drawWork();
  });
  const { width_m, height_m } = ed.store.state.site.extent;
  // What only the operator needs to know lives here, never on the visitors' controller (#713):
  // quiet icons, plain words on hover, and a Fix button that opens the right setting when something is wrong.
  // Adapter names and backends stay in Help › Copy diagnostics.
  const host = shell();
  const phones = el('span', 'ed-phones');
  const showPhones = (): void => {
    const { join_url: url, code } = ed.store.state.session;
    const label = el('span', undefined, url ? `Phones: ${code}` : 'Phones off');
    phones.replaceChildren(icon('phone'), label);
    phones.title = url
      ? `Visitors join at ${url} with the code ${code}`
      : host
        ? 'Phones on this network cannot join yet. Fix opens the setting that lets them.'
        : 'Phones on this network cannot join yet. Start with --lan from the command line to let them.';
    phones.classList.toggle('is-off', !url);
    if (!url && host) {
      const fix = el('button', 'ed-fix', 'Fix');
      fix.type = 'button';
      fix.title = 'Open File › Settings › Phones and startup';
      fix.addEventListener('click', () => void host('open_settings', { page: 'startup' }));
      phones.append(fix);
    }
  };
  showPhones();
  ed.store.onParticipants(showPhones);
  const engine = el('span', 'ed-engine');
  void ed.connection
    .request<{ backend: string; adapter: string | null }>('engine.info')
    .then((info) => {
      const gpu = Boolean(info.adapter) && !/llvmpipe|swiftshader|software|microsoft basic/i.test(info.adapter ?? '');
      engine.replaceChildren(icon(gpu ? 'chip' : 'clock'), el('span', undefined, gpu ? 'Fast simulations' : 'Slower simulations'));
      engine.classList.toggle('is-off', !gpu);
      engine.title = gpu
        ? 'Simulations run on the graphics card. Help › Copy diagnostics names it.'
        : 'No graphics card the simulations can use was found, so they run on the processor and take longer. Visitors are not told. Help › Copy diagnostics has the details.';
    })
    .catch(() => {});
  ed.checksButton.type = 'button';
  ed.checksButton.addEventListener('click', () => showChecks(ed));
  bar.append(slowTable(ed), el(
      'span',
      readOnly() ? 'ed-readonly-note' : undefined,
      readOnly()
        ? 'Read-only copy: changes are not kept. File › Save As… keeps them as a new table.'
        : shell()
          ? 'Changes are saved as you make them. File > Save As makes a copy.'
          : 'Changes are saved as you make them',
    ), el('span', 'ed-grow'), work, railFit(ed), ed.checksButton, phones, engine, connected, el('span', undefined, `${Math.round(width_m)} × ${Math.round(height_m)} m`));
  return bar;
}

/**
 * A warning in the status bar while the table draws below 90 % of 60 frames a second (#262):
 * how fast it draws, the layer whose own code costs most, and what to try. It asks the host
 * every 5 s; the table and controller say how they are doing every 2 s.
 */
export function slowTable(ed: Editor): HTMLElement {
  const note = el('button', 'ed-slow');
  note.type = 'button';
  note.hidden = true;
  note.addEventListener('click', () => openDialog(ed, 'screens'));
  let slowFor = 0;
  const check = async () => {
    const report = (await fetch('/api/performance', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as { windows: { role: string; age: number; fps: number; budget: { layers: { id: string; ms: number }[] } }[] } | null;
    const table = report?.windows.filter((w) => w.role === 'table' && w.age < 10).sort((a, b) => a.fps - b.fps)[0];
    // Slow on two checks in a row, so a moment of loading does not raise it.
    slowFor = table && table.fps < TARGET_FPS * SLOW_SHARE ? slowFor + 1 : 0;
    note.hidden = slowFor < 2;
    if (note.hidden || !table) return;
    const worst = table.budget.layers[0];
    const layer = worst ? ed.store.state.layers[worst.id] : undefined;
    const name = worst ? (ed.store.manifests.find((m) => m.id === layer?.layer)?.name ?? worst.id) : null;
    note.textContent = `The table draws ${Math.round(table.fps)} frames a second`;
    note.title =
      `It should draw ${TARGET_FPS}.` +
      (name && worst && worst.ms >= 1 ? ` ${name} costs most, ${worst.ms.toFixed(1)} ms a frame: try a lower Quality on the Display tab, or turn ${name} off.` : ' Try a lower Quality on the Display tab.') +
      ' Help > Show frame meter shows what each layer costs.';
  };
  window.setInterval(() => void check(), 5000);
  return note;
}

/**
 * The inspector's left edge drags it wider or narrower (#639), from 260 px to just under half
 * the window. The width is remembered on this computer, never saved in the table; a double
 * click puts it back.
 */
export function inspectorResize(ed: Editor): HTMLElement {
  const key = 'mrs-inspector-width';
  const grip = el('div', 'ed-inspector-resize');
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.ariaLabel = 'Resize the settings panel';
  grip.title = 'Drag to make the settings panel wider or narrower. Double-click puts it back.';
  grip.tabIndex = 0;
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, 260), Math.max(260, window.innerWidth * 0.45)));
  const set = (w: number | null, keep = true) => {
    if (w === null) ed.shell.style.removeProperty('--ed-inspector-w');
    else ed.shell.style.setProperty('--ed-inspector-w', `${clamp(w)}px`);
    if (!keep) return;
    try {
      if (w === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(clamp(w)));
    } catch {
      // No storage: the width lasts until the editor closes.
    }
  };
  try {
    const saved = Number(localStorage.getItem(key));
    if (saved > 0) set(saved, false);
  } catch {
    // Default width.
  }
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = event.clientX;
    const width = ed.inspector.getBoundingClientRect().width;
    grip.setPointerCapture(event.pointerId);
    ed.shell.classList.add('is-resizing');
    const move = (e: PointerEvent) => set(width - (e.clientX - start), false);
    const up = (e: PointerEvent) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      ed.shell.classList.remove('is-resizing');
      set(width - (e.clientX - start));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => set(null));
  // The keyboard: left makes it wider, right narrower.
  grip.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 64 : 16;
    const width = ed.inspector.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') set(width + step);
    else if (event.key === 'ArrowRight') set(width - step);
    else return;
    event.preventDefault();
  });
  return grip;
}

/** The status bar's note while layer buttons do not fit on the controller (#614). */
export function railFit(ed: Editor): HTMLElement {
  const note = ed.railNote;
  note.type = 'button';
  note.hidden = true;
  note.addEventListener('click', () => void warnRails(ed));
  return note;
}

/** The sides of the controller with buttons out of sight. */
export function overflowing(ed: Editor): RailFit[] {
  return (['left', 'right'] as const).map((side) => ed.railFits[side]).filter((r): r is RailFit => Boolean(r && r.buttons > r.fits));
}

/** Updates the status bar, and warns once when buttons stop fitting or more of them do not fit. */
export function checkRails(ed: Editor): void {
  const sides = overflowing(ed);
  const out = sides.reduce((n, r) => n + r.buttons - r.fits, 0);
  const legends = [...ed.legendScrolls].filter(([layer]) => Boolean(ed.store.state.layers[layer]));
  const spills = [...ed.panelSpills.values()].flat();
  ed.railNote.hidden = out === 0 && legends.length === 0 && spills.length === 0;
  if (out > 0) {
    ed.railNote.replaceChildren(icon('alert', 12), el('span', undefined, out === 1 ? '1 button does not fit on the controller' : `${out} buttons do not fit on the controller`));
    ed.railNote.title = 'Visitors have to scroll a side of the controller to find them. Click for more.';
  } else if (legends.length > 0) {
    // A legend that does not fit (#660): the fix is the layer's Legend setting, under its button.
    const [layer, mode] = legends[0]!;
    const name = ed.store.state.layers[layer]?.button?.name ?? layer;
    ed.railNote.replaceChildren(icon('alert', 12), el('span', undefined, `${name}'s legend does not fit on the controller`));
    ed.railNote.title =
      mode === 'full'
        ? 'Visitors have to scroll to see all of it. Set its Legend to Auto or Compact under the layer button, or turn it off.'
        : 'Even with small swatches visitors have to scroll. Turn the legend off under the layer button, or show fewer rows.';
  } else if (spills.length > 0) {
    // A panel whose content spills out of its box (#681): what spills is cut off on the TV.
    ed.railNote.replaceChildren(icon('alert', 12), el('span', undefined, spills.length === 1 ? 'A panel does not fit on the controller' : `${spills.length} panels do not fit on the controller`));
    ed.railNote.title = `Part of ${spills.map((s) => `'${s.key}'`).join(', ')} is cut off on the screen. Give it a bigger size, shorter words or fewer items.`;
  }
  if (out === 0) ed.railWarned = 0;
  // Not over the setup guide or another dialog: the status bar keeps it until then.
  if (out <= ed.railWarned) return;
  if (ed.wizard || ed.dialog || document.querySelector('dialog[open]')) {
    window.clearTimeout(ed.railRetry);
    ed.railRetry = window.setTimeout(() => checkRails(ed), 1000);
    return;
  }
  ed.railWarned = out;
  void warnRails(ed);
}

/** The warning: which side, how many fit, which buttons are out of sight, and the way to fix it. */
export async function warnRails(ed: Editor): Promise<void> {
  const sides = overflowing(ed);
  if (sides.length === 0 || document.querySelector('dialog.ed-rail-warning')) return;
  const words = (r: RailFit): string => {
    const names = r.hidden.filter(Boolean);
    const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    return `The ${r.side} side has room for ${r.fits} ${r.fits === 1 ? 'button' : 'buttons'} and has ${r.buttons}${list ? `, so ${list} ${names.length === 1 ? 'is' : 'are'} out of sight` : ''}.`;
  };
  const out = sides.reduce((n, r) => n + r.buttons - r.fits, 0);
  const choice = await ask(ed, 
    out === 1 ? 'A layer button does not fit on the controller' : `${out} layer buttons do not fit on the controller`,
    `${sides.map(words).join(' ')} Visitors have to scroll the side to find ${out === 1 ? 'it' : 'them'}. Move buttons to the other side, put some in a group, or hide the ones visitors need least.`,
    [
      { id: 'keep', label: 'Keep it' },
      { id: 'arrange', label: 'Arrange the buttons', primary: true },
    ],
    'ed-rail-warning',
  );
  if (choice === 'arrange') {
    if (ed.wizard) closeWizard(ed);
    ed.go({ kind: 'controller' });
  }
}
