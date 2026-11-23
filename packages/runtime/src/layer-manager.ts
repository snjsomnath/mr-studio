import { EngineClient } from '@mrstudio/sdk';
import type { Connection, LayerModule, LayerState, PanelContext, TableContext, TableHandlers, ToolInput } from '@mrstudio/sdk';

import { recipeModule } from './recipe-player.ts';
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

/**
 * Sends param changes for a layer, at most one request per animation frame, carrying the
 * latest values. `layer.set` changes the running session; the composer uses `scene.set`,
 * which also saves. `minInterval` (ms) spaces the requests further apart; phones use it to
 * stay inside the host's per-phone request limit while a slider is dragged.
 */
export function paramSender(
  connection: Connection,
  layer: string,
  options: { method?: 'layer.set' | 'scene.set'; minInterval?: number } = {},
): (patch: Record<string, unknown>) => void {
  const { method = 'layer.set', minInterval = 0 } = options;
  let pending: Record<string, unknown> | null = null;
  let last = -Infinity;
  const flush = () => {
    const params = pending!;
    pending = null;
    last = performance.now();
    connection.request(method, { layer, params }).catch((error) => console.warn(`[${layer}] ${error.message}`));
  };
  return (patch) => {
    if (pending) {
      Object.assign(pending, patch);
      return;
    }
    pending = { ...patch };
    const wait = last + minInterval - performance.now();
    if (wait > 0) setTimeout(flush, wait);
    else requestAnimationFrame(flush);
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
    view.setOrder(store.state.scene);
    store.onLayer((id, state, previous) => this.sync(id, state, previous));
    store.onRemoved((id) => {
      this.stop(id);
      view.dropSlot(id);
    });
    store.onScene((scene) => view.setOrder(scene));
    for (const id of store.state.scene) this.sync(id, store.layer(id), undefined);
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
      const revealed = state.step?.index ?? 0;
      if (revealed !== (previous?.step?.index ?? 0)) this.guard(id, () => running.handlers.step?.(revealed));
    }
  }

  private async start(id: string): Promise<void> {
    // `id` names the instance; the code comes from the layer package it runs.
    const layer = this.store.layer(id).layer;
    // A custom layer has no code: the recipe player draws it from its manifest, and restyles as it is saved again.
    const manifest = this.store.manifest(layer);
    const module = (layerModule(layer) as LayerModule | undefined) ??
      (manifest?.custom
        ? recipeModule(
            () => this.store.manifest(layer),
            (callback) => this.store.onCatalog((changed) => (changed === layer || changed === '') && callback()),
          )
        : undefined);
    if (!module?.table) {
      if (!module) console.warn(`layer '${layer}' is not part of this build`);
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
      model: this.view.modelHandle(id, track),
      pointer: this.view.pointer(track),
      sendTool: (tool, geometry) => this.connection.request<void>('tool.input', { layer: id, tool, geometry }),
      publish: (values) => {
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(values)) {
          if (JSON.stringify(published[key]) !== JSON.stringify(value)) patch[key] = published[key] = value;
        }
        if (Object.keys(patch).length > 0) this.connection.request('layer.publish', { layer: id, values: patch }).catch(() => {});
      },
      steps: {
        define: (count, titles) => {
          this.connection.request('layer.substeps', { layer: id, count, titles }).catch((error) => console.warn(`[${id}] sub-steps`, error));
        },
        get revealed() {
          return store.state.layers[id]?.step?.index ?? 0;
        },
        get state() {
          return store.state.layers[id]?.step;
        },
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
      if (!running.stopped) console.error(`[${id}] failed to start`, error);
      if (this.running.get(id) === running) this.stop(id);
      return;
    }
    if (running.stopped) return;
    running.ready = true;
    // Params may have changed while the layer was starting.
    const changed = changedKeys(before, store.state.layers[id]?.params ?? before);
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
