/**
 * The table's side of the join page (#275). Phones on eduroam or mobile data cannot reach the
 * studio computer, so they open a page on GitHub Pages that reaches the table over WebRTC
 * (PeerJS, with its free signalling server unless the host names another). This bridge holds
 * the table's peer and carries each phone's traffic to the host over one local socket,
 * `/api/phones/bridge`, as the relay protocol's frames. The host answers it exactly as it
 * answers the relay: as from the network, GET and HEAD only, phones' sockets only.
 *
 * Each phone numbers its own streams; the bridge renumbers them so they never collide.
 *
 * Handing over (#422): the host gives every bridge the same peer id, so when this window closes,
 * sleeps or steps aside, the next surface to carry phones (the table) takes the same peer and the
 * phones' join pages dial it again by themselves. A hidden window steps aside when another one
 * waits, and the tab's title warns while phones depend on a hidden window.
 */
import type { DataConnection, PeerOptions } from 'peerjs';

import {
  HTTP_RESPONSE,
  Joiner,
  LINK_HELLO,
  LINK_VERSION,
  WS_CLOSE,
  WS_OPEN,
  bytesOf,
  frame,
  parse,
  pieces,
  restream,
  textFrame,
} from '@mrstudio/sdk/src/link.ts';

/** The most streams one phone may have open at once. */
const STREAMS_PER_PHONE = 256;
/** Data channel bytes waiting to go before the bridge waits for the phone to catch up. */
const HIGH_WATER = 1024 * 1024;

interface Phone {
  conn: DataConnection;
  /** The phone's stream number to the bridge's. */
  streams: Map<number, number>;
  sockets: Set<number>;
  queue: Uint8Array[];
  sending: boolean;
}

/** How often a surface asks again while another carries the phones: the hand-over takes this long at most. */
const BUSY_RETRY_MS = 4000;

