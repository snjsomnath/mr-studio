import { EngineClient, stepTransition, transitionGain } from '@mrstudio/sdk';
import type { Connection, LayerManifest, LayerModule, LayerState, PanelContext, StepTransitionKind, TableContext, TableHandlers, ToolInput } from '@mrstudio/sdk';

import { Cues } from './cues.ts';
import { language, say } from './i18n.ts';
import { recipeModule } from './recipe-player.ts';
import { layerModule } from './registry.ts';
import { changedKeys } from './store.ts';
import type { Store } from './store.ts';
import type { TableView } from './table.ts';

/**
 * Part of the map at rest: a base or ambient layer, or a layer of the scene that site.json
 * starts on and gives no button, such as a Map data layer colouring the streets (#204).
 * Tools kept alongside the open layer (the phones' sketch) are not.
 */
export function isAtRest(manifest: LayerManifest, state: LayerState | undefined): boolean {
  if (manifest.category === 'base' || manifest.category === 'ambient') return true;
  return Boolean(state?.rest && !state.parent && !manifest.alongside);
}

interface Running {
  handlers: TableHandlers;
  cleanups: (() => void)[];
  frames: ((dt: number) => void)[];
  /** Set once activation finished; updates before that are folded into the first one. */
  ready: boolean;
  stopped: boolean;
}

/**
 * A sequence step coming in or going out (#43). `waiting` holds it until the step coming in
 * has started, so the old step stays on show while the new one loads; then both run the
 * transition of the new step together.
 */
interface Fade {
  role: 'in' | 'out';
  /** The sequence showing (or that showed) the layer. */
  sequence: string;
  waiting: boolean;
  since: number;
  kind: StepTransitionKind;
  seconds: number;
  t: number;
}

