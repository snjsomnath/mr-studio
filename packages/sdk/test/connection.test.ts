import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Connection } from '../src/connection.ts';

/** A socket the test plays the host on. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  binaryType = '';
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** The host says something. */
  say(message: object | string): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
}

async function connected(): Promise<{ connection: Connection; socket: FakeSocket }> {
  (globalThis as any).WebSocket = FakeSocket;
  const connection = new Connection({ url: 'ws://host/ws', role: 'table' });
  const welcome = connection.connect();
  await Promise.resolve();
  FakeSocket.last.say({ t: 'welcome', surface: 1, state: {}, manifests: [] });
  await welcome;
  return { connection, socket: FakeSocket.last };
}

/** Runs `run` with the console quiet, and returns what it would have printed as errors. */
async function quietly(run: () => void | Promise<void>): Promise<unknown[][]> {
  const printed: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void printed.push(args);
  try {
    await run();
  } finally {
    console.error = error;
  }
  return printed;
}

test('a listener that throws does not keep the event from the others, and the host hears of it', async () => {
  const { connection, socket } = await connected();
  const heard: string[] = [];
  connection.on('state.layer', () => heard.push('first'));
  connection.on('state.layer', () => {
    throw new Error('a layer made a mistake');
  });
  connection.on('state.layer', () => heard.push('third'));
  const printed = await quietly(() => socket.say({ t: 'ev', m: 'state.layer', p: {} }));
  assert.deepEqual(heard, ['first', 'third']);
  assert.equal(printed.length, 1);
  const report = socket.sent.find((m) => m.t === 'error');
  assert.match(report.message, /state\.layer.*a layer made a mistake/);
  connection.close();
});

test('a message that cannot be read is dropped, and the next one is handled', async () => {
  const { connection, socket } = await connected();
  let heard = 0;
  connection.on('ping', () => heard++);
  const printed = await quietly(() => socket.say('{ not json'));
  assert.equal(printed.length, 1);
  socket.say({ t: 'ev', m: 'ping', p: {} });
  assert.equal(heard, 1);
  connection.close();
});

test('a request that is never answered fails after its time limit', async () => {
  const { connection, socket } = await connected();
  const lost = connection.request('layer.set', { layer: 'a' }, { timeoutMs: 20 });
  await assert.rejects(lost, /did not answer 'layer\.set'/);
  // An answer that comes after all is ignored, and later requests work as before.
  const asked = socket.sent.find((m) => m.t === 'req');
  socket.say({ t: 'res', id: asked.id, ok: true, r: {} });
  const next = connection.request<{ done: boolean }>('layer.set', { layer: 'b' });
  const second = socket.sent.filter((m) => m.t === 'req')[1];
  socket.say({ t: 'res', id: second.id, ok: true, r: { done: true } });
  assert.deepEqual(await next, { done: true });
  connection.close();
});

test('an answered request leaves no timer behind, and a lost connection fails what waits', async () => {
  const { connection, socket } = await connected();
  const waiting = connection.request('scene.add', {}, { timeoutMs: 60_000 });
  connection.close();
  await assert.rejects(waiting, /connection lost/);
  assert.equal(socket.readyState, 3);
});