export function startBridge(): void {
  let retry = 0;
  const again = (ms: number) => window.setTimeout(link, ms);
  /** This window stepped aside for another: it does not ask again soon. */
  let yielded = false;
  /** Stops this window's bridge now (closing, frozen, stepping aside). */
  let release: (() => void) | null = null;
  // The tab closes or the browser freezes it (Memory Saver, a sleeping laptop): let go at once,
  // so the signalling server frees the peer id and the table takes it.
  document.addEventListener('freeze', () => release?.());
  window.addEventListener('pagehide', () => release?.());
  const title = document.title;

  function link() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/api/phones/bridge`);
    socket.binaryType = 'arraybuffer';
    let peer: import('peerjs').Peer | null = null;
    let stopped = false;
    const phones = new Set<Phone>();
    // The bridge's stream number to its phone and the phone's own number.
    const routes = new Map<number, { phone: Phone; stream: number }>();
    let next = 1;
    /** The host said another surface carries the phones. */
    let busy = false;

    const warn = () => {
      document.title = document.hidden && phones.size > 0 && !stopped ? `⚠ Phones join through this window · ${title}` : title;
    };
    document.addEventListener('visibilitychange', warn);
    release = () => {
      stop();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    };

    const toHost = (bytes: Uint8Array) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
    };
    const flush = (phone: Phone) => {
      if (phone.sending) return;
      const channel = phone.conn.dataChannel;
      while (phone.queue.length) {
        if (!phone.conn.open) {
          phone.queue = [];
          return;
        }
        if (channel && channel.bufferedAmount > HIGH_WATER) {
          phone.sending = true;
          channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
          channel.addEventListener(
            'bufferedamountlow',
            () => {
              phone.sending = false;
              flush(phone);
            },
            { once: true },
          );
          return;
        }
        void phone.conn.send(phone.queue.shift()!);
      }
    };
    const toPhone = (phone: Phone, bytes: Uint8Array) => {
      phone.queue.push(...pieces(bytes));
      flush(phone);
    };
    const forget = (phone: Phone) => {
      if (!phones.delete(phone)) return;
      warn();
      for (const [local, ours] of phone.streams) {
        if (phone.sockets.has(local)) toHost(frame(WS_CLOSE, ours));
        routes.delete(ours);
      }
    };

    const welcome = (conn: DataConnection) => {
      const phone: Phone = { conn, streams: new Map(), sockets: new Set(), queue: [], sending: false };
      const joiner = new Joiner();
      conn.on('open', () => {
        phones.add(phone);
        warn();
        toPhone(phone, textFrame(LINK_HELLO, 0, JSON.stringify({ v: LINK_VERSION })));
      });
      conn.on('data', async (data) => {
        const piece = await bytesOf(data);
        if (!piece) return;
        let whole: Uint8Array | null;
        try {
          whole = joiner.push(piece);
        } catch {
          conn.close();
          return;
        }
        const parsed = whole && parse(whole);
        if (!parsed || !phones.has(phone)) return;
        let ours = phone.streams.get(parsed.stream);
        if (ours === undefined) {
          if (parsed.kind === WS_CLOSE || phone.streams.size >= STREAMS_PER_PHONE) return;
          ours = next++;
          phone.streams.set(parsed.stream, ours);
          routes.set(ours, { phone, stream: parsed.stream });
        }
        if (parsed.kind === WS_OPEN) phone.sockets.add(parsed.stream);
        if (parsed.kind === WS_CLOSE) {
          phone.streams.delete(parsed.stream);
          phone.sockets.delete(parsed.stream);
          routes.delete(ours);
        }
        toHost(restream(whole!, ours));
      });
      conn.on('close', () => forget(phone));
      conn.on('error', () => forget(phone));
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const phone of [...phones]) {
        forget(phone);
        phone.conn.close();
      }
      peer?.destroy();
      peer = null;
      warn();
      document.removeEventListener('visibilitychange', warn);
    };

    socket.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const said = JSON.parse(event.data);
        if (said.t === 'off') return stop();
        if (said.t === 'busy') {
          busy = true;
          return stop();
        }
        // Another surface waits to carry the phones: a hidden window lets it (#422).
        if (said.t === 'waiting') {
          if (document.hidden) {
            yielded = true;
            release?.();
          }
          return;
        }
        if (said.t === 'bridge') {
          retry = 0;
          yielded = false;
          const { Peer } = await import('peerjs');
          const options: PeerOptions = { debug: 0, ...(said.peer ?? {}) };
          // The host's peer id, the same for every bridge, so phones find the next one (#422).
          const shared = typeof said.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(said.id) ? (said.id as string) : null;
          let taken = 0;
          const open = () => {
            if (stopped) return;
            // The window before may still hold the id for a few seconds: ask for it again, then give up on it.
            const id = shared && taken < 10 ? shared : `mrs-${randomId()}`;
            const made = new Peer(id, options);
            peer = made;
            made.on('open', (id) => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'peer', id }));
            });
            made.on('connection', welcome);
            // The signalling server dropped us: phones already joined keep their channels.
            made.on('disconnected', () => {
              if (!stopped && !made.destroyed) window.setTimeout(() => !stopped && !made.destroyed && made.reconnect(), 3000);
            });
            made.on('error', (error) => {
              const type = (error as { type?: string }).type;
              if (type === 'unavailable-id' || type === 'server-error' || type === 'socket-error' || type === 'network') {
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'peer', id: null }));
                made.destroy();
                if (type === 'unavailable-id') taken++;
                window.setTimeout(open, type === 'unavailable-id' ? (shared && taken < 10 ? 3000 : 0) : 10_000);
              }
            });
          };
          open();
        }
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const parsed = parse(bytes);
      if (!parsed) return;
      const route = routes.get(parsed.stream);
      if (!route) return;
      if (parsed.kind === WS_CLOSE) {
        route.phone.streams.delete(route.stream);
        route.phone.sockets.delete(route.stream);
        routes.delete(parsed.stream);
      } else if (parsed.kind === HTTP_RESPONSE) {
        // One answer per request: the stream is done.
        route.phone.streams.delete(route.stream);
        routes.delete(parsed.stream);
      }
      toPhone(route.phone, restream(bytes, route.stream));
    };
    socket.onclose = () => {
      const quiet = stopped;
      stop();
      // Busy: ask again soon, to take the phones over when the other surface goes. Off, or
      // stepped aside: now and then. Lost: back off.
      again(yielded ? 30_000 : busy ? BUSY_RETRY_MS : quiet ? 30_000 : Math.min(30_000, 1000 * 2 ** retry++));
    };
  }

  link();
}

function randomId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
