import { EngineClient } from '@mrstudio/sdk';
import type { Connection, LayerModule, LayerState, PanelContext, TableContext, TableHandlers, ToolInput } from '@mrstudio/sdk';

import { layerModule } from './registry.ts';
import { changedKeys } from './store.ts';
import type { Store } from './store.ts';
import type { TableView } from './table.ts';

interface Running {
  handlers: TableHandlers;
  cleanups: (() => void)[];
  frames: ((dt: number) => void)[];
  /** Set once activation finished; updates before that are folded into the first one. */
  ready: boolean;
  stopped: boolean;
}

/** Sends param changes for a layer, at most one request per animation frame. */
export function paramSender(connection: Connection, layer: string): (patch: Record<string, unknown>) => void {
  let pending: Record<string, unknown> | null = null;
  return (patch) => {
    if (pending) {
      Object.assign(pending, patch);
      return;
    }
    pending = { ...patch };
    requestAnimationFrame(() => {
      const params = pending!;
      pending = null;
      connection.request('layer.set', { layer, params }).catch((error) => console.warn(`[${layer}] ${error.message}`));
    });
  };
}

/** Shared read-only parts of a layer context, backed by the store. */
export function baseContext(store: Store, connection: Connection, layer: string): Pick<PanelContext, 'site' | 'params' | 'shared' | 'setParams'> {
  return {
    get site() {
      return store.state.site;
    },
    get params() {
      return store.layer(layer).params;
    },
    get shared() {
      return store.layer(layer).shared;
    },
    setParams: paramSender(connection, layer),
  };
}

/** Runs the `table` side of layers on the table surface, following the host's state. */
export class LayerManager {
  private running = new Map<string, Running>();
  private engine: EngineClient;
  private last = performance.now();
  private readonly store: Store;
  private readonly connection: Connection;
  private readonly view: TableView;

  constructor(store: Store, connection: Connection, view: TableView) {
    this.store = store;
    this.connection = connection;
    this.view = view;
    this.engine = new EngineClient(connection);
    store.onLayer((id, state, previous) => this.sync(id, state, previous));
    for (const [id, state] of Object.entries(store.state.layers)) this.sync(id, state, undefined);
    connection.on('layer.action', (p: { layer: string; action: string }) => this.running.get(p.layer)?.handlers.action?.(p.action));
    connection.on('tool.input', (p: ToolInput) => this.running.get(p.layer)?.handlers.tool?.(p));
    requestAnimationFrame(this.frame);
  }

  private sync(id: string, state: LayerState, previous: LayerState | undefined): void {
    this.view.setIntensity(id, state.intensity ?? 1);
    const running = this.running.get(id);
    if (state.active && !running) {
      void this.start(id);
    } else if (!state.active && running) {
      this.stop(id);
    } else if (running?.ready) {
      const changed = changedKeys(previous?.params, state.params);
      if (changed.length > 0) this.guard(id, () => running.handlers.update?.(changed));
    }
  }

  private async start(id: string): Promise<void> {
    const module = layerModule(id) as LayerModule | undefined;
    if (!module?.table) {
      if (!module) console.warn(`layer '${id}' is not part of this build`);
      return;
    }
    const running: Running = { handlers: {}, cleanups: [], frames: [], ready: false, stopped: false };
    this.running.set(id, running);
    const track = (cleanup: () => void) => {
      if (running.stopped) cleanup();
      else running.cleanups.push(cleanup);
    };
    const published: Record<string, unknown> = {};
    const { store, engine } = this;
    const extras: Omit<TableContext, 'site' | 'params' | 'shared' | 'setParams'> = {
      engine: {
        open: async (kernel, params, fields, options) => {
          const stream = await engine.open(kernel, params, fields, options);
          track(() => stream.close());
          return stream;
        },
        info: () => engine.info(),
      } as EngineClient,
      map: this.view.handle(id, track),
      pointer: this.view.pointer(track),
      publish: (values) => {
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(values)) {
          if (JSON.stringify(published[key]) !== JSON.stringify(value)) patch[key] = published[key] = value;
        }
        if (Object.keys(patch).length > 0) this.connection.request('layer.publish', { layer: id, values: patch }).catch(() => {});
      },
      onFrame: (callback) => running.frames.push(callback),
      onCleanup: track,
    };
    // The base context has live getters, so it is the prototype rather than a copy.
    const ctx: TableContext = Object.assign(Object.create(baseContext(store, this.connection, id)), extras);
    const before = { ...store.layer(id).params };
    try {
      running.handlers = (await module.table(ctx)) ?? {};
    } catch (error) {
      console.error(`[${id}] failed to start`, error);
      this.stop(id);
      return;
    }
    if (running.stopped) return;
    running.ready = true;
    // Params may have changed while the layer was starting.
    const changed = changedKeys(before, store.layer(id).params);
    if (changed.length > 0) this.guard(id, () => running.handlers.update?.(changed));
  }

  private stop(id: string): void {
    const running = this.running.get(id);
    if (!running) return;
    running.stopped = true;
    this.running.delete(id);
    for (const cleanup of running.cleanups.reverse()) this.guard(id, cleanup);
  }

  /** A layer that throws must not take the table down with it. */
  private guard(id: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error(`[${id}]`, error);
    }
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    for (const [id, running] of this.running) {
      if (running.ready) for (const callback of running.frames) this.guard(id, () => callback(dt));
    }
    requestAnimationFrame(this.frame);
  };
}
