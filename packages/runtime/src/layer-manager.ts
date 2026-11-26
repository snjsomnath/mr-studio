import { EngineClient, VoiceBed, clockControl, entityChanges, entityValues, hearsSound, onDataProblem, serviceClient, stepTransition, transitionGain } from '@mrstudio/sdk';
import type { LayerView, RevealShape } from '@mrstudio/sdk';
import type { Connection, DataProblem, EntityChange, LayerHealth, LayerManifest, LayerModule, LayerPlayHead, LayerState, PanelContext, Sender, StepTransitionKind, TableContext, TableHandlers, TablePlayHead, ToolInput } from '@mrstudio/sdk';

import { Cues } from './cues.ts';
import { describe, reportError } from './diagnostics.ts';
import { meter } from './perf.ts';
import { entitiesOnTable } from './entities.ts';
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

/**
 * The order the table stacks the scene's layers in, bottom first: the scene's own order, except
 * that base maps always lie under everything else (#471), wherever the scene has them.
 */
export function stackOrder(store: { state: { layers: Record<string, { layer: string } | undefined> }; manifest(id: string): LayerManifest | undefined }, scene: readonly string[]): string[] {
  const base = (id: string) => store.manifest(store.state.layers[id]?.layer ?? '')?.category === 'base';
  return [...scene.filter(base), ...scene.filter((id) => !base(id))];
}

