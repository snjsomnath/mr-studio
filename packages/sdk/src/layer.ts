import type { ServiceClient } from './service.ts';
import type { PointerSample } from './blocks/interaction.ts';
import type { Colormap } from './colormap.ts';
import type { EngineClient } from './engine.ts';
import type { ModelHandle } from './model.ts';
import type { LayerReveal } from './reveal.ts';
import type { EntityChange, EntitySelection, FieldFrame, LayerManifest, Params, Sender, SiteInfo, StepState, ToolGeometry, ToolInput } from './types.ts';

export interface FieldOverlayStyle {
  colormap?: Colormap;
  /** 0..1, multiplied with the colormap's own alpha. */
  opacity?: number;
  /** Interpolate between cells. Default true. */
  smooth?: boolean;
  /** Blur radius in cells, for soft edges such as shadow penumbras. Default 0. */
  soften?: number;
  /** Seconds over which a new frame eases in, so stepped results move smoothly. Quantised frames only. Default 0. */
  glide?: number;
}

/** A field drawn on the table. The frame is uploaded as a texture and coloured on the GPU. */
export interface FieldOverlay {
  set(frame: FieldFrame): void;
  setStyle(style: FieldOverlayStyle): void;
  remove(): void;
}

/**
 * A 2D drawing stretched over the table, inside the scene's draw order. The context is scaled so that one
 * unit is one metre: x runs right from 0 to `width`, y runs down from 0 to `height`.
 * Use `tableSpace(ctx.site)` to turn WGS84 coordinates into these metres.
 */
export interface DrawingOverlay {
  readonly ctx: CanvasRenderingContext2D;
  /** Table width and height in metres. */
  readonly width: number;
  readonly height: number;
  /** Canvas pixels per metre, for line widths that should stay crisp. */
  readonly scale: number;
  /** Erases everything. */
  clear(): void;
  /** Puts what was drawn since the last commit on the table. */
  commit(): void;
  setOpacity(opacity: number): void;
  remove(): void;
}

export interface FlowOverlayStyle {
  /** Colours tracers by the local magnitude of the field. */
  colormap?: Colormap;
  /** The magnitude at the top of the colormap. Default: the frames' `max`. */
  max?: number;
  /**
   * `ribbons` are steady streamlines with a light travelling along them, `particles` fine specks with short tails,
   * `droplets` glowing drops with longer trails that land anywhere on the flow, like rain on running water. Default `ribbons`.
   */
  mode?: 'ribbons' | 'particles' | 'droplets';
  /** Number of particles; ribbons use an eighth as many streamlines. Default 500. */
  count?: number;
  /** Share of the extent's longer side a tracer travels per second, per field unit. Default 0.04. */
  rate?: number;
  /** 0..1, multiplied with the colormap's own alpha. */
  opacity?: number;
  /** Lights building faces where the flow blows straight at them (needs `setFacades`). Default false. */
  facadeGlow?: boolean;
  /** Speeds below this, in field units, draw nothing. Default 0.08. */
  still?: number;
}

/** A vector field drawn on the table as moving tracers. Animation and drawing run on the surface. */
export interface FlowOverlay {
  /** The two components of the same revision, towards the right and towards the bottom of the table. Cells where both are zero are obstacles. */
  set(u: FieldFrame, v: FieldFrame): void;
  setStyle(style: FlowOverlayStyle): void;
  /** Building outlines for the facade glow: polygons of rings, outer ring first, in table metres. */
  setFacades(polygons: [number, number][][][]): void;
  remove(): void;
}

/**
 * A 2D canvas locked to the table, for vector drawing: networks, routes, moving markers.
 * It sits above the fields and the building outlines; canvases stack in the order they are added.
 */
export interface CanvasOverlay {
  /** Scaled so one unit is one CSS pixel. */
  readonly context: CanvasRenderingContext2D;
  /** Size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Table pixels per site metre, so marks can keep a physical size. */
  readonly pixelsPerMetre: number;
  /** Raised whenever the size or the view changes. The canvas is blank afterwards: draw again. */
  readonly revision: number;
  /** WGS84 `[lon, lat]` to canvas pixels. */
  project(lonLat: readonly [number, number] | readonly number[]): [number, number];
  clear(): void;
  setOpacity(opacity: number): void;
  remove(): void;
}

/** A point, line or area drawn on the table. */
export interface Shape {
  geometry: ToolGeometry;
  /** CSS colour. Default white. */
  colour?: string;
}

