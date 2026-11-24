import type { ServiceClient } from './service.ts';
import type { PointerSample } from './blocks/interaction.ts';
import type { Colormap } from './colormap.ts';
import type { EngineClient } from './engine.ts';
import type { ModelHandle } from './model.ts';
import type { FieldFrame, LayerManifest, Params, SiteInfo, StepState, ToolGeometry, ToolInput } from './types.ts';

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

/** What a layer may draw on the table. Everything sits at the layer's place in the scene's draw order. */
export interface MapHandle {
  addField(id: string, style: FieldOverlayStyle & { colormap: Colormap }): FieldOverlay;
  addFlow(id: string, style: FlowOverlayStyle & { colormap: Colormap }): FlowOverlay;
  addShapes(id: string, style?: { opacity?: number }): ShapeOverlay;
  /**
   * An element covering the table, above everything the scene draws, for decorations a layer draws itself
   * (a sun path, a compass). It ignores pointer input and is removed with the layer.
   * The table's up direction is `site.extent.rotation_deg`.
   */
  addElement(): HTMLElement;
  /** A drawing in table metres at the layer's place in the scene. For layers that draw shapes or sprites themselves: base maps, ambient animation, media. */
  addDrawing(id: string, options?: { opacity?: number; /** Canvas width in pixels. Default 2048. */ resolution?: number }): DrawingOverlay;
  /** A canvas above the scene, in CSS pixels, with a projection from WGS84. */
  addCanvas(id: string, style?: { opacity?: number }): CanvasOverlay;
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
  /**
   * One of the site's outside services (#278), by its id in site.json `services`: `get`, `post`
   * and `job`, through the host. Name it in `requires.services`. While a call runs, publish
   * `busy: { label, progress }` and the controller shows it under the layer's name.
   */
  service(id: string): ServiceClient;
}

export interface TableContext<P = Params> extends ContextBase<P> {
  readonly engine: EngineClient;
  readonly map: MapHandle;
  /** The digital twin of the physical model: fields, lights and materials on its real surfaces. */
  readonly model: ModelHandle;
  readonly pointer: TablePointer;
  /**
   * Sends a tool input through the host, as a phone does, for one of the layer's own tools.
   * Every view of the table running the layer (the projector, the editor) gets it in
   * `tool(input)`, so a pick made with the mouse on one view shows on all of them.
   * Resolves once the host has accepted it.
   */
  sendTool(tool: string, geometry: ToolGeometry): Promise<void>;
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
  /** An action control was pressed. */
  action?(action: string): void;
  /** A spatial input arrived. */
  tool?(input: ToolInput): void;
  /** Next or Previous changed how many sub-steps are revealed (`ctx.steps.revealed`). */
  step?(revealed: number): void;
}

/**
 * Sub-steps (docs/contracts/present.md, Steps). A layer that reveals its parts one at a
 * time declares how many there are when it starts; the controller's Next then walks them,
 * and inside a slideshow moves on to the next slide after the last one (or stops there,
 * as the slide's Next behaviour says).
 */
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
   * `ctx.setParams`. `ctx.panel` is `"hero"`. The element is as wide as the centre; the hero sets its height.
   */
  hero?(ctx: PanelContext<P>, el: HTMLElement): PanelHandlers | void;
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
