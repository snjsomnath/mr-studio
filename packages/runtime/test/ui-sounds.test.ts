import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_VOLUME, isPress, uiVolume } from '../src/ui-sounds.ts';

const off = { active: false, values: {} } as never;
const on = { active: true, values: {} } as never;

test('a tap only for a layer a visitor turned on, not a part of it (#703)', () => {
  assert.equal(isPress(on, off), true);
  assert.equal(isPress(on, on), false, 'a change of a setting is not a press');
  assert.equal(isPress(off, on), false, 'turning off is silent');
  assert.equal(isPress(on, undefined), false, 'a layer arriving with the table is not a press');
  assert.equal(isPress({ active: true, values: {}, parent: 'slides' } as never, off), false);
});

test('the volume is display.sounds, clamped, and soft when site.json does not say (#703)', () => {
  assert.equal(uiVolume(null), DEFAULT_VOLUME);
  assert.equal(uiVolume({}), DEFAULT_VOLUME);
  assert.equal(uiVolume({ sounds: 0 }), 0);
  assert.equal(uiVolume({ sounds: 3 }), 1);
});
