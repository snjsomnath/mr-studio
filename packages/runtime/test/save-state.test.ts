// The editor's saved, saving and problem states (#68, #575), tested apart from the editor (#540).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SLOW_SAVE_MS, SaveState, savedWords, savingWords } from '../src/editor/save-state.ts';
import type { SaveWords } from '../src/editor/save-state.ts';

const after = (ms: number) => new Promise((r) => setTimeout(r, ms));

function state(readOnly = false) {
  const drawn: SaveWords[] = [];
  return { drawn, save: new SaveState((w) => drawn.push(w), () => readOnly, () => '14:05') };
}

test('a quick answer says Saved with the time, and never Saving…', async () => {
  const { drawn, save } = state();
  assert.equal(await save.send(async () => 42), 42);
  assert.deepEqual(drawn.map((w) => w.text), ['Saved 14:05']);
  assert.equal(save.pending, 0);
  assert.equal(save.problem, null);
});

test('a slow answer says Saving… first, then Saved', async () => {
  const { drawn, save } = state();
  const sent = save.send(() => after(SLOW_SAVE_MS + 100).then(() => 'ok'));
  await after(SLOW_SAVE_MS + 30);
  assert.equal(save.pending, 1);
  assert.deepEqual(drawn.at(-1), savingWords());
  assert.equal(await sent, 'ok');
  assert.equal(drawn.at(-1)!.text, 'Saved 14:05');
});

test('a refused change answers null, says why and keeps it until a change is saved', async () => {
  const { drawn, save } = state();
  assert.equal(await save.send(() => Promise.reject(new Error('the layer is gone'))), null);
  assert.deepEqual(drawn.at(-1), { text: 'the layer is gone', title: 'This change could not be saved. Click for the history.', icon: 'alert', error: true });
  assert.equal(save.problem, 'the layer is gone');
  await save.send(async () => true);
  assert.equal(save.problem, null);
  assert.equal(drawn.at(-1)!.error, false);
});

test('a read-only copy never says Saved (#575)', () => {
  const words = savedWords('09:30', true);
  assert.equal(words.text, 'Kept in the copy 09:30');
  assert.match(words.title, /read-only copy/);
  assert.equal(savedWords('09:30', false).text, 'Saved 09:30');
});

test('settled waits for every change on its way', async () => {
  const { save } = state();
  let done = false;
  void save.send(() => after(120).then(() => (done = true)));
  await save.settled();
  assert.equal(done, true);
  assert.equal(save.pending, 0);
});