/** Vector shapes drawn on the table, above the fields. */
export interface ShapeOverlay {
  /** Replaces everything the overlay shows. */
  set(shapes: Shape[]): void;
  setOpacity(opacity: number): void;
  remove(): void;
}

/** A picture a sprite overlay stamps: drawn once by the layer, at any size. */
export type SpriteImage = HTMLCanvasElement | HTMLImageElement | ImageBitmap | OffscreenCanvas;

/** Numbers per sprite in the buffer given to `SpriteOverlay.set`. */
export const SPRITE_FLOATS = 7;

export interface SpriteStyle {
  opacity?: number;
  /** `add` adds the sprites' light to what is below (glows, lamps); `over` paints them on it. Default `over`. */
  blend?: 'over' | 'add';
}

/**
 * Many small pictures moving on the table, stamped by the graphics card in one draw (#609): lights
 * flowing along streets, cars, people, tree crowns. Give it every sprite each time they move; it
 * costs a small buffer upload, not a picture of the whole table, so use it rather than a drawing for
 * anything that moves every frame.
 */
export interface SpriteOverlay {
  /**
   * Shows `count` sprites (default: all in `sprites`), `SPRITE_FLOATS` numbers each: centre x and y
   * in table metres, width and height in metres, angle in radians (clockwise, as a canvas's
   * `rotate`), the index of its picture, and its alpha (0 to 1; 0 hides it).
   */
  set(sprites: Float32Array, count?: number): void;
  /** Replaces the pictures, keeping their indices' meaning up to the layer. */
  setImages(images: SpriteImage[]): void;
  setOpacity(opacity: number): void;
  remove(): void;
}

/** One line for a stroke overlay: points in table metres, with a width (metres) and alpha per point or for all. */
export interface Stroke {
  points: [number, number][];
  /** A CSS hex or rgb() colour. */
  colour: string;
  width: number | number[];
  alpha: number | number[];
}

/**
 * Lines that change every frame (trails behind vehicles, wakes), drawn by the graphics card (#609).
 * Each line is one strip with its width and alpha per point, so a tapering trail needs no pieces.
 */
export interface StrokeOverlay {
  /** Replaces every line the overlay shows. */
  set(strokes: Stroke[]): void;
  setOpacity(opacity: number): void;
  remove(): void;
}

/** What a layer may draw on the table. Everything sits at the layer's place in the scene's draw order. */
export interface MapHandle {
  addField(id: string, style: FieldOverlayStyle & { colormap: Colormap }): FieldOverlay;
  addFlow(id: string, style: FlowOverlayStyle & { colormap: Colormap }): FlowOverlay;
  addShapes(id: string, style?: { opacity?: number }): ShapeOverlay;
  /** Sprites stamped from `images` on the graphics card: see `SpriteOverlay`. */
  addSprites(id: string, images: SpriteImage[], style?: SpriteStyle): SpriteOverlay;
  /** Moving lines drawn on the graphics card: see `StrokeOverlay`. */
  addStrokes(id: string, style?: { opacity?: number }): StrokeOverlay;
  /**
   * An element covering the table, above everything the scene draws, for decorations a layer draws itself
   * (a sun path, a compass). It ignores pointer input and is removed with the layer.
   * The table's up direction is `site.extent.rotation_deg`.
   */
  addElement(): HTMLElement;
  /**
   * A drawing in table metres at the layer's place in the scene, for what a layer draws itself: base maps,
   * media, glows that change only with the controls. Each `commit` sends the whole picture to the graphics
   * card, so draw anything that moves every frame with `addSprites` instead (#609).
   */
  addDrawing(id: string, options?: { opacity?: number; /** Canvas width in pixels. Default 2048. */ resolution?: number }): DrawingOverlay;
  /**
   * A canvas above the scene, in CSS pixels, with a projection from WGS84. With `top` it stays
   * above the other canvases, the layer's own items included, as the Magnifier's glass must (#554).
   */
  addCanvas(id: string, style?: { opacity?: number; top?: boolean }): CanvasOverlay;
  /**
   * What the table shows, for a magnifier (#287): ask for a rectangle of the table view and it is
   * copied at the next frame, with everything drawn there except this layer's own canvases.
   */
  addPicture(): TablePicture;
  /**
   * Lets a magnifier ask this layer for a sharp picture of part of the table (#351), drawn again
   * at the magnifier's resolution rather than copied from the screen. `render` draws in table
   * metres into `g`, whose transform already maps them to its pixels; `scale` is pixels per metre.
   */
  addDetail(render: (g: CanvasRenderingContext2D, scale: number) => void): void;
  /**
   * What the ambient glow in the projector's blank space does while this layer is on (#476):
   * `'off'` turns it off, a colour such as `'#ffb347'` fixes it, `null` gives it back the model's
   * own colours. The most recent layer to ask wins. Nothing happens on a table without the glow.
   */
  setGlow(glow: 'off' | string | null): void;
  /**
   * A sharp picture of the square of side `2 * radius_m` around `centre` (table metres), `size`
   * pixels across, from every other layer that draws one (`addDetail`), in the scene's order.
   * Null when no layer on the table draws one.
   */
  detail(centre: [number, number], radius_m: number, size: number): HTMLCanvasElement | null;
}

