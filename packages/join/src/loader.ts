/**
 * The join page (#275), published on GitHub Pages. A phone that scanned a table's QR code
 * lands here: `…/v1/?t=<table's peer>#/phone?c=<code>`. The page reaches the table over a
 * WebRTC data channel (PeerJS) and shows the phone page *from the table* in a frame. The
 * service worker (`sw.js`) hands every request of that frame to this page, which sends it to
 * the table; the frame's WebSocket is this page's `LinkSocket`. So the phone always runs the
 * table's own version, and nothing about a table is published here.
 */
import { Peer } from 'peerjs';
import type { DataConnection, PeerOptions } from 'peerjs';

import {
  HTTP_REQUEST,
  HTTP_RESPONSE,
  Joiner,
  LINK_HELLO,
  LINK_VERSION,
  WS_BINARY,
  WS_CLOSE,
  WS_OPEN,
  WS_TEXT,
  bytesOf,
  frame,
  parse,
  pieces,
  splitHead,
  text,
  textFrame,
  withHead,
} from '@mrstudio/sdk/src/link.ts';
import type { HttpHead } from '@mrstudio/sdk/src/link.ts';

import { say } from './words.ts';

/** How long the first connection may take before the page says it cannot reach the table. */
const FIRST_TRY_MS = 25_000;
/** How long one request waits for the table. */
const REQUEST_MS = 35_000;

const params = new URLSearchParams(location.search);
const target = params.get('t');
const route = location.hash.length > 1 ? location.hash.slice(1) : '/phone';
const root = new URL('./', location.href).pathname;
const linkId = Math.random().toString(36).slice(2, 10);
const appBase = `${root}t/${linkId}/`;

const door = document.getElementById('door')!;
const frameEl = document.getElementById('app') as HTMLIFrameElement;

function show(title: string, body: string, again?: string) {
  door.hidden = false;
  document.getElementById('door-title')!.textContent = title;
  document.getElementById('door-text')!.textContent = body;
  const button = document.getElementById('door-again') as HTMLButtonElement;
  button.hidden = !again;
  if (again) {
    button.textContent = again;
    button.onclick = () => location.reload();
  }
  door.classList.toggle('stuck', !!again);
}

interface Waiting {
  head: HttpHead;
  resolve: (answer: { status: number; headers: [string, string][]; body: Uint8Array }) => void;
  timer: number;
}

/** The link to the table: one data channel, carrying streams of requests and sockets. */
class Link {
  private conn: DataConnection | null = null;
  private ready = false;
  private next = 1;
  private requests = new Map<number, Waiting>();
  private sockets = new Map<number, LinkSocket>();
  private joiner = new Joiner();
  private retry = 0;
  private peer: Peer;
  everConnected = false;
  onState: (state: 'up' | 'down' | 'gone' | 'old' | 'new') => void = () => {};
  private readonly table: string;

  constructor(table: string, options: PeerOptions) {
    this.table = table;
    this.peer = new Peer({ debug: 0, ...options });
    this.peer.on('open', () => this.dial());
    this.peer.on('disconnected', () => {
      if (!this.peer.destroyed) window.setTimeout(() => !this.peer.destroyed && this.peer.reconnect(), 2000);
    });
    this.peer.on('error', (error) => {
      const type = (error as { type?: string }).type;
      // The table's peer is not there: it closed, or its link moved to a new id.
      if (type === 'peer-unavailable') {
        this.onState('gone');
        this.later();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.ready && this.peer.open) this.dial();
    });
  }

  private later() {
    const pause = Math.min(10_000, 1000 * 2 ** this.retry++);
    window.setTimeout(() => this.peer.open && !this.ready && this.dial(), pause);
  }

