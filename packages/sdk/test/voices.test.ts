import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VOICE_CEILING, VoiceBed, checkVoices, hearsSound, setSessionSound, voiceTargets, voiceValue } from '../src/index.ts';
import type { VoiceSpec } from '../src/index.ts';

const source = (shared: Record<string, unknown>, params: Record<string, unknown> = {}) => ({ shared, params });

test('a bound value maps its range, holds at the ends, and is silent when missing', () => {
  const bind = { bind: 'shared.import_kw', from: [0, 800] as [number, number], to: [0.1, 0.6] as [number, number] };
  assert.equal(voiceValue(bind, source({ import_kw: 400 }), 0), 0.35);
  assert.equal(voiceValue(bind, source({ import_kw: 2000 }), 0), 0.6);
  assert.equal(voiceValue(bind, source({ import_kw: -5 }), 0), 0.1);
  assert.equal(voiceValue(bind, source({}), 0), 0.1);
  assert.equal(voiceValue({ ...bind, bind: 'params.solar.kw' }, source({}, { solar: { kw: 800 } }), 0), 0.6);
  assert.equal(voiceValue({ ...bind, curve: 'square' }, source({ import_kw: 400 }), 0), 0.1 + 0.5 * 0.25);
  assert.equal(voiceValue(undefined, source({}), 0.3), 0.3);
  assert.equal(voiceValue(7, source({}), 0.3), 7);
});

test('the voices share the ceiling, so more voices are never louder, and change slowly', () => {
  const loud: VoiceSpec = { id: 'a', kind: 'noise', level: 1, centre: 99999, width: 1 };
  const one = voiceTargets([loud], source({}));
  const four = voiceTargets([loud, { ...loud, id: 'b' }, { ...loud, id: 'c' }, { ...loud, id: 'd', glide_s: 0.1 }], source({}));
  assert.equal(one[0]!.gain, VOICE_CEILING);
  assert.ok(Math.abs(four.reduce((sum, v) => sum + v.gain, 0) - VOICE_CEILING) < 1e-9);
  assert.equal(one[0]!.frequency, 8000);
  // One octave wide: Q of about 1.41.
  assert.ok(Math.abs(one[0]!.q - Math.SQRT2) < 1e-9);
  assert.equal(four[3]!.glide_s, 0.5);
  assert.equal(voiceTargets([{ id: 'h', kind: 'hum' }], source({}))[0]!.frequency, 100);
});

test('a layer\'s sound is checked: a list of up to four named voices of known kinds', () => {
  assert.deepEqual(checkVoices(undefined), []);
  assert.deepEqual(checkVoices([{ id: 'grid', kind: 'noise', level: { bind: 'shared.import_kw', from: [0, 800], to: [0, 0.6] } }]), []);
  assert.match(checkVoices({}).join(' '), /list/);
  const problems = checkVoices([
    { id: 'a', kind: 'beep' },
    { id: 'a', kind: 'hum', harmonics: 9 },
    { kind: 'tone', level: { bind: 'window.x', from: [0, 1], to: [0, 1] }, glide_s: 0.1 },
    { id: 'd', kind: 'tone' },
    { id: 'e', kind: 'tone' },
  ]);
  for (const words of [/at most 4/, /noise, hum or tone/, /two voices are called 'a'/, /harmonics/, /needs an id/, /level is a number/, /glide_s/]) assert.match(problems.join(' | '), words);
});

test('the session switch silences every sound on the table, and a bed without audio is harmless', () => {
  setSessionSound(false);
  assert.equal(hearsSound(), false);
  setSessionSound(true);
  const bed = new VoiceBed([{ id: 'grid', kind: 'noise' }], { audible: true });
  bed.update(source({ import_kw: 10 }));
  bed.audible = false;
  bed.stop();
});