/** A rectangle in the table view's CSS pixels, as `CanvasOverlay` uses them. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A copy of part of what the table shows (`ctx.map.addPicture()`), for drawing it larger.
 * `want` asks for a rectangle; the copy lands in `canvas` when the table next draws, at the
 * screen's own pixel density, and `taken` says which rectangle it holds.
 */
export interface TablePicture {
  want(rect: PixelRect): void;
  readonly canvas: HTMLCanvasElement;
  /** The rectangle `canvas` holds now, or null before the first copy. */
  readonly taken: PixelRect | null;
  /** Raised with every copy. */
  readonly revision: number;
  remove(): void;
}

/**
 * Pointers acting directly on the table surface: a mouse, a finger, a pen. Samples are
 * local to the table and never pass through the host; a layer sends on what other
 * surfaces need with `setParams` or `publish`. Phone tools arrive through `tool(input)`
 * and become the same samples with `fromToolInput`.
 */
export interface TablePointer {
  /** Calls back for every sample while the layer is on. Released with the layer. */
  on(callback: (sample: PointerSample) => void): void;
}

/**
 * A picture a layer's table sends to its own controller (#351): the Magnifier's view under its
 * glass. The table sends it, the hero on the controller watches it. The latest picture only.
 */
export interface LayerView {
  /** On the table: sends what `canvas` holds now. Sends are spaced out, so calling it every frame is fine. */
  send(canvas: HTMLCanvasElement | OffscreenCanvas): void;
  /** On the controller: calls back with each new picture until the returned function is called. */
  watch(callback: (picture: ImageBitmap) => void): () => void;
}

interface ContextBase<P> {
  readonly site: SiteInfo;
  /** Current params, as held by the host. */
  readonly params: Readonly<P>;
  /** Asks the host to change params. The `update` handler runs once the host has applied them. */
  setParams(patch: Partial<P>): void;
  /** Values the table published for other surfaces. */
  readonly shared: Readonly<Record<string, any>>;
  /** The language visitors read now (#80): `en` or `sv`. */
  readonly language: string;
  /**
   * Words for visitors in their language (#80): the English text looked up in the layer's
   * `locales/<language>.json`, with `{name}` filled from `vars`. `ctx.say('Sun sets at {time}', { time })`.
   * Use it for text the layer makes as it runs (a caption, a status, a legend row); words in
   * layer.json are translated without it.
   */
  say(text: string, vars?: Record<string, string | number>): string;
  /** A picture the table sends to the layer's controller (#351). */
  readonly view: LayerView;
  /**
   * One of the site's outside services (#278), by its id in site.json `services`: `get`, `post`
   * and `job`, through the host. Name it in `requires.services`. While a call runs, publish
   * `busy: { label, progress }` and the controller shows it under the layer's name.
   */
  service(id: string): ServiceClient;
  /**
   * The entity picked on the table or the controller (#279), the same on every surface, or null.
   * Entities are declared in layer.json `entities`; the runtime picks them on the table and
   * shows the picked one's controls on the controller without layer code.
   */
  readonly selection: EntitySelection | null;
  /** Picks an entity, or none with null, for every surface: the controller shows its controls. */
  select(set: string, id: string | null): void;
  /** One entity's values: its controls' defaults with what was set for it on top. */
  entity(set: string, id: string): Record<string, unknown>;
  /**
   * Changes the values of one or more entities through the host, which checks them against the
   * set's controls. `null` puts them back to the defaults.
   */
  setEntity(set: string, ids: string | string[], values: Record<string, unknown> | null): void;
  /**
   * Sends a tool input through the host, as a phone does, for one of the layer's own tools.
   * Every view of the table running the layer (the projector, the editor) gets it in
   * `tool(input)`, so a pick made with the mouse on one view, or on a controller map (#283),
   * shows on all of them. Resolves once the host has accepted it.
   */
  sendTool(tool: string, geometry: ToolGeometry): Promise<void>;
  /**
   * Presses one of the layer's actions through the host: an `action` control, or one of the
   * named `actions` in layer.json that have no button of their own (#283). Every view of the
   * table gets it in `action(id)`, so a controller stage can start an animation on the table.
   */
  action(id: string): Promise<void>;
  /**
   * The layer's play head (#373), the same on every view: where its time is now, in the units of
   * its `clock: hour` or `clock: progress` control, moving between the table's updates.
   */
  readonly clock: LayerPlayHead;
}

