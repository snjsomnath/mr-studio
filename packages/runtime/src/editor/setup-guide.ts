// The editor's side of the setup guide and the tour (#382, #540): opening and closing the guide,
// its button, and the tour. The guide itself is wizard.ts. Moved from editor.ts as functions of the
// one editor state; no change in behaviour.
import { el } from '../controls.ts';
import { icon } from './icons.ts';
import { runTour, tourOnStart } from './tour.ts';
import { Wizard } from './wizard.ts';
import { show, showController } from './canvas.ts';
import { checkRails } from './chrome.ts';
import { closeDialog } from './dialogs.ts';
import { add } from './file-keys.ts';
import type { Editor } from './editor.ts';

export function openWizard(ed: Editor, created = false, step?: number): void {
  if (ed.wizard) return;
  ed.wizard = new Wizard(
    {
      store: ed.store,
      send: (method, params) => ed.send(method, params),
      add: (manifest) => add(ed, manifest),
      show: (id) => show(ed, id),
      controller: (shown) => showController(ed, shown),
      present: () => ed.presentButton.click(),
      close: () => closeWizard(ed),
      resumeAt: (step) => (ed.resumeStep = step < 0 ? null : step),
      hold: (on) => ed.hold(on),
    },
    { created, step },
  );
  closeDialog(ed);
  ed.shell.classList.add('is-setup');
  ed.body.prepend(ed.wizard.element);
  drawGuideButton(ed);
  ed.render();
}

/**
 * The guide only starts a table (rule 9 of docs/editor-ui.md, #382): its button shows while it
 * is open, as the way out into the editor, and is gone once the table is being edited.
 */
export function drawGuideButton(ed: Editor): void {
  const open = ed.wizard !== null;
  const guide = ed.guideButton;
  guide.hidden = !open;
  guide.replaceChildren(icon('check', 16), el('span', undefined, 'Close guide'));
  guide.title = 'Leave the guide and work in the editor. Present › Ready to present? says what is left.';
}
export function closeWizard(ed: Editor): void {
  // A reload must not open the guide again once the author has left it.
  const url = new URL(location.href);
  if (url.searchParams.has('welcome') || url.searchParams.has('setup')) {
    url.searchParams.delete('welcome');
    url.searchParams.delete('setup');
    history.replaceState(history.state, '', url);
  }
  ed.wizard?.element.remove();
  ed.wizard = null;
  ed.shell.classList.remove('is-setup');
  drawGuideButton(ed);
  ed.context = { kind: 'home' };
  show(ed, null);
  ed.render();
  startTour(ed);
  // A warning held back while the guide was open (#614).
  checkRails(ed);
}

/**
 * The tour (#451) opens with the editor until the author turns it off on the tour itself.
 * Not under automation (navigator.webdriver), so end-to-end tests are not covered by it;
 * they replay it from Help.
 */
export function startTour(ed: Editor): void {
  if (!tourOnStart() || navigator.webdriver || ed.wizard) return;
  // An author who has already clicked or typed is at work: the tour does not land on top of
  // that first click (#585). Help › Tour of the editor still shows it.
  let busy = false;
  const touched = () => (busy = true);
  document.addEventListener('pointerdown', touched, { capture: true, once: true });
  document.addEventListener('keydown', touched, { capture: true, once: true });
  setTimeout(() => {
    document.removeEventListener('pointerdown', touched, { capture: true });
    document.removeEventListener('keydown', touched, { capture: true });
    if (!busy && !ed.wizard && !ed.dialog) void runTour(ed.shell, true);
  }, 600);
}
