import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PeakFinder, SoundSchedule, SoundStage, SOUND_DEFAULTS, analyseSound, compileLook, profileAt, resolvePalette, soundColumns, soundPath } from '../src/index.ts';
import type { Pen, Shapes, View } from '../src/index.ts';

/** Two chirps (high) and a hum (low) with silence between, at 8 kHz. */
function birdish(rate = 8000): Float32Array {
  const out = new Float32Array(rate * 2);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    if ((t > 0.2 && t < 0.35) || (t > 0.8 && t < 0.95)) out[i] = 0.9 * Math.sin(2 * Math.PI * 3000 * t);
    else if (t > 1.4 && t < 1.8) out[i] = 0.3 * Math.sin(2 * Math.PI * 150 * t);
  }
  return out;
}

test('a sound is reduced to loudness and brightness', () => {
  const profile = analyseSound(birdish(), 8000);
  assert.equal(profile.duration, 2);
  assert.equal(profileAt(profile, 0.1).loudness, 0, 'silence');
  assert.ok(profileAt(profile, 0.25).loudness > 0.95, 'the chirp is the loudest');
  assert.ok(profileAt(profile, 0.25).brightness > 0.4, 'a chirp is bright');
  assert.ok(profileAt(profile, 1.6).brightness < 0.1, 'a hum is dull');
  assert.deepEqual(profileAt(profile, 5), { loudness: 0, brightness: 0 });
});

test('calls are found where the loudness rises, not while it holds', () => {
  const profile = analyseSound(birdish(), 8000);
  const finder = new PeakFinder(0.5);
  const calls: number[] = [];
  for (let t = 0; t < 2; t += 0.02) if (finder.push(profileAt(profile, t).loudness, t, 0.02)) calls.push(Math.round(t * 100) / 100);
  assert.equal(calls.length, 3, `two chirps and the hum: ${calls}`);
  assert.ok(calls[0]! >= 0.2 && calls[0]! < 0.26);
});

test('a chorus keeps to its voices and does not repeat a point', () => {
  const schedule = new SoundSchedule(1);
  const playing = new Set<number>();
  const picks: number[] = [];
  for (let t = 0; t < 30; t += 0.1) {
    for (const p of schedule.starts({ trigger: 'chorus', voices: 2, gap_s: 1 }, [0, 1, 2, 3], playing, t, false)) {
      picks.push(p);
      playing.add(p);
    }
    if (playing.size > 2) assert.fail('more voices than asked for');
  }
  assert.equal(playing.size, 2);
  assert.deepEqual(new SoundSchedule().starts({ trigger: 'loop', voices: 1, gap_s: 0 }, [0, 1, 2], new Set([1]), 0, false), [0, 2], 'a loop plays every point');
});

test('sound paths come from a column or one file, and stay in the site', () => {
  assert.equal(soundPath({ sound: 'blackbird.mp3' }, { column: 'sound', file: null }), 'data/sounds/blackbird.mp3');
  assert.equal(soundPath({ sound: 'audio/x.wav' }, { column: 'sound', file: null }), 'audio/x.wav');
  assert.equal(soundPath({ sound: '../secret.wav' }, { column: 'sound', file: null }), null);
  assert.equal(soundPath({ sound: 'https://x/y.mp3' }, { column: 'sound', file: null }), null);
  assert.equal(soundPath({}, { column: null, file: 'wind.ogg' }), 'data/sounds/wind.ogg');
  assert.deepEqual(soundColumns([{ name: 'a', sound: 'a.mp3' }, { name: 'b', sound: '' }]), ['sound']);
});

test('points with sounds send out rings while they play', () => {
  let arcs = 0;
  const pen = new Proxy({}, { get: (_, key) => (key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : key === 'arc' ? () => arcs++ : () => {}), set: () => true }) as unknown as Pen;
  const view: View = { pen, scale: 2, time: 0, detail: 1, toPx: ([x, y]) => [x * 2, y * 2] };
  const shapes: Shapes = { areas: [], paths: [], spots: [{ id: 1, point: [10, 10], properties: { sound: 'bird.wav' } }, { id: 2, point: [50, 10], properties: {} }] };
  const stage = new SoundStage({ audible: false });
  stage.setProfile('data/sounds/bird.wav', analyseSound(birdish(), 8000));
  const look = compileLook({ id: 'p', block: 'points' }, shapes, resolvePalette(), 0.5, { sound: { ...SOUND_DEFAULTS, column: 'sound', stage } })!;
  for (let t = 0; t < 2; t += 1 / 60) look.draw(view, t, 1);
  assert.deepEqual(stage.playing(), [0], 'only the point with a sound plays');
  assert.ok(arcs > 300, 'rings and glow were drawn');
});