interface Running {
  handlers: TableHandlers;
  /** Entity changes waiting for their set's `debounce_ms` of quiet (#279), by set. */
  entities?: Map<string, { ids: Set<string>; timer: ReturnType<typeof setTimeout> }>;
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

/** Seconds before each new try of a layer in trouble (#259); the last repeats while it is on. */
export const RETRY_S = [1, 2, 5, 15, 60];

/** A layer that could not start or lost its data, and when it tries again. */
interface Trouble {
  reason: string;
  /** Tries made so far. */
  attempt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The try came while the layer was hidden (the map at rest under an open layer): it starts when shown again. */
  paused?: boolean;
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

/**
 * Sends entity changes for a layer (#279), at most one request per animation frame for each set
 * and list of entities, carrying the latest values. `null` puts the entities back to their defaults.
 */
export function entitySender(connection: Connection, layer: string): (set: string, ids: string | string[], values: Record<string, unknown> | null) => void {
  const pending = new Map<string, { set: string; ids: string[]; values: Record<string, unknown> | null }>();
  return (set, ids, values) => {
    const list = Array.isArray(ids) ? ids : [ids];
    const key = JSON.stringify([set, list]);
    const waiting = pending.get(key);
    if (waiting) {
      waiting.values = values === null || waiting.values === null ? values : { ...waiting.values, ...values };
      return;
    }
    pending.set(key, { set, ids: list, values: values === null ? null : { ...values } });
    requestAnimationFrame(() => {
      const change = pending.get(key)!;
      pending.delete(key);
      const p = change.values === null ? { layer, set, ids: change.ids, reset: true } : { layer, set, ids: change.ids, values: change.values };
      connection.request('layer.entity', p).catch((error) => console.warn(`[${layer}] ${error.message}`));
    });
  };
}

type Base = Pick<PanelContext, 'site' | 'params' | 'shared' | 'setParams' | 'language' | 'say' | 'service' | 'selection' | 'select' | 'entity' | 'setEntity' | 'sendTool' | 'action' | 'view' | 'clock'>;

/** A layer's play head as this view reads it (#373): the host's clock, carried on to now. */
export function playHead(store: Store, layer: string): LayerPlayHead {
  return {
    // While it runs, the host's play head carried on to now; otherwise the time control as set.
    now: () => {
      const state = store.state.layers[layer];
      if (state?.clock && state.clock.rate !== 0) return store.clockNow(layer);
      const time = clockControl(store.manifest(state?.layer ?? ''));
      const value = time ? state?.params[time.id] : undefined;
      return typeof value === 'number' ? value : null;
    },
    get running() {
      return (store.state.layers[layer]?.clock?.rate ?? 0) !== 0;
    },
  };
}

/** How far a play head may drift from what the views work out before the table sends it again (#373): a share of the control's range, and of the pace. */
const CLOCK_DRIFT = 0.002;
const CLOCK_PACE_DRIFT = 0.04;

/** Whether a new play head says no more than the last one sent does, carried on to now. */
function agrees(told: { value: number; rate: number; at: number }, value: number, rate: number, now: number, time: { min: number; max: number } | undefined): boolean {
  if (rate === 0 || told.rate === 0 ? rate !== told.rate : Math.abs(rate - told.rate) > Math.abs(rate) * CLOCK_PACE_DRIFT) return false;
  const span = time && time.max > time.min ? time.max - time.min : 0;
  let gap = Math.abs(told.value + (told.rate * (now - told.at)) / 1000 - value);
  // A time of day that wrapped at midnight is still where the views think.
  if (span > 0) gap = Math.min(gap % span, span - (gap % span));
  return gap <= Math.max(1e-9, span * CLOCK_DRIFT);
}

/** Fewest milliseconds between two pictures a table sends, and between two looks from a controller. */
const VIEW_SEND_MS = 90;
const VIEW_WATCH_MS = 80;

/**
 * `ctx.view` (#351): the table sends a picture to the host for the layer's controller, one at a
 * time and spaced out; the controller asks for anything newer than what it has.
 */
export function layerView(layer: string): LayerView {
  const url = `/api/layers/${encodeURIComponent(layer)}/view`;
  let sending = false;
  let lastSent = 0;
  return {
    send(canvas) {
      const now = performance.now();
      if (sending || now - lastSent < VIEW_SEND_MS || canvas.width === 0 || canvas.height === 0) return;
      sending = true;
      lastSent = now;
      const blob = 'convertToBlob' in canvas
        ? canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 })
        : new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      void blob
        .then((body) => (body ? fetch(url, { method: 'PUT', body }) : undefined))
        .catch(() => {})
        .finally(() => (sending = false));
    },
    watch(callback) {
      let revision = 0;
      let stopped = false;
      let timer = 0;
      const look = async () => {
        try {
          const response = await fetch(`${url}?after=${revision}`, { cache: 'no-store' });
          if (!stopped && response.status === 200) {
            revision = Number(response.headers.get('x-revision')) || revision + 1;
            const picture = await createImageBitmap(await response.blob());
            if (stopped) picture.close();
            else callback(picture);
          }
        } catch {
          // The host is away for a moment; look again.
        }
        if (!stopped) timer = window.setTimeout(look, VIEW_WATCH_MS);
      };
      void look();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}

/** Shared read-only parts of a layer context, backed by the store. */
export function baseContext(store: Store, connection: Connection, layer: string): Base {
  return {
    get selection() {
      return store.state.layers[layer]?.selection ?? null;
    },
    select: (set, id) => {
      connection.request('layer.select', { layer, set, id }).catch((error) => console.warn(`[${layer}] ${error.message}`));
    },
    entity: (set, id) => {
      const spec = store.manifest(store.state.layers[layer]?.layer ?? '')?.entities?.find((s) => s.id === set);
      return spec ? entityValues(spec, store.layer(layer).params, id) : {};
    },
    setEntity: entitySender(connection, layer),
    sendTool: (tool, geometry) => connection.request<void>('tool.input', { layer, tool, geometry }),
    action: (id) => connection.request<void>('layer.action', { layer, action: id }),
    service: (id) => serviceClient(id),
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
    view: layerView(layer),
    clock: playHead(store, layer),
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
  /** The shape each revealing layer shows its items through (#287); absent until it sets one. */
  private reveals = new Map<string, RevealShape | null>();
  /** Items a revealing layer gave a shape of their own (#349), by item instance id. */
  private itemReveals = new Map<string, RevealShape | null>();
  /** Layers in trouble (#259), by instance: started again with a growing wait until they run. */
  private trouble = new Map<string, Trouble>();
  /** Layers starting now, with the first data problem heard while they did. */
  private starting = new Map<string, string | null>();

  constructor(store: Store, connection: Connection, view: TableView) {
    this.store = store;
    this.connection = connection;
    this.view = view;
    this.engine = new EngineClient(connection);
    this.cues = new Cues(view);
    view.setOrder(stackOrder(store, store.state.scene));
    store.onLayer((id, state, previous) => this.sync(id, state, previous));
    store.onRemoved((id) => {
      this.forget(id, false);
      this.stop(id);
      view.dropSlot(id);
    });
    store.onScene((scene) => view.setOrder(stackOrder(store, scene)));
    for (const id of store.state.scene) this.sync(id, store.layer(id), undefined);
    connection.on('layer.action', (p: { layer: string; action: string; participant?: Sender; words?: string }) =>
      this.running.get(p.layer)?.handlers.action?.(p.action, p.participant, p.words),
    );
    // Retry from the editor or the controller: a layer in trouble starts again now.
    connection.on('layer.retry', (p: { layer: string }) => this.retryNow(p.layer));
    onDataProblem((problem) => this.dataTrouble(problem));
    connection.on('tool.input', (p: ToolInput) => {
      const running = this.running.get(p.layer);
      if (!running) return;
      // Something placed from a phone or the controller: pull eyes back to where it landed (#105).
      // A pick made on this table's own view needs no cue: people are already looking at it.
      if (p.from !== store.surface && this.cueFor(p)) this.cues.play(p.geometry, p.participant?.colour, p.participant?.avatar);
      running.handlers.tool?.(p);
    });
    requestAnimationFrame(this.frame);
    meter.start();
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
    // Off: any trouble it had is over (the host forgets it too).
    if (!state.active) this.forget(id, false);
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
    // A layer in trouble starts again on its own timer, not with every change to its state.
    const trouble = this.trouble.get(id);
    if (active && !running && (!trouble || trouble.paused)) {
      if (trouble) trouble.paused = false;
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
      if (changed.includes('entities')) this.entitiesChanged(id, running, entityChanges(previous?.params, state.params));
      if (JSON.stringify(state.selection ?? null) !== JSON.stringify(previous?.selection ?? null)) {
        this.guard(id, () => running.handlers.select?.(state.selection ?? null));
      }
      const revealed = state.step?.index ?? 0;
      if (revealed !== (previous?.step?.index ?? 0)) this.guard(id, () => running.handlers.step?.(revealed));
    }
  }

  /**
   * Hands entity changes to the layer (#279): at once for a set without `debounce_ms`, otherwise
   * once the set has been quiet that long, with every entity changed in between.
   */
  private entitiesChanged(id: string, running: Running, changes: EntityChange[]): void {
    const manifest = this.store.manifest(this.store.state.layers[id]?.layer ?? '');
    const now: EntityChange[] = [];
    for (const change of changes) {
      const wait = manifest?.entities?.find((s) => s.id === change.set)?.debounce_ms ?? 0;
      if (!(wait > 0)) {
        now.push(change);
        continue;
      }
      running.entities ??= new Map();
      const waiting = running.entities.get(change.set);
      if (waiting) clearTimeout(waiting.timer);
      const ids = waiting?.ids ?? new Set<string>();
      for (const one of change.ids) ids.add(one);
      const timer = setTimeout(() => {
        running.entities?.delete(change.set);
        if (!running.stopped) this.guard(id, () => running.handlers.entities?.([{ set: change.set, ids: [...ids] }]));
      }, wait);
      running.entities.set(change.set, { ids, timer });
    }
    if (now.length > 0) this.guard(id, () => running.handlers.entities?.(now));
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

  /** Whether an instance is an item of a revealing layer, so the runtime clips what it draws. */
  private revealedBy(id: string): string | null {
    const parent = this.store.state.layers[id]?.parent;
    const state = parent ? this.store.state.layers[parent] : undefined;
    return parent && state && this.store.manifest(state.layer)?.reveals ? parent : null;
  }

  /** A revealing layer set its shape: its items show only inside it. */
  private reveal(parent: string, shape: RevealShape | null): void {
    this.reveals.set(parent, shape);
    for (const id of this.store.state.scene) {
      if (this.store.state.layers[id]?.parent === parent && !this.itemReveals.has(id)) this.view.setClip(id, shape);
    }
  }

  /** The items of a layer, in the order site.json lists them. */
  private itemsOf(parent: string): string[] {
    return Object.keys(this.store.state.layers).filter((id) => this.store.state.layers[id]?.parent === parent);
  }

  /** A revealing layer gave one of its items a shape of its own, or handed it back (`undefined`). */
  private revealItem(parent: string, index: number, shape: RevealShape | null | undefined): void {
    const id = this.itemsOf(parent)[index];
    if (!id) return;
    if (shape === undefined) this.itemReveals.delete(id);
    else this.itemReveals.set(id, shape);
    if (!this.store.state.scene.includes(id)) return;
    const own = this.itemReveals.has(id) ? this.itemReveals.get(id)! : this.reveals.get(parent);
    if (own !== undefined) this.view.setClip(id, own);
  }

  private async start(id: string): Promise<void> {
    // `id` names the instance; the code comes from the layer package it runs.
    const layer = this.store.layer(id).layer;
    // An item of a Magnifier or a Reveal line is clipped to its shape, and shows nowhere until there is one.
    const revealer = this.revealedBy(id);
    this.view.setClippable(id, revealer !== null);
    if (revealer !== null && this.itemReveals.has(id)) this.view.setClip(id, this.itemReveals.get(id) ?? null);
    else if (revealer !== null && this.reveals.has(revealer)) this.view.setClip(id, this.reveals.get(revealer) ?? null);
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
      // A layer made only of a controller stage (a map or panels in layer.json, #357, #374) has nothing to draw here.
      const stageOnly = typeof manifest?.stage === 'object' && manifest.stage !== null;
      if (!module && !stageOnly) {
        console.warn(`layer '${layer}' is not part of this build`);
        this.failed(id, `the code for '${layer}' is not in this version of MR Studio`, false);
      }
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
    let edited = false;
    const extras: Omit<TableContext, keyof Base> = {
      engine: {
        open: async (kernel, params, fields, options) => {
          const stream = await engine.open(kernel, params, fields, options);
          track(() => stream.close());
          return stream;
        },
        probe: (kernel, params, at) => engine.probe(kernel, params, at),
        // What-if changes (#500) go with the layer: the baked scene comes back when it stops.
        edit: (edits) => {
          if (!edited && edits.length) {
            edited = true;
            track(() => void engine.edit([]).catch(() => {}));
          }
          return engine.edit(edits);
        },
        info: () => engine.info(),
      } as EngineClient,
      map: this.view.handle(id, track),
      model: this.view.modelHandle(id, track),
      pointer: this.view.pointer(track, id),
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
      reveal: {
        set: (shape) => {
          if (running.stopped || !manifest?.reveals) return;
          this.reveal(id, shape);
        },
        item: (index, shape) => {
          if (running.stopped || !manifest?.reveals) return;
          this.revealItem(id, index, shape);
        },
      },
      onFrame: (callback) => running.frames.push(callback),
      onCleanup: track,
    };
    if (manifest?.reveals) {
      track(() => {
        this.reveals.delete(id);
        for (const item of this.itemsOf(id)) this.itemReveals.delete(item);
      });
    }
    // The base context has live getters, so it is the prototype rather than a copy.
    // The play head (#373): the table may set it every frame; the host hears only what the other
    // views could not work out for themselves (a start, a stop, a jump, a change of pace).
    const read = playHead(store, id);
    let told: { value: number; rate: number; at: number } | null = null;
    const clock: TablePlayHead = {
      now: () => read.now(),
      get running() {
        return read.running;
      },
      set: (value, rate = 0) => {
        if (!Number.isFinite(value) || !Number.isFinite(rate) || running.stopped) return;
        const now = performance.now();
        if (told && agrees(told, value, rate, now, clockControl(store.manifest(store.state.layers[id]?.layer ?? '')))) return;
        told = { value, rate, at: now };
        this.connection.request('layer.clock', { layer: id, value, rate }).catch(() => {});
      },
    };
    const ctx: TableContext = Object.assign(Object.create(baseContext(store, this.connection, id)), extras, { clock });
    const before = { ...store.layer(id).params };
    this.starting.set(id, null);
    try {
      running.handlers = (await module.table(ctx)) ?? {};
    } catch (error) {
      const heard = this.starting.get(id);
      this.starting.delete(id);
      if (!running.stopped) {
        console.error(`[${id}] failed to start`, error);
        reportError(error, id);
        // A data problem says more than the error it led to.
        this.failed(id, heard ?? `it could not start: ${describe(error)}`);
      }
      if (this.running.get(id) === running) this.stop(id);
      this.entered(id);
      return;
    }
    const heard = this.starting.get(id);
    this.starting.delete(id);
    if (running.stopped) return;
    running.ready = true;
    // It runs, but without data it needed: it shows what it has and starts again later.
    if (heard) this.failed(id, heard);
    else this.recovered(id);
    // Entities (#279) are picked and marked by the runtime, above what the layer draws.
    if (manifest?.entities?.length) {
      entitiesOnTable({
        layer: id,
        sets: manifest.entities,
        store,
        connection: this.connection,
        map: this.view.handle(id, track),
        pointer: this.view.pointer(track, id),
        onFrame: (callback) => running.frames.push(callback),
      });
    }
    // A sound bed (#282): the layer's voices follow its params and published values, with no
    // audio code in the layer. It fades with the controller's sound switch and stops with the layer.
    if (manifest?.sound?.length) {
      const bed = new VoiceBed(manifest.sound, { audible: hearsSound() });
      track(() => bed.stop());
      running.frames.push(() => {
        const state = store.state.layers[id];
        bed.audible = hearsSound();
        bed.update({ params: state?.params ?? {}, shared: state?.shared ?? {} });
      });
    }
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
    meter.drop(id);
    for (const waiting of running.entities?.values() ?? []) clearTimeout(waiting.timer);
    for (const cleanup of running.cleanups.reverse()) this.guard(id, cleanup);
  }

  /**
   * A layer that throws must not take the table down with it. Its error reaches the app's log (#260).
   * The time it takes counts towards the layer's cost per frame (#262).
   */
  private guard(id: string, run: () => void): void {
    try {
      meter.time(id, run);
    } catch (error) {
      console.error(`[${id}]`, error);
      reportError(error, id);
    }
  }

  // ---- Trouble (#259) ---------------------------------------------------------

  /** Whether instance `id` uses the site dataset `name`: it requires it, or a setting names it. */
  private needs(id: string, name: string): boolean {
    const state = this.store.state.layers[id];
    if (!state) return false;
    if (this.store.manifest(state.layer)?.requires?.data?.includes(name)) return true;
    return Object.values(state.params).some((value) => value === name);
  }

  /** A site dataset could not be read: the layers that use it are in trouble. */
  private dataTrouble(problem: DataProblem): void {
    let claimed = false;
    // The layers that name the dataset; failing that, the one layer starting now, which must have asked.
    let users = [...new Set([...this.starting.keys(), ...this.running.keys()])].filter((id) => this.needs(id, problem.name));
    if (users.length === 0 && this.starting.size === 1) users = [...this.starting.keys()];
    for (const id of users) {
      claimed = true;
      if (this.starting.has(id)) {
        if (!this.starting.get(id)) this.starting.set(id, problem.reason);
      } else this.failed(id, problem.reason);
    }
    if (!claimed) reportError(`site data '${problem.name}': ${problem.reason}`);
  }

  /** Whether instance `id` should be on the table now. */
  private shouldRun(id: string): boolean {
    return Boolean(this.store.state.layers[id]?.active) && !this.hiddenAtRest(id);
  }

  /**
   * Instance `id` could not start or lost its data: the host hears why, and it starts again after
   * a wait that grows with each try (1 s, 2 s, 5 s, 15 s, then every minute). Without `retry` it
   * waits for Retry.
   */
  private failed(id: string, reason: string, retry = true): void {
    if (!this.shouldRun(id)) return;
    const before = this.trouble.get(id);
    // The same trouble heard twice in one try (its data, then the error it led to) counts once.
    if (before?.timer && before.reason === reason) return;
    if (before?.timer) clearTimeout(before.timer);
    const attempt = before?.attempt ?? 0;
    const wait = RETRY_S[Math.min(attempt, RETRY_S.length - 1)]!;
    const timer = retry ? setTimeout(() => this.retry(id), wait * 1000) : undefined;
    this.trouble.set(id, { reason, attempt: attempt + 1, timer });
    this.report(id, retry ? { status: 'retrying', reason, retry_in: wait } : { status: 'failed', reason });
  }

  /** Instance `id` started with everything it needed: any trouble is over. */
  private recovered(id: string): void {
    if (this.trouble.has(id)) this.forget(id, true);
  }

  /** Forgets the trouble of instance `id`; with `tell`, tells the host it runs again. */
  private forget(id: string, tell: boolean): void {
    const trouble = this.trouble.get(id);
    if (!trouble) return;
    if (trouble.timer) clearTimeout(trouble.timer);
    this.trouble.delete(id);
    if (tell) this.report(id, null);
  }

  /** Starts a layer in trouble again. */
  private retry(id: string): void {
    const trouble = this.trouble.get(id);
    if (!trouble) return;
    trouble.timer = undefined;
    if (!this.shouldRun(id)) {
      // Hidden for now: it tries again as soon as it is shown.
      trouble.paused = true;
      this.report(id, { status: 'retrying', reason: trouble.reason });
      return;
    }
    this.stop(id);
    void this.start(id);
  }

  /** Retry, from the editor or the controller: the next try is now. */
  private retryNow(id: string): void {
    const trouble = this.trouble.get(id);
    if (!trouble) return;
    if (trouble.timer) clearTimeout(trouble.timer);
    this.retry(id);
  }

  /** Tells the host how instance `id` is doing: in trouble, or (null) running. */
  private report(id: string, health: LayerHealth | null): void {
    const p = health ? { layer: id, ...health } : { layer: id, status: 'running' };
    this.connection.request('layer.health', p).catch(() => {});
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
