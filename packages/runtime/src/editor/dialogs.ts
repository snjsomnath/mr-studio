// The editor's dialogs (#540): the whole-table and this-computer settings dialogs (rule 5 of
// docs/editor-ui.md), the phone preview switch and the small question dialog. Moved from editor.ts
// as functions of the one editor state; no change in behaviour.
import { el } from '../controls.ts';
import { ModelImporter } from './model-import.ts';
import { columns, ribbonGroup } from './ribbon-layout.ts';
import { FetchAll } from './fetch-all.ts';
import { placeSettings, welcomeSettings } from './table-settings.ts';
import { pagesEditor } from './pages-editor.ts';
import { WHERE, Wizard } from './wizard.ts';
import { drawPhone } from './canvas.ts';
import { renderRibbon } from './ribbon-commands.ts';
import { Editor } from './editor.ts';
import { button, type DialogId } from './editor.ts';
import { add } from './file-keys.ts';
import { bringIn } from './adding.ts';

/**
 * Opens one of the dialogs, over the editor as it is; closing it comes back to where the
 * author was. `again` draws an open one afresh, when its settings changed elsewhere.
 */
export function openDialog(ed: Editor, id: DialogId, again = false): void {
  if (ed.dialog?.id === id && !again) {
    ed.dialog.element.focus();
    return;
  }
  if (ed.dialog && ed.dialog.id !== id) closeDialog(ed);
  const spec = Editor.DIALOGS[id];
  const reuse = ed.dialog?.id === id ? ed.dialog.element : null;
  const dialog = reuse ?? el('dialog', `ed-dialog is-${id}`);
  dialog.ariaLabel = spec.title;
  const head = el('header', 'ed-dialog-head');
  const close = el('button', 'ed-icon-button', '\u00d7');
  close.type = 'button';
  close.ariaLabel = 'Close';
  close.addEventListener('click', () => closeDialog(ed));
  const words = el('div');
  words.append(el('h2', undefined, spec.title), el('p', 'wz-lead', spec.lead));
  head.append(words, close);
  const body = el('div', 'ed-dialog-body');
  body.dataset.home = `dialog:${id}`;
  if (id === 'place') {
    body.append(placeForm(ed).element, ...placeSettings({ store: ed.store, send: (method, params) => ed.send(method, params) }));
    placeForm(ed).setShown(true);
  } else if (id === 'welcome') {
    body.append(...welcomeSettings({ store: ed.store, send: (method, params) => ed.send(method, params) }));
  } else if (id === 'pages') {
    body.append(pagesEditor({ store: ed.store, send: (method, params) => ed.send(method, params) }));
  } else if (id === 'screens') {
    const strip = el('div', 'ed-ribbon ed-dialog-ribbon');
    strip.append(...ed.displayTab.groups);
    body.append(strip);
    void ed.displayTab.show();
  } else if (id === 'model') {
    // Insert › 3D model opens the model importer itself, not the media library (#459).
    ed.modelImporter ??= new ModelImporter({ site: () => ed.store.state.site });
    ed.modelImporter.render();
    body.append(ed.modelImporter.element);
  } else if (id === 'media') {
    body.append(el('div', 'ed-dialog-ribbon ed-ribbon'), ed.mediaTab.view, el('aside', 'ed-inspector ed-media-inspector'));
    void ed.mediaTab.load();
  } else {
    ed.fetchAll ??= new FetchAll({ site: () => ed.store.state.site, hold: (on) => ed.hold(on) });
    ed.fetchAll.render();
    body.append(ed.fetchAll.element);
  }
  dialog.replaceChildren(head, body);
  ed.dialog = { id, element: dialog };
  if (id === 'media') drawMedia(ed);
  if (reuse) return;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog(ed);
  });
  ed.shell.append(dialog);
  if (spec.modal) dialog.showModal();
  else {
    // Under the ribbon, over the top of the map, which stays in view for the colour preview.
    dialog.style.top = `${Math.round(ed.ribbon.getBoundingClientRect().bottom) + 6}px`;
    dialog.show();
  }
}

export function closeDialog(ed: Editor): void {
  const open = ed.dialog;
  if (!open) return;
  ed.dialog = null;
  if (open.id === 'screens') ed.displayTab.hide();
  if (open.id === 'place') ed.placePanel?.setShown(false);
  open.element.close();
  open.element.remove();
  renderRibbon(ed, ed.instances());
}

/** The media library's tools, list and the selected file, drawn again as they change. */
export function drawMedia(ed: Editor): void {
  const box = ed.dialog?.id === 'media' ? ed.dialog.element : null;
  if (!box) return;
  const tool = (label: string, iconName: string, large = false) => button(large ? 'ed-tool is-large' : 'ed-tool', label, iconName, large ? 20 : 16);
  box.querySelector('.ed-dialog-ribbon')?.replaceChildren(...ed.mediaTab.ribbon(tool, ribbonGroup, columns));
  box.querySelector('.ed-media-inspector')?.replaceChildren(...ed.mediaTab.inspector());
  ed.mediaTab.drawView();
}

/** Table size and place: the guide's first step on its own (rule 9), made once. */
export function placeForm(ed: Editor): Wizard {
  ed.placePanel ??= new Wizard(
    {
      store: ed.store,
      send: (method, params) => ed.send(method, params),
      add: (manifest) => add(ed, manifest),
      // The dialog has its own map of the place; the table's map stays as it is.
      show: () => {},
      controller: () => {},
      present: () => ed.presentButton.click(),
      close: () => closeDialog(ed),
      resumeAt: () => {},
      hold: (on) => ed.hold(on),
      bringIn: (target) => bringIn(ed, target),
    },
    { step: WHERE, panel: true },
  );
  return ed.placePanel;
}

export function setPhone(ed: Editor, on: boolean): void {
  ed.phoneShown = on;
  try {
    if (on) localStorage.setItem('mrs-phone-preview', '1');
    else localStorage.removeItem('mrs-phone-preview');
  } catch {
    // As above.
  }
  drawPhone(ed);
  renderRibbon(ed, ed.instances());
}
/** A small question in a dialog. Resolves to the chosen id, or null when it is closed with Escape or ×. */
export function ask(ed: Editor, title: string, text: string, choices: { id: string; label: string; primary?: boolean }[], kind?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = el('dialog', `im-dialog ed-ask${kind ? ` ${kind}` : ''}`);
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
    ed.shell.append(dialog);
    dialog.showModal();
    actions.querySelector<HTMLElement>('.is-primary')?.focus();
  });
}
