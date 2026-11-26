import { parseFrame } from './frame.ts';
import { PROTOCOL } from './types.ts';
import type { FieldFrame, LayerManifest, Role, SessionState } from './types.ts';

export interface Welcome {
  surface: number;
  /** Phones only: present it in the next `hello` to return to the same slot. */
  resume?: string;
  /** Phones only: every seat was taken, so this phone looks but changes nothing (#462). */
  watching?: boolean;
  state: SessionState;
  manifests: LayerManifest[];
  /** The host's clock when it said welcome, in ms since 1970 (#373). */
  time?: number;
}

type Listener = (payload: any) => void;

/** One message seen on the connection, for the Developer window's action log (#358). */
export interface ConnectionTrace {
  kind: 'request' | 'event';
  method: string;
  payload: unknown;
  /** When it was sent or arrived (performance.now()). */
  at: number;
  /** A request's round trip, once answered. */
  ms?: number;
  ok?: boolean;
  error?: string;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** How long a request waits for its answer before it fails (#510). The host answers in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The single link between a surface and the host: JSON requests and events,
 * and binary field frames. Reconnects on its own and reports each (re)welcome.
 */
export class Connection {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<Listener>>();
  private frameListeners = new Set<(frame: FieldFrame) => void>();
  private tracers = new Set<(trace: ConnectionTrace) => void>();
  private retry = 0;
  private closed = false;
  private readonly url: string;
  private readonly role: Role;
  private readonly code: string | undefined;
  private resume: string | undefined;
  private offset = 0;

  /** `resume` is a token kept from an earlier welcome, for a phone that reloaded. */
  constructor(options: { url: string; role: Role; code?: string; resume?: string }) {
    this.url = options.url;
    this.role = options.role;
    this.code = options.code;
    this.resume = options.resume;
  }

  /** The host's time now, in ms since 1970: what a play head's `at` counts in (#373). */
  hostNow(): number {
    return Date.now() + this.offset;
  }

  /** Connects and resolves with the first welcome. Later reconnects emit `welcome`. */
  connect(): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      let first = true;
      const open = () => {
        const socket = new WebSocket(this.url);
        socket.binaryType = 'arraybuffer';
        this.socket = socket;
        socket.onopen = () => {
          socket.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, role: this.role, code: this.code, resume: this.resume }));
        };
        socket.onmessage = (event) => {
          if (typeof event.data !== 'string') {
            let frame: FieldFrame;
            try {
              frame = parseFrame(event.data as ArrayBuffer);
            } catch (error) {
              this.failedListener('a field frame that could not be read', error);
              return;
            }
            // One layer's listener that throws does not keep the frame from the others (#510).
            for (const listener of this.frameListeners) {
              try {
                listener(frame);
              } catch (error) {
                this.failedListener('a field frame', error);
              }
            }
            return;
          }
          let message: any;
          try {
            message = JSON.parse(event.data);
          } catch (error) {
            this.failedListener('a message that could not be read', error);
            return;
          }
          switch (message.t) {
            case 'welcome':
              this.retry = 0;
              // Reconnects present the latest token, so a brief drop returns to the same slot.
              this.resume = message.resume ?? this.resume;
              // How far this device's clock is from the host's, for play heads (#373). A phone's may be off by minutes.
              if (typeof message.time === 'number') this.offset = message.time - Date.now();
              if (first) {
                first = false;
                resolve(message);
              }
              this.emit('welcome', message);
              break;
            case 'resync':
              this.emit('resync', message);
              break;
            case 'refused':
              this.closed = true;
              reject(new Error(message.e));
              this.emit('refused', message.e);
              break;
            case 'res': {
              const pending = this.pending.get(message.id);
              this.pending.delete(message.id);
              if (pending?.timer) clearTimeout(pending.timer);
              if (message.ok) pending?.resolve(message.r);
              else pending?.reject(new Error(message.e));
              break;
            }
            case 'ev':
              if (this.tracers.size) this.traced({ kind: 'event', method: message.m, payload: message.p, at: now() });
              this.emit(message.m, message.p);
              break;
          }
        };
        socket.onclose = () => {
          for (const pending of this.pending.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(new Error('connection lost'));
          }
          this.pending.clear();
          this.emit('disconnected', null);
          if (this.closed) return;
          const delay = Math.min(5000, 250 * 2 ** this.retry++);
          setTimeout(open, delay);
        };
      };
      open();
    });
  }

  /**
   * Asks the host and resolves with its answer. Fails when the host refuses, when the connection
   * is lost, and when no answer came within `timeoutMs` (30 s unless given; 0 waits for ever).
   */
  request<T = unknown>(method: string, params?: object, options?: { timeoutMs?: number }): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    const limit = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer =
        limit > 0
          ? setTimeout(() => {
              const pending = this.pending.get(id);
              this.pending.delete(id);
              pending?.reject(new Error(`the host did not answer '${method}' within ${Math.round(limit / 1000)} s`));
            }, limit)
          : undefined;
      if (this.tracers.size) {
        const at = now();
        const done = (ok: boolean, error?: string) => this.traced({ kind: 'request', method, payload: params ?? {}, at, ms: now() - at, ok, error });
        this.pending.set(id, {
          resolve: (value) => (done(true), resolve(value)),
          reject: (error) => (done(false, error.message), reject(error)),
          timer,
        });
      } else this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ t: 'req', id, m: method, p: params ?? {} }));
    });
  }

  /**
   * Tells the host about an error in this window (#260), for the app's log. Dropped while
   * disconnected. The runtime sends these; a layer just throws, or logs with `console.error`.
   */
  report(error: { message: string; stack?: string; layer?: string; window?: string }): void {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'error', ...error }));
  }

  /**
   * Says this window of the desktop app is alive and drawing at `fps` (#79), with its worst frame
   * of the last 10 s and the costliest layers (#262). Dropped while disconnected.
   */
  alive(window: string, fps: number, budget?: { worst_ms: number; layers: { id: string; ms: number; worst_ms: number }[] }): void {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'alive', window, fps: Math.round(fps * 10) / 10, ...budget }));
  }

  /** Subscribes to an event. Returns the function that unsubscribes. */
  on(event: string, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Sees every request this window makes (once answered) and every event it gets. Returns the function that stops it. */
  trace(listener: (trace: ConnectionTrace) => void): () => void {
    this.tracers.add(listener);
    return () => this.tracers.delete(listener);
  }

  private traced(trace: ConnectionTrace): void {
    for (const tracer of this.tracers) {
      try {
        tracer(trace);
      } catch {
        // A tracer never breaks the connection.
      }
    }
  }

  onFrame(listener: (frame: FieldFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }

  /** Calls every listener of `event`. One that throws does not keep the event from the others (#510). */
  private emit(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(payload);
      } catch (error) {
        this.failedListener(`the event '${event}'`, error);
      }
    }
  }

  /** A listener threw, or a message could not be read: the console and the app's log hear of it. */
  private failedListener(what: string, error: unknown): void {
    console.error(`[connection] handling ${what} failed:`, error);
    const message = error instanceof Error ? error.message : String(error);
    this.report({ message: `handling ${what} failed: ${message}`, stack: error instanceof Error ? error.stack : undefined });
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
