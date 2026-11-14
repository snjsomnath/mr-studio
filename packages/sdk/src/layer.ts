import type { PointerSample } from './blocks/interaction.ts';
import type { Colormap } from './colormap.ts';
import type { EngineClient } from './engine.ts';
import type { ModelHandle } from './model.ts';
import type { FieldFrame, LayerManifest, Params, SiteInfo, ToolGeometry, ToolInput } from './types.ts';

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

export interface FlowOverlayStyle {
  /** Colours tracers by the local magnitude of the field. */
  colormap?: Colormap;
  /** The magnitude at the top of the colormap. Default: the frames' `max`. */
  max?: number;
  /** `ribbons` are long tapering trails, `particles` short streaks. Default `ribbons`. */
  mode?: 'ribbons' | 'particles';
  /** Number of tracers. Default 500. */
  count?: number;
  /** Share of the extent's longer side a tracer travels per second, per field unit. Default 0.04. */
  rate?: number;
  /** 0..1, multiplied with the colormap's own alpha. */
  opacity?: number;
}

/** A vector field drawn on the table as moving tracers. Animation and drawing run on the surface. */
export interface FlowOverlay {
  /** The two components of the same revision, towards the right and towards the bottom of the table. Cells where both are zero are obstacles. */
  set(u: FieldFrame, v: FieldFrame): void;
  setStyle(style: FlowOverlayStyle): void;
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

/** What a layer may draw on the table. */
export interface MapHandle {
  addField(id: string, style: FieldOverlayStyle & { colormap: Colormap }): FieldOverlay;
  addFlow(id: string, style: FlowOverlayStyle & { colormap: Colormap }): FlowOverlay;
  addShapes(id: string, style?: { opacity?: number }): ShapeOverlay;
  /**
   * An element covering the table, above the fields, for decorations a layer draws itself
   * (a sun path, a compass). It ignores pointer input and is removed with the layer.
   * The table's up direction is `site.extent.rotation_deg`.
   */
  addElement(): HTMLElement;
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
}

export interface TableContext<P = Params> extends ContextBase<P> {
  readonly engine: EngineClient;
  readonly map: MapHandle;
  /** The digital twin of the physical model: fields, lights and materials on its real surfaces. */
  readonly model: ModelHandle;
  readonly pointer: TablePointer;
  /** Publishes derived values for panels. Only changed keys are sent. */
  publish(values: Record<string, unknown>): void;
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
}

/** Declares a layer. The default export of every layer package. */
export function defineLayer<P = Params>(layer: LayerModule<P>): LayerModule<P> {
  return layer;
}
