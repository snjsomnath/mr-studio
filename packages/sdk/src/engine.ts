import type { Connection } from './connection.ts';
import type { FieldFrame, StreamStatus } from './types.ts';

export interface OpenOptions {
  /** `u8` (default) is quantised over the field's range; `f32` is exact. */
  encoding?: 'u8' | 'f32';
  /** Upper bound on frames per second. Default 30. */
  maxHz?: number;
}

/**
 * A running kernel job whose fields arrive as frames. Survives reconnects:
 * it reopens itself with its latest params.
 */
export class FieldStream {
  private id: number | null = null;
  private params: Record<string, unknown>;
  private dirty: Record<string, unknown> | null = null;
  private sending = false;
  private closed = false;
  private fieldListeners = new Map<string, Set<(frame: FieldFrame) => void>>();
  private statusListeners = new Set<(status: StreamStatus) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private unsubscribe: (() => void)[] = [];
  private readonly connection: Connection;
  private readonly kernel: string;
  private readonly fields: string[];
  private readonly options: OpenOptions;

  constructor(connection: Connection, kernel: string, params: Record<string, unknown>, fields: string[], options: OpenOptions) {
    this.connection = connection;
    this.kernel = kernel;
    this.params = { ...params };
    this.fields = fields;
    this.options = options;
    this.unsubscribe.push(
      connection.onFrame((frame) => {
        if (frame.stream !== this.id) return;
        const name = this.fields[frame.field];
        if (name) for (const listener of this.fieldListeners.get(name) ?? []) listener(frame);
      }),
      connection.on('engine.status', (status: StreamStatus) => {
        if (status.stream === this.id) for (const listener of this.statusListeners) listener(status);
      }),
      connection.on('engine.error', (p: { stream: number; error: string }) => {
        if (p.stream === this.id) this.fail(new Error(p.error));
      }),
      // After a reconnect the host has forgotten the stream.
      connection.on('welcome', () => {
        if (this.id !== null) void this.open();
      }),
    );
  }

  async open(): Promise<void> {
    this.id = null;
    this.dirty = null;
    const result = await this.connection.request<{ stream: number }>('engine.open', {
      kernel: this.kernel,
      params: this.params,
      fields: this.fields,
      encoding: this.options.encoding ?? 'u8',
      maxHz: this.options.maxHz ?? 30,
    });
    if (this.closed) {
      void this.connection.request('engine.close', { stream: result.stream }).catch(() => {});
      return;
    }
    this.id = result.stream;
  }

  /** Changes params. Calls are coalesced: while one is in flight only the latest values are kept. */
  set(params: Record<string, unknown>): void {
    Object.assign(this.params, params);
    this.dirty = { ...this.dirty, ...params };
    void this.flush();
  }

  on(field: string, listener: (frame: FieldFrame) => void): void {
    let set = this.fieldListeners.get(field);
    if (!set) this.fieldListeners.set(field, (set = new Set()));
    set.add(listener);
  }

  onStatus(listener: (status: StreamStatus) => void): void {
    this.statusListeners.add(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.add(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribe) off();
    if (this.id !== null) void this.connection.request('engine.close', { stream: this.id }).catch(() => {});
  }

  private async flush(): Promise<void> {
    if (this.sending || this.closed || this.id === null) return;
    this.sending = true;
    try {
      while (this.dirty && !this.closed && this.id !== null) {
        const params = this.dirty;
        this.dirty = null;
        await this.connection.request('engine.set', { stream: this.id, params });
      }
    } catch (error) {
      this.fail(error as Error);
    } finally {
      this.sending = false;
    }
  }

  private fail(error: Error): void {
    if (this.errorListeners.size === 0) console.error(`[engine] ${this.kernel}: ${error.message}`);
    for (const listener of this.errorListeners) listener(error);
  }
}

/** One what-if change to the scene (`ctx.engine.edit`). Places are WGS84 `[lon, lat]`. */
export type SceneEdit =
  | { kind: 'building'; outline: [number, number][]; height_m: number }
  | { kind: 'tree'; at: [number, number]; radius_m: number; height_m: number }
  | { kind: 'remove'; at: [number, number] };

export class EngineClient {
  private readonly connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /** Starts a kernel job and streams the named fields back. */
  async open(kernel: string, params: Record<string, unknown>, fields: string[], options: OpenOptions = {}): Promise<FieldStream> {
    const stream = new FieldStream(this.connection, kernel, params, fields, options);
    await stream.open();
    return stream;
  }

  /**
   * Asks a kernel about one place instead of the whole table (sunlight: that spot's light every few
   * minutes across the day, and its sun hours). `at` is WGS84 `[lon, lat]`; the site's own position
   * fills `lat`/`lon` params as for `open`. Rejects for a place off the table or a kernel without probes.
   */
  probe<T = Record<string, unknown>>(kernel: string, params: Record<string, unknown>, at: readonly [number, number] | readonly number[]): Promise<T> {
    return this.connection.request<T>('engine.probe', { kernel, params, at: [at[0], at[1]] });
  }

  /**
   * What-if changes over the baked scene (#500), seen by every kernel until replaced: buildings added or taken
   * away, trees planted or felled. Each call replaces the last list; `[]` gives the baked scene back, as does the
   * table going away. Table only. Nothing is saved to the site. See docs/contracts/engine.md.
   */
  edit(edits: readonly SceneEdit[]): Promise<void> {
    return this.connection.request('engine.edit', { edits });
  }

  info(): Promise<{ backend: string; adapter: string | null; kernels: { id: string }[] }> {
    return this.connection.request('engine.info');
  }
}