/** How long a step going out waits for the next one to start before it goes anyway. */
const WAIT_FOR_NEXT_MS = 4000;

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
export function baseContext(store: Store, connection: Connection, layer: string): Pick<PanelContext, 'site' | 'params' | 'shared' | 'setParams' | 'language' | 'say'> {
  return {
    get language() {
      return language();
    },
    say: (text, vars) => say(text, store.manifest(store.state.layers[layer]?.layer ?? ''), vars),
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
  private readonly cues: Cues;
  private last = performance.now();
  /** Steps of a sequence fading in or out, by instance. */
  private fades = new Map<string, Fade>();
  /** How strongly each instance shows while it fades: multiplied with its intensity. */
  private gains = new Map<string, number>();
  private readonly store: Store;
  private readonly connection: Connection;
  private readonly view: TableView;

  constructor(store: Store, connection: Connection, view: TableView) {
    this.store = store;
    this.connection = connection;
    this.view = view;
    this.engine = new EngineClient(connection);
    this.cues = new Cues(view);
    view.setOrder(store.state.scene);
    store.onLayer((id, state, previous) => this.sync(id, state, previous));
    store.onRemoved((id) => {
      this.stop(id);
      view.dropSlot(id);
    });
    store.onScene((scene) => view.setOrder(scene));
    for (const id of store.state.scene) this.sync(id, store.layer(id), undefined);
    connection.on('layer.action', (p: { layer: string; action: string }) => this.running.get(p.layer)?.handlers.action?.(p.action));
    connection.on('tool.input', (p: ToolInput) => {
      const running = this.running.get(p.layer);
      if (!running) return;
      // Something placed from a phone or the controller: pull eyes back to where it landed (#105).
      // A pick made on this table's own view needs no cue: people are already looking at it.
      if (p.from !== store.surface && this.cueFor(p)) this.cues.play(p.geometry, p.participant?.colour);
      running.handlers.tool?.(p);
    });
    requestAnimationFrame(this.frame);
  }

  /** A top-level `base` or `ambient` layer, or one site.json starts on without a button: part of the map at rest. */
  private atRest(id: string): boolean {
    const state = this.store.state.layers[id];
    const manifest = state ? this.store.manifest(state.layer) : undefined;
    return Boolean(state && manifest && !state.parent && isAtRest(manifest, state));
  }

  /** A layer opened from the controller: on, top-level, not part of the map at rest and not a tool kept alongside. */
  private opensOver(id: string): boolean {
    const state = this.store.state.layers[id];
    const manifest = state ? this.store.manifest(state.layer) : undefined;
    return Boolean(state?.active && manifest && !state.parent && !manifest.alongside && !isAtRest(manifest, state));
  }

  /**
   * Whether the map at rest's layer `id` steps aside for an open layer (#300). Any open layer turns
   * the map's life off (traffic, street life, lights, trees), as the Chalmers demo did; the base map
   * stays under it for context. A layer that hides the map at rest (the slideshow, #205) turns the
   * base map off too.
   */
  private hiddenAtRest(id: string): boolean {
    if (!this.atRest(id)) return false;
    const open = this.store.state.scene.filter((other) => other !== id && this.opensOver(other));
    if (open.length === 0) return false;
    if (open.some((other) => this.store.manifest(this.store.state.layers[other]!.layer)?.hidesAtRest)) return true;
    return this.store.manifest(this.store.state.layers[id]!.layer)?.category !== 'base';
  }

  private applyIntensity(id: string): void {
    this.view.setIntensity(id, (this.store.state.layers[id]?.intensity ?? 1) * (this.gains.get(id) ?? 1));
  }

  /** The step coming in to `sequence` has started (or failed to): it and the step going out run their transition. */
  private entered(id: string): void {
    const fade = this.fades.get(id);
    if (!fade || fade.role !== 'in' || !fade.waiting) return;
    const sequence = this.store.state.layers[fade.sequence];
    this.run(fade.sequence, stepTransition(sequence?.steps, sequence?.step?.index));
  }

  /** Starts the transition for every step of `sequence` that waits for one. */
  private run(sequence: string, transition: { kind: StepTransitionKind; seconds: number }): void {
    for (const [id, fade] of this.fades) {
      if (fade.sequence !== sequence || !fade.waiting) continue;
      Object.assign(fade, transition, { waiting: false, t: 0 });
      if (transition.kind === 'cut') this.finish(id, fade);
      else if (fade.role === 'in' && transition.kind === 'dip') {
        this.gains.set(id, 0);
        this.applyIntensity(id);
      }
    }
  }

  private finish(id: string, fade: Fade): void {
    this.fades.delete(id);
    this.gains.delete(id);
    if (fade.role === 'out') this.stop(id);
    else this.applyIntensity(id);
  }

  private sync(id: string, state: LayerState, previous: LayerState | undefined): void {
    this.applyIntensity(id);
    if (!this.atRest(id) && Boolean(state.active) !== Boolean(previous?.active)) {
      // The map at rest steps aside while a layer is open and comes back when it closes.
      for (const other of this.store.state.scene) if (other !== id && this.atRest(other)) this.sync(other, this.store.layer(other), this.store.layer(other));
    }
    if (state.active && !previous?.active && !state.parent && this.store.manifest(state.layer)?.sequence) this.prefetch(state);
    const running = this.running.get(id);
    const active = state.active && !this.hiddenAtRest(id);
    const fade = this.fades.get(id);
    if (active && fade?.role === 'out') {
      // Shown again before it had gone, such as the same layer in the next step.
      this.fades.delete(id);
      this.gains.delete(id);
      this.applyIntensity(id);
    }
    if (active && !running) {
      if (state.shown_by) {
        // A step of a sequence comes in from nothing, then fades up once it has started.
        this.fades.set(id, { role: 'in', sequence: state.shown_by, waiting: true, since: performance.now(), kind: 'cut', seconds: 0, t: 0 });
        this.gains.set(id, 0);
        this.applyIntensity(id);
      }
      void this.start(id);
    } else if (!active && running) {
      if (fade?.role === 'out') return;
      if (previous?.shown_by) {
        // A step going out stays on show until the next one has started, then fades with it.
        const out: Fade = { role: 'out', sequence: previous.shown_by, waiting: true, since: performance.now(), kind: 'cut', seconds: 0, t: 0 };
        this.fades.set(id, out);
        const coming = [...this.fades.values()].find((f) => f.role === 'in' && f.sequence === out.sequence && !f.waiting);
        if (coming) this.run(out.sequence, { kind: coming.kind, seconds: coming.seconds });
        return;
      }
      this.stop(id);
    } else if (running?.ready) {
      const changed = changedKeys(previous?.params, state.params);
      if (changed.length > 0) this.guard(id, () => running.handlers.update?.(changed));
      const revealed = state.step?.index ?? 0;
      if (revealed !== (previous?.step?.index ?? 0)) this.guard(id, () => running.handlers.step?.(revealed));
    }
  }

  /** Whether a tool input plays the attention cue: unless its tool says `cue: false`. */
  private cueFor(input: ToolInput): boolean {
    const layer = this.store.state.layers[input.layer]?.layer;
    const tool = layer ? this.store.manifest(layer)?.tools?.find((t) => t.id === input.tool) : undefined;
    return tool?.cue !== false;
  }

  /** A sequence opened: its steps' layers fetch what they will show, one after another (#42). */
  private prefetch(sequence: LayerState): void {
    const steps = sequence.steps?.sequence ?? [];
    void (async () => {
      for (const step of steps) {
        const target = this.store.state.layers[step.layer];
        const module = target ? (layerModule(target.layer) as LayerModule | undefined) : undefined;
        if (!target || !module?.prefetch) continue;
        try {
          await module.prefetch(this.store.state.site, { ...target.params, ...step.params });
        } catch {
          // The layer reports its own problem when it is shown.
        }
      }
    })();
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
      this.entered(id);
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
    const extras: Omit<TableContext, 'site' | 'params' | 'shared' | 'setParams' | 'language' | 'say'> = {
      engine: {
        open: async (kernel, params, fields, options) => {
          const stream = await engine.open(kernel, params, fields, options);
          track(() => stream.close());
          return stream;
        },
        probe: (kernel, params, at) => engine.probe(kernel, params, at),
        info: () => engine.info(),
      } as EngineClient,
      map: this.view.handle(id, track),
      model: this.view.modelHandle(id, track),
      pointer: this.view.pointer(track),
      sendTool: (tool, geometry) => this.connection.request<void>('tool.input', { layer: id, tool, geometry }),
      cue: (at, options) => {
        if (!running.stopped) this.cues.play(at, options?.colour);
      },
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
      // The legend travels with the published values, so every controller reads it from `shared`.
      legend: {
        set: (items) => extras.publish({ legend: items }),
        highlight: (item) => extras.publish({ legend_highlight: item }),
        show: (ids) => extras.publish({ legend_shown: ids === 'all' ? null : ids }),
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
      this.entered(id);
      return;
    }
    if (running.stopped) return;
    running.ready = true;
    this.entered(id);
    // Params may have changed while the layer was starting.
    const changed = changedKeys(before, store.state.layers[id]?.params ?? before);
    if (changed.length > 0) this.guard(id, () => running.handlers.update?.(changed));
  }

  private stop(id: string): void {
    const fade = this.fades.get(id);
    if (fade) {
      this.fades.delete(id);
      this.gains.delete(id);
      // A step that never came in lets the step going out go anyway.
      if (fade.role === 'in' && fade.waiting) {
        const sequence = this.store.state.layers[fade.sequence];
        this.run(fade.sequence, stepTransition(sequence?.steps, sequence?.step?.index));
      }
    }
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

  /** Moves every transition on by `dt` seconds. */
  private stepFades(dt: number, now: number): void {
    for (const [id, fade] of this.fades) {
      if (fade.waiting) {
        // Going out with nothing coming in: the slideshow closed, or the next step is slow to start.
        const sequence = this.store.state.layers[fade.sequence];
        if (fade.role === 'out' && (!sequence?.active || now - fade.since > WAIT_FOR_NEXT_MS)) {
          this.run(fade.sequence, stepTransition(sequence?.steps, sequence?.active ? sequence.step?.index : undefined));
        }
        continue;
      }
      fade.t += dt / Math.max(0.001, fade.seconds);
      if (fade.t >= 1) {
        this.finish(id, fade);
        continue;
      }
      this.gains.set(id, transitionGain(fade.kind, fade.role, fade.t));
      this.applyIntensity(id);
    }
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.stepFades(dt, now);
    for (const [id, running] of this.running) {
      if (running.ready) for (const callback of running.frames) this.guard(id, () => callback(dt));
    }
    requestAnimationFrame(this.frame);
  };
}
