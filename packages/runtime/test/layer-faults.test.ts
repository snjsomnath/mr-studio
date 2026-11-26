import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAULT_LIMIT, FAULT_QUIET_MS, FaultCount, noticeSlow } from '../src/layer-faults.ts';

test('a layer that throws on every frame reaches the limit; an occasional throw never does', () => {
  const faults = new FaultCount();
  // Sixty frames a second, every one of them throwing.
  let reached = -1;
  for (let frame = 0; frame < 60 && reached < 0; frame++) if (faults.thrown('wind', frame * 16)) reached = frame;
  assert.equal(reached, FAULT_LIMIT - 1);
  // A handler that fails now and then, with quiet spells between.
  const now = 10_000;
  for (let i = 0; i < 100; i++) assert.equal(faults.thrown('cars', now + i * (FAULT_QUIET_MS + 1)), false);
});

test('each instance is counted by itself, and a stopped one starts from nothing', () => {
  const faults = new FaultCount();
  for (let i = 0; i < FAULT_LIMIT - 1; i++) faults.thrown('a', i);
  assert.equal(faults.thrown('b', 0), false);
  faults.clear('a');
  assert.equal(faults.thrown('a', FAULT_LIMIT), false);
});

test('a start that takes too long is noticed once, and still finishes', async () => {
  let noticed = 0;
  const value = await noticeSlow(new Promise<string>((done) => setTimeout(() => done('started'), 40)), 10, () => noticed++);
  assert.equal(value, 'started');
  assert.equal(noticed, 1);
});

test('a start that is quick, or fails, is not called slow', async () => {
  let noticed = 0;
  assert.equal(await noticeSlow(Promise.resolve(3), 10, () => noticed++), 3);
  await assert.rejects(noticeSlow(Promise.reject(new Error('no data')), 10, () => noticed++), /no data/);
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(noticed, 0);
});