  private dial() {
    if (this.conn && !this.ready) this.conn.close();
    const conn = this.peer.connect(this.table, { serialization: 'raw', reliable: true });
    this.conn = conn;
    this.joiner = new Joiner();
    conn.on('data', async (data) => {
      const piece = await bytesOf(data);
      if (!piece || conn !== this.conn) return;
      const whole = this.joiner.push(piece);
      const parsed = whole && parse(whole);
      if (parsed) this.receive(parsed.kind, parsed.stream, parsed.payload);
    });
    const down = () => {
      if (conn !== this.conn) return;
      this.conn = null;
      const was = this.ready;
      this.ready = false;
      // The page's sockets close and reconnect by themselves once the link is back.
      for (const socket of this.sockets.values()) socket.closed();
      this.sockets.clear();
      if (was) this.onState('down');
      this.later();
    };
    conn.on('close', down);
    conn.on('error', down);
  }

  private receive(kind: number, stream: number, payload: Uint8Array) {
    if (kind === LINK_HELLO) {
      const hello = JSON.parse(text(payload)) as { v?: number };
      if (hello.v !== LINK_VERSION) {
        this.peer.destroy();
        // Each link version's join page stays published beside this one: go to the table's.
        if (Number.isInteger(hello.v) && hello.v! > 0 && /\/v\d+\/$/.test(root)) {
          location.replace(`${root.replace(/v\d+\/$/, `v${hello.v}/`)}${location.search}${location.hash}`);
          return;
        }
        this.onState((hello.v ?? 0) > LINK_VERSION ? 'new' : 'old');
        return;
      }
      this.ready = true;
      this.retry = 0;
      this.everConnected = true;
      // Requests that waited for the link, or were cut off by a drop, go (again) now.
      for (const [stream, waiting] of this.requests) this.send(withHead(HTTP_REQUEST, stream, waiting.head));
      this.onState('up');
      return;
    }
    if (kind === HTTP_RESPONSE) {
      const waiting = this.requests.get(stream);
      const parts = splitHead<HttpHead>(payload);
      if (!waiting || !parts) return;
      this.requests.delete(stream);
      window.clearTimeout(waiting.timer);
      waiting.resolve({ status: parts.head.status ?? 502, headers: parts.head.headers ?? [], body: parts.body.slice() });
      return;
    }
    const socket = this.sockets.get(stream);
    if (!socket) return;
    if (kind === WS_TEXT) socket.received(text(payload));
    else if (kind === WS_BINARY) socket.received(payload.slice().buffer);
    else if (kind === WS_CLOSE) {
      this.sockets.delete(stream);
      socket.closed();
    }
  }

  private send(bytes: Uint8Array) {
    const conn = this.conn;
    if (!conn || !conn.open) return;
    // A send that fails means the link dropped: its close is what is acted on, and what waited goes again.
    for (const piece of pieces(bytes)) void conn.send(piece);
  }

  fetch(head: HttpHead): Promise<{ status: number; headers: [string, string][]; body: Uint8Array }> {
    return new Promise((resolve) => {
      const stream = this.next++;
      const timer = window.setTimeout(() => {
        this.requests.delete(stream);
        resolve({ status: 504, headers: [], body: new Uint8Array(0) });
      }, REQUEST_MS);
      this.requests.set(stream, { head, resolve, timer });
      if (this.ready) this.send(withHead(HTTP_REQUEST, stream, head));
    });
  }

  /** A socket for the page; it opens once the link is up. */
  open(socket: LinkSocket, path: string): number | null {
    if (!this.ready) return null;
    const stream = this.next++;
    this.sockets.set(stream, socket);
    this.send(frame(WS_OPEN, stream, new TextEncoder().encode(JSON.stringify({ path }))));
    return stream;
  }

