import type { Colormap } from './colormap.ts';
import type { EngineClient } from './engine.ts';
import type { FieldFrame, LayerManifest, Params, SiteInfo, ToolInput } from './types.ts';

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

/** What a layer may draw on the table. */
export interface MapHandle {
  addField(id: string, style: FieldOverlayStyle & { colormap: Colormap }): FieldOverlay;
  /**
   * An element covering the table, above the fields, for decorations a layer draws itself
   * (a sun path, a compass). It ignores pointer input and is removed with the layer.
   * The table's up direction is `site.extent.rotation_deg`.
   */
  addElement(): HTMLElement;
  addCanvas(id: string, style?: { opacity?: number }): CanvasOverlay;
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
  /** Publishes derived values for panels. Only changed keys are sent. */
  publish(values: Record<string, unknown>): void;
  /** Runs every animation frame while the layer is active. `dt` is seconds since the last call. */
  onFrame(callback: (dt: number) => void): void;
  /** Registers cleanup to run when the layer is turned off. */
  onCleanup(callback: () => void): void;
}

export interface PanelContext<P = Params> extends ContextBase<P> {
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
  /** Optional TV panel, mounted while the layer is on. */
  panel?(ctx: PanelContext<P>, el: HTMLElement): PanelHandlers | void;
}

/** Declares a layer. The default export of every layer package. */
export function defineLayer<P = Params>(layer: LayerModule<P>): LayerModule<P> {
  return layer;
}
