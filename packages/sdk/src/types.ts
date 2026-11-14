// Shared types. These mirror docs/contracts/*.md; change them together.

export const PROTOCOL = 1;
export const LAYER_API = 1;

export type Role = 'table' | 'tv' | 'phone' | 'dev';

// ---- Layer manifest -------------------------------------------------------

interface ControlBase {
  id: string;
  label: string;
  /** Phone participants may change it. */
  phone?: boolean;
  /** Show only while other controls have these values. */
  visibleWhen?: Record<string, unknown>;
}
export interface RangeControl extends ControlBase {
  type: 'range';
  min: number;
  max: number;
  step?: number;
  unit?: string;
  default: number;
}
export interface SelectControl extends ControlBase {
  type: 'select';
  options: { value: string; label: string }[];
  default: string;
}
export interface ToggleControl extends ControlBase {
  type: 'toggle';
  default: boolean;
}
export interface DateControl extends ControlBase {
  type: 'date';
  default: string;
}
export interface ColorControl extends ControlBase {
  type: 'color';
  default: string;
}
export interface TextControl extends ControlBase {
  type: 'text';
  default: string;
}
export interface ActionControl extends ControlBase {
  type: 'action';
}
export type Control = RangeControl | SelectControl | ToggleControl | DateControl | ColorControl | TextControl | ActionControl;

export interface ToolSpec {
  id: string;
  type: 'point' | 'line' | 'polygon';
  label?: string;
}

/** Palette groups in the scene composer. */
export type LayerCategory = 'base' | 'ambient' | 'analysis' | 'media';

export interface LayerManifest {
  api: number;
  id: string;
  name: string;
  description?: string;
  icon?: string;
  /** Where the composer's palette lists the layer. Default `analysis`. */
  category?: LayerCategory;
  requires?: { kernels?: string[]; data?: string[]; services?: string[] };
  controls?: Control[];
  tools?: ToolSpec[];
  /** TV panels the layer contributes while it is on. Rules in docs/contracts/dashboard.md. */
  panels?: PanelSpec[];
}

// ---- TV panels ------------------------------------------------------------
// The shapes only. The rules (grid, budget, widgets) live in @mrstudio/dashboard.

/** The closed set of panel sizes on the TV grid. */
export type PanelSize = 'chip' | 'tile' | 'wide' | 'tall' | 'block' | 'hero' | 'band' | 'strip';

/** A live value: `params.<control>`, `shared.<key>` or `site.<field>` of the panel's layer. */
export interface Binding {
  bind: string;
}

/** One panel: a widget of a fixed size. Plain JSON, so an editor can write it. */
export interface PanelSpec {
  /** Unique within the layer or page. */
  id: string;
  /** A widget type from the registry: `stat`, `bars`, `series`, `ramp`, `timeline`, `text`, `custom`. */
  widget: string;
  size: PanelSize;
  title?: string;
  /** The widget's props. Values may be literals or bindings, as the widget's schema allows. */
  props?: Record<string, unknown>;
  /** Show only while the layer's params have these values. */
  visibleWhen?: Record<string, unknown>;
  /** Higher is placed first by the automatic layout. Default 0. */
  priority?: number;
  /** Fixed position on the grid, 1-based. Only in a site's pages; layers never choose positions. */
  at?: { col: number; row: number };
  /** In a site's pages: the layer whose params and shared values the bindings read. */
  layer?: string;
}

/** `tv` in site.json. */
export interface TvConfig {
  layout?: string;
  /** Where the controls sit. Default `left`. */
  rail?: 'left' | 'right' | 'none';
  /** Style tokens the site overrides. */
  theme?: Record<string, string>;
  /** Hand-made pages. Without them the active layers' panels are laid out automatically. */
  pages?: { id: string; title?: string; panels: PanelSpec[] }[];
  /** Seconds each page stays up when there is more than one. Default 12. */
  rotate_s?: number;
}

// ---- Site and session -----------------------------------------------------

export interface Grid {
  width: number;
  height: number;
  cell_m: number;
  rotation_deg: number;
}

export interface SiteInfo {
  id: string;
  name: string;
  origin: { lon: number; lat: number };
  extent: { width_m: number; height_m: number; rotation_deg: number };
  grid: Grid;
  /** Extent corners as [lon, lat]: top left, top right, bottom right, bottom left. */
  corners: [[number, number], [number, number], [number, number], [number, number]];
  timezone: string | null;
  table: { width_cm: number; height_cm: number; tile_cm?: number } | null;
  basemap: { background: string; style: string | null };
  branding: { title: string | null; logo: string | null };
  /** Datasets layers may read, by name: site-relative paths served under `/site/`. */
  data: Record<string, string>;
  tv?: TvConfig | null;
}

export type Params = Record<string, unknown>;

export interface LayerState {
  /** The layer package this instance runs. */
  layer: string;
  active: boolean;
  /** How strongly the layer is drawn on the table, 0 to 2. 1 is as the layer intends. Applied by the runtime. */
  intensity: number;
  params: Params;
  shared: Record<string, unknown>;
}

export interface Participant {
  /** The surface in the slot. It changes when the phone reconnects; the slot does not. */
  surface: number;
  slot: number;
  colour: string;
  /** False while the slot is held for a phone that dropped. */
  connected: boolean;
}

export interface SessionState {
  protocol: number;
  /** `join_url` is what the TV's QR code points at; null when phones cannot reach the host. */
  session: { id: string; code: string; port: number; join_url: string | null };
  site: SiteInfo;
  /** Layer instance ids in draw order, bottom first. */
  scene: string[];
  /** By instance id, which is the layer id unless site.json names the entry. */
  layers: Record<string, LayerState>;
  participants: Participant[];
}

/** A `[lon, lat]` position in WGS84. */
export type Position = [number, number];

/** The GeoJSON geometry a tool produces: `Point` for point, `LineString` for line, `Polygon` for polygon. */
export type ToolGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'Polygon'; coordinates: Position[][] };

export interface ToolInput {
  layer: string;
  tool: string;
  /** Checked by the host: the tool's kind, in WGS84, polygon rings closed. */
  geometry: ToolGeometry;
  /** The surface that sent it. */
  from: number;
  /** Present when it came from a phone. */
  participant?: { slot: number; colour: string };
}

// ---- Engine ---------------------------------------------------------------

export interface FieldFrame {
  stream: number;
  /** Index into the stream's `fields`. */
  field: number;
  width: number;
  height: number;
  revision: number;
  min: number;
  max: number;
  progress: number;
  /** Quantised over [min, max] when Uint8Array. Row-major, row 0 at the top. */
  data: Uint8Array | Float32Array;
}

export interface StreamStatus {
  stream: number;
  state: 'running' | 'done';
  progress: number;
  revision: number;
  info: Record<string, any>;
}
