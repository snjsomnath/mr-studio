/**
 * The table's side of the join page (#275). Phones on eduroam or mobile data cannot reach the
 * studio computer, so they open a page on GitHub Pages that reaches the table over WebRTC
 * (PeerJS, with its free signalling server unless the host names another). This bridge holds
 * the table's peer and carries each phone's traffic to the host over one local socket,
 * `/api/phones/bridge`, as the relay protocol's frames. The host answers it exactly as it
 * answers the relay: as from the network, GET and HEAD only, phones' sockets only.
 *
 * Each phone numbers its own streams; the bridge renumbers them so they never collide.
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

export function startBridge(): void {
  let retry = 0;
  const again = (ms: number) => window.setTimeout(link, ms);

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
        phone.conn.send(phone.queue.shift()!);
      }
    };
    const toPhone = (phone: Phone, bytes: Uint8Array) => {
      phone.queue.push(...pieces(bytes));
      flush(phone);
    };
    const forget = (phone: Phone) => {
      if (!phones.delete(phone)) return;
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
    };

    socket.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const said = JSON.parse(event.data);
        if (said.t === 'off') return stop();
        if (said.t === 'busy') return stop();
        if (said.t === 'bridge') {
          retry = 0;
          const { Peer } = await import('peerjs');
          const options: PeerOptions = { debug: 0, ...(said.peer ?? {}) };
          const open = () => {
            if (stopped) return;
            const id = `mrs-${randomId()}`;
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
                window.setTimeout(open, type === 'unavailable-id' ? 0 : 10_000);
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
      // Off or busy: look again now and then, in case the other surface closed.
      again(quiet ? 30_000 : Math.min(30_000, 1000 * 2 ** retry++));
    };
  }

  link();
}

function randomId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