/** A layer's play head as every view reads it (#373). */
export interface LayerPlayHead {
  /**
   * The layer's time now, in its clock control's units: the play head while it runs (a time of day
   * wraps at midnight, a run stops at its end), otherwise the control as set. Null for a layer
   * without a `clock: hour` or `clock: progress` control.
   */
  now(): number | null;
  /** It moves on its own: the table set a rate other than 0. */
  readonly running: boolean;
}

/** The table's side of the play head (#373): it moves it, and every view follows. */
export interface TablePlayHead extends LayerPlayHead {
  /**
   * Where the time is now and how many of the control's units a second it moves (0, the default,
   * stands still). Call it every frame if that is easiest: every view works out the time in
   * between, so it is sent on only when play starts, stops, jumps or changes pace.
   */
  set(value: number, rate?: number): void;
}

export interface TableContext<P = Params> extends ContextBase<P> {
  readonly engine: EngineClient;
  readonly map: MapHandle;
  /** The digital twin of the physical model: fields, lights and materials on its real surfaces. */
  readonly model: ModelHandle;
  readonly pointer: TablePointer;
  /** The play head: the table moves it with `set`, and every view reads it (#373). */
  readonly clock: TablePlayHead;
  /**
   * Plays the attention cue (#105) at a change, in WGS84: one bright burst that pulls eyes back
   * to the table. Tool inputs from a phone or the controller get one without any code; call this
   * when an action without a place of its own adds something (a controller button that adds a
   * building, say). `colour` is a CSS colour, default white.
   */
  cue(at: ToolGeometry, options?: { colour?: string }): void;
  /** Publishes derived values for panels. Only changed keys are sent. */
  publish(values: Record<string, unknown>): void;
  /** Sub-steps: parts of the layer that Next reveals one at a time, such as the categories of a map. */
  readonly steps: LayerSteps;
  /** The legend on the controller's stage, when it changes as the layer runs. */
  readonly legend: LayerLegend;
  /**
   * For a layer whose layer.json says `reveals: true` (the Magnifier, the Reveal line): where its
   * items show on the table. The runtime clips everything the items draw to the shape. Other
   * layers' calls do nothing.
   */
  readonly reveal: LayerReveal;
  /**
   * The layers inside this one (#453), in site.json order, as they are now: read it when you
   * need it (it is live). A layer that draws something an item may also draw, such as Wind's
   * faint tree crowns under a Trees item, can leave its own out while that item is on (#623).
   */
  readonly items: readonly LayerItem[];
  /** Runs every animation frame while the layer is active. `dt` is seconds since the last call. */
  onFrame(callback: (dt: number) => void): void;
  /** Registers cleanup to run when the layer is turned off. */
  onCleanup(callback: () => void): void;
}

export interface PanelContext<P = Params> extends ContextBase<P> {
  /** The id of the `custom` panel being drawn, from the manifest's `panels`. */
  readonly panel: string;
  onCleanup(callback: () => void): void;
}

export interface TableHandlers {
  /** Params changed. `changed` lists the keys; `ctx.params` holds the new values. Must be cheap. */
  update?(changed: string[]): void;
  /** An action control was pressed; `by` is the phone that pressed it, if a phone did (#335). */
  /** `words`: what was typed with the press, for an action that asks for words (#462). */
  action?(action: string, by?: Sender, words?: string): void;
  /** A spatial input arrived. */
  tool?(input: ToolInput): void;
  /** Next or Previous changed how many sub-steps are revealed (`ctx.steps.revealed`). */
  step?(revealed: number): void;
  /**
   * Entities' values changed (#279), from the controller, a phone or the editor: which ones, by
   * set. Read them with `ctx.entity(set, id)`. Waits for the set's `debounce_ms` of quiet, so a
   * layer that asks a model on every change asks once per gesture.
   */
  entities?(changed: EntityChange[]): void;
  /** Another entity was picked, or none (`ctx.selection`). The runtime marks it on the table itself. */
  select?(selection: EntitySelection | null): void;
}

