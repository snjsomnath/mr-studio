// The editor's checks before presenting (#540): what is not ready yet, a fix for each, and the
// question before Present. Moved from editor.ts as functions of the one editor state; no change in
// behaviour.
import { readiness } from '@mrstudio/sdk';
import type { ReadyCheck } from '@mrstudio/sdk';
import { defaultSideOf, el, isAmbient, layerButton } from '../controls.ts';
import { targetFor } from './importer.ts';
import { ask, openDialog } from './dialogs.ts';
import type { Editor } from './editor.ts';
import { shell } from './editor.ts';
import { addData, bringIn, gallery } from './adding.ts';
import { closeWizard } from './setup-guide.ts';

/** The table as the shared readiness rules see it (#63). */
export function readyChecks(ed: Editor): ReadyCheck[] {
  const site = ed.store.state.site;
  const defaultSide = defaultSideOf(ed.store, '');
  return readiness({
    data: Object.keys(site.data ?? {}),
    size: Boolean(site.table?.width_cm),
    timezone: site.timezone,
    calibrated: shell() ? Boolean(site.calibration) || ed.projectorCalibrated : null,
    welcome: site.branding.welcome,
    layers: ed.instances().map(({ id, manifest, state }) => {
      const b = layerButton(id, manifest, state, defaultSideOf(ed.store, id) ?? defaultSide);
      return { id, name: b.name, ambient: isAmbient(manifest), parent: state.parent ?? null, hidden: Boolean(state.button?.hidden), side: b.side, needs: manifest.requires?.data ?? [], noWords: !b.description };
    }),
  });
}

/** Takes the person to where a check is fixed. */
export function fixCheck(ed: Editor, check: ReadyCheck): void {
  document.querySelector('.ed-checks-list')?.remove();
  const { fix } = check;
  if (fix.kind === 'data') {
    const target = targetFor(fix.dataset)?.target;
    if (target) bringIn(ed, target);
    else addData(ed);
  } else if (fix.kind === 'guide') {
    // Each fix goes to the one home of what it asks for (#382), never back into the guide.
    if (ed.wizard) closeWizard(ed);
    if (fix.step === 'place') {
      if (check.id === 'table:size') openDialog(ed, 'place');
      else bringIn(ed, 'buildings');
    } else if (fix.step === 'rest') ed.go({ kind: 'home' });
    else gallery(ed);
  } else if (fix.kind === 'table') openDialog(ed, check.id === 'table:welcome' ? 'welcome' : 'place');
  else if (fix.kind === 'controller') {
    if (ed.wizard) closeWizard(ed);
    ed.go({ kind: fix.kind });
  } else if (fix.kind === 'layer') {
    if (ed.wizard) closeWizard(ed);
    ed.go({ kind: 'layer', id: fix.id });
  } else if (fix.kind === 'calibrate') openDialog(ed, 'screens');
}

/** The list behind the Checks button: Must fix, Should fix, Nice to have, each with its fix. */
export function showChecks(ed: Editor, anchor: HTMLElement = ed.checksButton): void {
  const open = document.querySelector('.ed-checks-list');
  open?.remove();
  if (open && anchor === ed.checksButton) return;
  const panel = el('div', 'ed-checks-list');
  panel.setAttribute('role', 'dialog');
  panel.ariaLabel = 'Ready to present?';
  const head = el('header');
  const close = el('button', 'ed-icon-button', '\u00d7');
  close.type = 'button';
  close.ariaLabel = 'Close';
  close.addEventListener('click', () => panel.remove());
  head.append(el('strong', undefined, 'Ready to present?'), close);
  panel.append(head);
  const checks = readyChecks(ed);
  if (checks.length === 0) panel.append(el('p', 'ed-empty', 'Everything is in place. Present when you are ready.'));
  const names: Record<string, string> = { must: 'Must fix: the table will not work without it', should: 'Should fix: it works, but looks wrong', nice: 'Nice to have' };
  for (const level of ['must', 'should', 'nice'] as const) {
    const these = checks.filter((c) => c.level === level);
    if (these.length === 0) continue;
    const section = el('section', `is-${level}`);
    section.append(el('h4', undefined, names[level]!));
    for (const check of these) {
      const row = el('div', 'ed-check');
      row.dataset.check = check.id;
      const fix = el('button', 'ed-button', check.action);
      fix.type = 'button';
      fix.addEventListener('click', () => fixCheck(ed, check));
      row.append(el('span', undefined, check.text), fix);
      section.append(row);
    }
    panel.append(section);
  }
  const outside = (event: PointerEvent): void => {
    if (!panel.isConnected) return document.removeEventListener('pointerdown', outside, true);
    if (!panel.contains(event.target as Node) && !ed.checksButton.contains(event.target as Node)) {
      panel.remove();
      document.removeEventListener('pointerdown', outside, true);
    }
  };
  document.addEventListener('pointerdown', outside, true);
  panel.addEventListener('keydown', (event) => event.key === 'Escape' && panel.remove());
  ed.shell.append(panel);
}

/**
 * Before presenting (#63): when something must or should be fixed, a question says what, with
 * Present anyway. Resolves true to go on.
 */
export async function checkBeforePresent(ed: Editor): Promise<boolean> {
  const checks = readyChecks(ed).filter((c) => c.level !== 'nice');
  if (checks.length === 0) return true;
  const list = checks.slice(0, 4).map((c) => `• ${c.text}`).join('\n') + (checks.length > 4 ? `\n• and ${checks.length - 4} more` : '');
  const choice = await ask(ed, 
    checks.length === 1 ? '1 thing to check before presenting' : `${checks.length} things to check before presenting`,
    list,
    [
      { id: 'show', label: 'Show me' },
      { id: 'present', label: 'Present anyway', primary: !checks.some((c) => c.level === 'must') },
    ],
  );
  if (choice === 'show') showChecks(ed);
  return choice === 'present';
}
