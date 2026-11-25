// The editor's layout as data (#392): every command the layout names is declared, and every
// setting is edited only in its one home (rule 1 of docs/editor-ui.md, the task audit of #384).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { COMMANDS } from '../src/editor/commands-list.ts';
import { RIBBON, commandOf } from '../src/editor/layout.ts';
import { SETTINGS } from '../src/editor/settings-list.ts';

const EDITOR = new URL('../src/editor/', import.meta.url);
const sources = readdirSync(EDITOR)
  .filter((f) => f.endsWith('.ts') && f !== 'settings-list.ts')
  .map((f) => ({ file: f, text: readFileSync(new URL(f, EDITOR), 'utf8') }));

/** Every `setting('id', 'home', …)` call in the editor's code. */
const placements = sources.flatMap(({ file, text }) => [...text.matchAll(/\bsetting\(\s*'([^']+)'\s*,\s*'([^']+)'/g)].map((m) => ({ file, id: m[1]!, home: m[2]! })));

test('the ribbon has the agreed PowerPoint tabs, in order (#382)', () => {
  assert.deepEqual(
    RIBBON.map((t) => t.label),
    ['Home', 'Insert', 'Design', 'Present', 'View', 'Help'],
  );
});

test('every command the layout names is declared, with a name, an icon and help text', () => {
  for (const tab of RIBBON) {
    for (const group of tab.groups) {
      assert.ok(group.items.length > 0, `${tab.label} › ${group.name} has something in it`);
      for (const item of group.items) {
        const id = commandOf(item);
        if (!id) continue;
        const info = COMMANDS[id];
        assert.ok(info, `${tab.label} › ${group.name} names ${id}, which commands-list.ts declares`);
        assert.ok(info.label && info.icon && info.tip.length > 10, `${id} has a name, an icon and a tooltip`);
      }
    }
  }
});

test('a command that opens a dialog says so with …, and only those do', () => {
  for (const [id, info] of Object.entries(COMMANDS)) assert.equal(info.label.endsWith('…'), id.startsWith('dialog.'), id);
});

test('tabs hold commands, never fields: no setting is placed on the ribbon but the Design galleries', () => {
  for (const { id, home } of placements) if (home.startsWith('ribbon:')) assert.equal(home, 'ribbon:design', id);
});

test('every setting is declared and edited in its one home only (rule 1)', () => {
  for (const { file, id, home } of placements) {
    const info = (SETTINGS as Record<string, { home: string }>)[id];
    assert.ok(info, `${file} edits ${id}, which settings-list.ts declares`);
    assert.equal(home, info.home, `${file} edits ${id} in ${home}, but its home is ${info.home}`);
  }
});

test('every declared setting has a place where it is edited', () => {
  const placed = new Set(placements.map((p) => p.id));
  // Settings at home in the app's Settings window (#393) are edited outside the editor, in apps/studio/ui.
  for (const [id, info] of Object.entries(SETTINGS)) if (info.home !== 'app:settings') assert.ok(placed.has(id), `${id} is edited somewhere`);
});

test('the old setup tabs and the Table settings panel are gone (#382)', () => {
  const editor = sources.find((s) => s.file === 'editor.ts')!.text;
  assert.doesNotMatch(editor, /renderSetupRibbon|kind: 'table'|tableSettings\(/);
});