/**
 * Sub-steps (docs/contracts/present.md, Steps). A layer that reveals its parts one at a
 * time declares how many there are when it starts; the controller's Next then walks them,
 * and inside a slideshow moves on to the next slide after the last one (or stops there,
 * as the slide's Next behaviour says).
 */
/** A layer inside another one (#453): its instance id, the layer it uses and whether it is on. */
export interface LayerItem {
  readonly id: string;
  /** The layer it is an instance of, such as `trees` or `custom:aerial-1960`. */
  readonly use: string;
  readonly active: boolean;
}

export interface LayerSteps {
  /** Declares `count` sub-steps, with a name for each for the controller. 0 removes them. */
  define(count: number, titles?: string[]): void;
  /** How many sub-steps are revealed now: 0 (the overview) to the count. */
  readonly revealed: number;
  /** The layer's steps as the host has them: a sequence's current step, or the sub-steps it defined. */
  readonly state: StepState | undefined;
}

/**
 * The controller's legend (docs/contracts/present.md, Stage). Without it the controller
 * shows `legend` from layer.json. Rows are matched by `id`, or by label when they have none,
 * and rows named in `steps.define` titles follow the reveal by themselves.
 */
export interface LayerLegend {
  /** Replaces the rows. An empty list goes back to layer.json's legend. */
  set(items: LegendRow[]): void;
  /** Marks the row just revealed on the table, or none. */
  highlight(id: string | null): void;
  /** Shows only these rows at full strength, for cumulative reveals; `'all'` shows every row. */
  show(ids: string[] | 'all'): void;
}

export interface LegendRow {
  id?: string;
  label: string;
  color?: string;
  shape?: 'line' | 'fill' | 'point' | string;
  /** A heading over this row and the ones after it with the same group (#622): which scale the rows belong to. */
  group?: string;
}

export interface PanelHandlers {
  /** Params or shared values changed. */
  update?(): void;
}

export interface LayerModule<P = Params> {
  manifest: LayerManifest;
  /**
   * Runs on the table surface when the layer is turned on. Set up overlays and
   * engine streams, and return the handlers. Everything opened through `ctx`
   * is released when the layer is turned off; use `ctx.onCleanup` for the rest.
   */
  table?(ctx: TableContext<P>): TableHandlers | void | Promise<TableHandlers | void>;
  /**
   * Draws the layer's `custom` panels on the TV. Most panels need no code: declare them
   * in the manifest's `panels`. The element has a fixed size and clips what does not fit.
   */
  panel?(ctx: PanelContext<P>, el: HTMLElement): PanelHandlers | void;
  /**
   * Draws the layer's hero on the controller: the one large, direct way to work the layer, at the
   * top of the open layer (Sunlight's sky and time scrubber). It may change params with
   * `ctx.setParams`. `ctx.panel` is `"hero"`. The element is as wide as the centre; the hero sets its height,
   * times the CSS variable `--mrs-hero-scale` (1, or less inside a slideshow step, #577):
   * `height: calc(clamp(16rem, 40vh, 30rem) * var(--mrs-hero-scale, 1))`.
   */
  hero?(ctx: PanelContext<P>, el: HTMLElement): PanelHandlers | void;
  /**
   * Draws the layer's own stage on the controller (#283), for a layer.json with `stage: "custom"`:
   * the whole centre under the layer's name, such as a map of the site to choose on. The rails, the
   * step strip and the layer's controls stay. Reach the table through the host: `ctx.sendTool`,
   * `ctx.action`, `ctx.setParams`, `ctx.select`. `controllerMap` gives a ready map of the site.
   * `ctx.panel` is `"stage"`.
   */
  stage?(ctx: PanelContext<P>, el: HTMLElement): PanelHandlers | void;
  /**
   * The layer's own widgets (#353), made with `defineWidget`. They are known on the site as
   * `<layer id>/<type>`, and the layer's own panels may name them by `type` alone. They follow the
   * core widgets' contract: sizes, labelled props, bindings, theme tokens and an honest read cost.
   */
  widgets?: import('./widgets.ts').WidgetDefinition[];
  /**
   * Fetches what the layer will need before it is shown, so a sequence (the slideshow) can step
   * to it without waiting. Called on the table when a sequence that shows this layer opens, with
   * the params the step will use. What the host fetches it also keeps, for venues without a
   * connection (#42). Errors are ignored: the layer shows its own when it is turned on.
   */
  prefetch?(site: SiteInfo, params: P): Promise<void> | void;
}

/** Declares a layer. The default export of every layer package. */
export function defineLayer<P = Params>(layer: LayerModule<P>): LayerModule<P> {
  return layer;
}