  socketSend(stream: number, data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data === 'string') this.send(textFrame(WS_TEXT, stream, data));
    else this.send(frame(WS_BINARY, stream, data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
  }

  socketClose(stream: number) {
    if (this.sockets.delete(stream)) this.send(frame(WS_CLOSE, stream));
  }
}

let link: Link | null = null;

/**
 * The frame's WebSocket: enough of the browser's for the studio's connection, carried over
 * the link. It opens at once when the link is up and closes (so the page reconnects) when not.
 */
class LinkSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  extensions = '';
  protocol = '';
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent | Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private stream: number | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    const path = new URL(this.url, location.href).pathname;
    window.setTimeout(() => {
      this.stream = link?.open(this, path) ?? null;
      if (this.stream === null) return this.closed();
      this.readyState = 1;
      this.fire('open', new Event('open'));
    }, 0);
  }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== 1 || this.stream === null) throw new DOMException('not open', 'InvalidStateError');
    link?.socketSend(this.stream, data);
  }

  close() {
    if (this.readyState >= 2) return;
    if (this.stream !== null) link?.socketClose(this.stream);
    this.closed();
  }

  received(data: string | ArrayBuffer) {
    if (this.readyState !== 1) return;
    const value = typeof data === 'string' || this.binaryType === 'arraybuffer' ? data : new Blob([data]);
    this.fire('message', new MessageEvent('message', { data: value }));
  }

  closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', new CloseEvent('close', { code: 1006, wasClean: false }));
  }

  private fire(type: 'open' | 'message' | 'close', event: Event) {
    const handler = this[`on${type}`] as ((event: Event) => void) | null;
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}

/** What the frame reaches through `parent.__mrsLink`. */
(window as unknown as { __mrsLink: unknown }).__mrsLink = { WebSocket: LinkSocket };

/** Requests the service worker hands over: `{ link, method, path, headers }` and a port for the answer. */
function listen() {
  navigator.serviceWorker.addEventListener('message', async (event: MessageEvent) => {
    const asked = event.data as { type?: string; link?: string | null; method: string; path: string; headers: [string, string][] };
    const port = event.ports[0];
    if (asked?.type !== 'mrs-fetch' || !port || !link) return;
    if (asked.link && asked.link !== linkId) return;
    const answer = await link.fetch({ method: asked.method, path: asked.path, headers: asked.headers });
    const body = answer.body.buffer as ArrayBuffer;
    port.postMessage({ status: answer.status, headers: answer.headers, body }, [body]);
  });
}

async function main() {
  if (!target) {
    show(say('Scan the table’s code'), say('Open this page from the QR code on the table’s screen.'));
    return;
  }
  if (!('serviceWorker' in navigator) || !window.RTCPeerConnection) {
    show(say('This browser can’t join'), say('Open the link in Safari or Chrome, or update the browser.'));
    return;
  }
  show(say('Connecting to the table…'), '');
  let options: PeerOptions = {};
  try {
    options = JSON.parse(params.get('s') ?? '{}') as PeerOptions;
  } catch {
    // Bad options in the link: the defaults.
  }
  listen();
  await navigator.serviceWorker.register('./sw.js', { scope: './' });
  await navigator.serviceWorker.ready;

  link = new Link(target, options);
  const stuck = window.setTimeout(() => {
    if (!link?.everConnected) show(say('Can’t reach the table'), say('The table may be closed, or this network blocks the connection. Try mobile data, or ask the staff.'), say('Try again'));
  }, FIRST_TRY_MS);
  link.onState = (state) => {
    if (state === 'old') return show(say('This table needs an older join page'), say('Ask the staff to update the table’s software.'));
    if (state === 'new') return show(say('This table needs a newer join page'), say('Reload the page. If it keeps showing, ask the staff.'), say('Try again'));
    if (state === 'up' && frameEl.hidden) {
      window.clearTimeout(stuck);
      frameEl.src = `${appBase}${route.replace(/^\//, '')}`;
      // Shown once loaded, or after a moment: the page draws its own "connecting" state.
      const reveal = () => {
        door.hidden = true;
        frameEl.hidden = false;
      };
      frameEl.addEventListener('load', reveal, { once: true });
      window.setTimeout(reveal, 3000);
    }
  };
}

void main();
