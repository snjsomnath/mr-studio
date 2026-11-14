import { parseFrame } from './frame.ts';
import { PROTOCOL } from './types.ts';
import type { FieldFrame, LayerManifest, Role, SessionState } from './types.ts';

export interface Welcome {
  surface: number;
  state: SessionState;
  manifests: LayerManifest[];
}

type Listener = (payload: any) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

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
  private retry = 0;
  private closed = false;
  private readonly url: string;
  private readonly role: Role;
  private readonly code: string | undefined;

  constructor(options: { url: string; role: Role; code?: string }) {
    this.url = options.url;
    this.role = options.role;
    this.code = options.code;
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
          socket.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, role: this.role, code: this.code }));
        };
        socket.onmessage = (event) => {
          if (typeof event.data !== 'string') {
            const frame = parseFrame(event.data as ArrayBuffer);
            for (const listener of this.frameListeners) listener(frame);
            return;
          }
          const message = JSON.parse(event.data);
          switch (message.t) {
            case 'welcome':
              this.retry = 0;
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
              if (message.ok) pending?.resolve(message.r);
              else pending?.reject(new Error(message.e));
              break;
            }
            case 'ev':
              this.emit(message.m, message.p);
              break;
          }
        };
        socket.onclose = () => {
          for (const pending of this.pending.values()) pending.reject(new Error('connection lost'));
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

  request<T = unknown>(method: string, params?: object): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ t: 'req', id, m: method, p: params ?? {} }));
    });
  }

  /** Subscribes to an event. Returns the function that unsubscribes. */
  on(event: string, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  onFrame(listener: (frame: FieldFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}
