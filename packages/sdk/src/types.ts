// Shared types. These mirror docs/contracts/*.md; change them together.

export const PROTOCOL = 1;
export const LAYER_API = 1;

/** `guide` is the guide's phone (#98): it drives tours and reads their notes. */
export type Role = 'table' | 'tv' | 'phone' | 'dev' | 'guide';

// ---- Layer manifest -------------------------------------------------------

interface ControlBase {
  id: string;
  label: string;
  /** Phone participants may change it. Default: true for a `primary` control, false otherwise (#335). */
  phone?: boolean;
  /** Show only while other controls have these values. */
  visibleWhen?: Record<string, unknown>;
  /**
   * How prominent it is on the controller (docs/contracts/present.md): `primary` controls are large and
   * come first, `secondary` (the default) sit in a row under them, `more` wait behind "More settings".
   * `state` is never shown: a value the layer keeps for itself in its params, so every surface
   * shares it, such as where a video is (#194).
   */
  tier?: 'primary' | 'secondary' | 'more' | 'state';
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
  /** Days offered as one-tap choices: `MM-DD` in the year shown, or `today`. */
  presets?: { label: string; value: string }[];
}
export interface ColorControl extends ControlBase {
  type: 'color';
  default: string;
}
export interface TextControl extends ControlBase {
  type: 'text';
  default: string;
  /**
   * The value is the id of a source from the Sources manager (#41) of one of these kinds
   * (`vasttrafik`, `lantmateriet`, `mapbox`, `carto`, `wms`, `wmts`, `arcgis`, `tiles`). The
   * editor offers the sources set up on this computer; the host signs requests with its key.
   */
  sources?: string[];
  /**
   * The value names something the table has (#306): a dataset or a file of one of these kinds.
   * The editor offers a list of them to pick from, and Add media, instead of a box to type in.
   */
  media?: MediaKind[];
  /** With `media`: the value is the dataset's name (the default) or the file's path in the table folder. */
  mediaBy?: 'name' | 'path';
  /** The value is a column of the dataset the layer's control with this id names (#306). */
  columnsOf?: string;
  /**
   * The value is one or more layers (comma-separated) of the map service the layer's other
   * controls name, by id: its address, its kind (`wms` or `arcgis`) and its sign-in (#306).
   */
  serviceLayers?: { url: string; service?: string; source?: string };
  /** What an empty value means, shown as the first choice of a list (`media`, `columnsOf`), such as "Built-in birdsong". Default "None". */
  none?: string;
}
/**
 * What a table's media are (#306), as `GET /api/media` lists them: `map` (GeoJSON), `table` (CSV),
 * `raster` (GeoTIFF), `drawing` (SVG), `picture`, `video`, `sound`, `model` (the 3D model), `data` (other files).
 */
export type MediaKind = 'map' | 'table' | 'raster' | 'drawing' | 'picture' | 'video' | 'sound' | 'model' | 'data';
export interface ActionControl extends ControlBase {
  type: 'action';
}
export type Control = RangeControl | SelectControl | ToggleControl | DateControl | ColorControl | TextControl | ActionControl;

export interface ToolSpec {
  id: string;
  type: 'point' | 'line' | 'polygon';
  label?: string;
  /** False: inputs from other surfaces play no attention cue on the table (#105). Default true. */
  cue?: boolean;
}

/**
 * A set of things on the table a visitor can pick and change one by one (#279): the buildings of
 * an energy community, the stops of a line. Each entity is a feature of `dataset`, named by its
 * `key` property, and has its own values for `controls`. The controller shows the picked one's
 * controls under its name; the host keeps the values in `params.entities[set][entity]`.
 */
export interface EntitySet {
  /** The set's id, unique in the layer: `params.entities[id]`. */
  id: string;
  /** A dataset from site.json `data` (also `buildings`, the scene's footprints). Name it in `requires.data`. */
  dataset: string;
  /** The feature property that names each entity: unique, a string or a number. */
  key: string;
  /** The feature property shown as its name. Default `key`. */
  label?: string;
  /** A feature property for changes to many at once, such as the owner: "Apply to all of <owner>". */
  group?: string;
  /** What one entity is called on the controller, such as "Building". Default "Item". */
  name?: string;
  /** Each entity's values. Actions are not allowed; `phone: true` lets phones change it. */
  controls: Exclude<Control, ActionControl>[];
  /** Milliseconds of quiet before the table's `entities` handler runs, for layers that call a model on change. Default 0. */
  debounce_ms?: number;
}

/** An entity that is picked on the table and the controller: `state.selection`. */
export interface EntitySelection {
  set: string;
  id: string;
}

/** Entities whose values changed, by set: what the table's `entities` handler gets. */
export interface EntityChange {
  set: string;
  ids: string[];
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
  /** The layer stays open when another layer's button is pressed on the controller. Default false. */
  alongside?: boolean;
  /** While the layer is open, the map at rest (its `base` and `ambient` layers) is turned off on the table, and comes back when it closes. The slideshow does this (#205). Default false. */
  hidesAtRest?: boolean;
  /** Phones may turn the layer on and off (#335). Default true; false for a layer only the controller should open. */
  phone_switch?: boolean;
  requires?: { kernels?: string[]; data?: string[]; services?: string[] };
  controls?: Control[];
  tools?: ToolSpec[];
  /**
   * The controller's centre for this layer. `custom` gives it to the module's `stage(ctx, el)`, such
   * as a map app of the layer's own (#283). A layout (#357) builds it from panels with no code: any
   * widget, its controls, a map. Default: the generated controls only.
   */
  stage?: 'custom' | StageLayout;
  /**
   * Named actions without a button of their own (#283), pressed from the layer's stage, hero or
   * panels with `ctx.action(id)`, and handled on the table in `action(id)`.
   */
  actions?: { id: string; label?: string }[];
  /** Things a visitor picks on the table and changes one by one on the controller (#279). */
  entities?: EntitySet[];
  /** A sound bed of up to four voices that follow the layer's values (#282, voices.ts). Plays on the table only. */
  sound?: import('./voices.ts').VoiceSpec[];
  /** TV panels the layer contributes while it is on. Rules in docs/contracts/dashboard.md. */
  panels?: PanelSpec[];
  /** The layer is a sequence: its instances may have `steps.sequence` that show other layers (the slideshow). */
  sequence?: boolean;
  /** The layer reveals its items through a shape it sets with `ctx.reveal` (the Magnifier, the Reveal line, #287). Default false. */
  reveals?: boolean;
  /**
   * For a site's own code layer (#277): the address its built module is imported from, set by the
   * host when `layers/<name>/dist/index.js` exists. Absent for core layers, which are bundled.
   */
  module?: string;
  /** For a custom layer saved in the site: the recipe the runtime draws. Absent for a code layer. */
  custom?: CustomLayer;
  /** Rows of the layer's legend on the controller (docs/contracts/present.md). */
  legend?: LegendItem[];
  /** The effect behind the layer on the controller's attract loop (docs/contracts/present.md). */
  attract?: { effect: string };
  /**
   * The layer's words in other languages (#80), from its package's `locales/<language>.json`:
   * by language, then by the English text. Read by the visitors' screens; see docs/contracts/layer.md.
   */
  locales?: Record<string, Record<string, string>>;
}

// ---- Site format 3 (docs/contracts/site.md) --------------------------------

/**
 * A layer's controller centre made of panels (#357), on the dashboard's grid: the same panel format
 * as a site's TV pages, so one editor edits both. Panels with `at` stay where they are put; panels
 * without are laid out in order.
 */
export interface StageLayout {
  panels: PanelSpec[];
  /** Also show the layer's generated control rows under the panels. Default false: the panels are the view. */
  controls?: boolean;
}

export interface LegendItem {
  id: string;
  label: string;
  color?: string;
  shape?: 'line' | 'fill' | 'point' | string;
}

/** How Next moves through a layer, and a sequence's steps. */
export interface Steps {
  mode?: 'manual' | 'timed';
  loop?: boolean;
  /** What Next does once a step's sub-steps are done. */
  reveal?: 'stop' | 'then-next';
  /** How a sequence goes from one step to the next, unless a step says otherwise (#43). Default a 0.7 s fade. */
  transition?: 'cut' | 'fade' | 'dip';
  transition_s?: number;
  sequence?: SequenceStep[];
}

/** One step of a sequence: another instance, a layer of the scene or one of the sequence's items. */
export interface SequenceStep {
  layer: string;
  params?: Params;
  duration_s?: number;
  /** `fade` cross-fades; `dip` fades out to the empty map, then in. */
  transition?: 'cut' | 'fade' | 'dip';
  transition_s?: number;
  next?: 'stop' | 'then-next';
  title?: string;
  description?: string;
  source?: string;
  /** What the guide says at this step (#98): on the guide's phone and in the editor, never for visitors. */
  notes?: string;
}

/** A custom layer: a recipe of blocks, saved under `custom` in site.json and used as `custom:<id>`. */
export interface CustomLayer {
  name: string;
  description?: string;
  icon?: string;
  category?: LayerCategory;
  data?: RecipeData[];
  look?: RecipeBlock[];
  motion?: RecipeBlock[];
  interaction?: RecipeBlock[];
  enter?: 'cut' | 'fade';
  controls?: (Control & { bind?: string })[];
  legend?: LegendItem[];
  attract?: { effect: string };
}

/** One source of a custom layer: exactly one of dataset, path, wms and tiles. */
export interface RecipeData {
  id: string;
  dataset?: string;
  path?: string;
  wms?: { url: string; layers: string; styles?: string; format?: string; source?: string };
  tiles?: string;
}

export interface RecipeBlock {
  id: string;
  block: string;
  data?: string;
  on?: string;
  props?: Record<string, unknown>;
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
  /** Show only while the layer's params have these values. A list means any of those values. */
  visibleWhen?: Record<string, unknown>;
  /** Higher is placed first by the automatic layout. Default 0. */
  priority?: number;
  /** Fixed position on the grid, 1-based. Only in a site's pages; layers never choose positions. */
  at?: { col: number; row: number };
  /** In a site's pages: the layer whose params and shared values the bindings read. */
  layer?: string;
  /**
   * Drawn on the table's ribbon, the projector's blank space beside the model (#78), instead of the TV.
   * Only small sizes (`chip`, `tile`, `wide`); rules in docs/contracts/present.md, Ribbon.
   */
  ribbon?: boolean;
}

/** `tv` in site.json. */
/**
 * How finely the table is drawn (#134): `draft` is light on a slow machine, `good` suits most, and `best` uses the
 * screen's full pixel density and the finest sun shadows.
 */
export type DisplayQuality = 'draft' | 'good' | 'best';

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
  /** How the controller's layer buttons look: `icons` (a square icon with a short name under it, the default) or `labelled` (icon and name side by side, in a wider rail). */
  rail_style?: 'icons' | 'labelled';
  /** The built-in theme `theme` was taken from, if any (see `THEMES` in @mrstudio/dashboard). */
  theme_name?: string;
  /** The About page the controller's About button opens. Without it there is no About button. */
  about?: TvAbout;
  /** Seconds with no touch before the controller goes home, as Reset does. Default 180; 0 never. */
  idle_reset_s?: number;
  /** Seconds each layer stays up on the home screen's attract loop. Default 4. */
  attract_s?: number;
  /**
   * The controller's Map controls group (#198): Reset view, Full screen and Calibrate, for
   * whoever runs the table. Default true; false leaves only Reset, for a table visitors run alone.
   */
  map_controls?: boolean;
  /**
   * Phones may turn layers on and off (#335). Default true. Phones never switch layers while a
   * slideshow or tour is showing, whatever this says.
   */
  phone_switch?: boolean;
}

/** The site's About page on the controller: a title, a few lines, and who made it. */
export interface TvAbout {
  title?: string;
  text?: string;
  credits?: { role?: string; name: string; note?: string }[];
  /** Logos along the top of the Credits page: images in the site folder, with the name each stands for. Without them, `branding.logo`. */
  logos?: { path: string; name?: string }[];
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
  table: {
    width_cm: number;
    height_cm: number;
    tile_cm?: number;
    /** The edge of the projected image where visitors stand. Default bottom. */
    front?: 'top' | 'bottom' | 'left' | 'right';
    /** What the projector's blank space shows per side: off, auto, or a size in cm (docs/contracts/present.md). */
    ribbons?: Partial<Record<'top' | 'bottom' | 'left' | 'right', 'off' | 'auto' | { cm: number }>>;
  } | null;
  basemap: { background: string; style: string | null };
  /** Table settings (#73): the controller's title, logo and the welcome line under the title. */
  branding: {
    title: string | null;
    logo: string | null;
    welcome?: string | null;
    /** The languages visitors can switch between (#80), the first the table starts in. */
    languages?: string[];
    /** The site's own words in other languages, by language and then by the English text. */
    translations?: Record<string, Record<string, string>>;
  };
  /** The calibrated table view, when the site has a calibration.json. */
  calibration: {
    center: { lon: number; lat: number };
    zoom: number;
    bearing: number;
    window?: { width_px: number; height_px: number };
  } | null;
  /** Datasets layers may read, by name: site-relative paths served under `/site/`. */
  data: Record<string, string>;
  tv?: TvConfig | null;
  /** How the table's surfaces render (#134). Without it, `good`. */
  display?: { quality?: DisplayQuality } | null;
  /** The table's palette (#93): a built-in set and the slots it changes. Resolve with `resolvePalette`. */
  palette?: { set?: string; slots?: Record<string, string> } | null;
  /** The 3D model of the site (`scene.mesh`, docs/contracts/site.md), and whether footprints are raised beside it. */
  mesh?: SiteMesh;
}

/** A placed 3D model: a file in the site folder and the numbers that put it on the ground. */
export interface SiteMesh {
  path: string;
  anchor: { lon: number; lat: number };
  unit_m: number;
  bearing_deg: number;
  base_m: number;
  /** Which axis of the file points up. Default z. */
  up?: 'z' | 'y';
  mirror?: boolean;
  ground_tolerance_m: number;
  /** False when the model, not the footprints, gives the buildings their shape. */
  extrude: boolean;
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
  /** How the site offers the layer on the controller. What is left out comes from the layer package. */
  button: LayerButton;
  /** Ids of the controls the controller and phones leave out. The editor still shows them. */
  hide?: string[];
  /** For an item: the layer it belongs to. It has no button and comes on with that layer. */
  parent?: string;
  /** How Next moves through the layer, and a sequence's steps, as site.json has them. */
  steps?: Steps;
  /** Where Next is while the layer is on: a sequence's current step, or the sub-steps the layer reported. */
  step?: StepState;
  /** For the layer a sequence is showing as its current step: that sequence. */
  shown_by?: string;
  /**
   * Part of the map at rest although its package is not a base or ambient layer: a layer of
   * the scene that site.json starts on and gives no button (#204). It has no button on the
   * controller and stays on while button layers open and close.
   */
  rest?: boolean;
  /** The entity picked on the table or the controller (#279), shared by every surface. */
  selection?: EntitySelection | null;
}

/**
 * Where Next is in a layer (docs/contracts/present.md, Steps). Moved with the host request
 * `layer.step { layer, to: 'next' | 'previous' | 'first' | 'skip' | 'all' | number }`, and
 * played or paused with `layer.play { layer, playing }`.
 *
 * For a sequence, `index` and `count` count its steps, and `sub` is the shown layer's
 * sub-steps. For any other layer they count its sub-steps, and `index` is how many are
 * revealed, from 0 to `count`.
 */
export interface StepState {
  index: number;
  count: number;
  sub?: { index: number; count: number };
  /** Moving on by itself: timed mode, or sub-steps played one after another. */
  playing: boolean;
  title?: string;
  description?: string;
  source?: string;
  /** What each sub-step is called, for the controller's legend. */
  titles?: string[];
}

/** The button that opens a layer on the controller, as the site's author set it. */
export interface LayerButton {
  name?: string;
  description?: string;
  /** An icon name, such as `sun` or `route`. */
  icon?: string;
  side?: 'left' | 'right';
  /** The group of buttons it sits in on its rail, such as "Simulations". */
  group?: string;
  /** Its place in the rail; lower first. */
  order?: number;
}

export interface Participant {
  /** The surface in the slot. It changes when the phone reconnects; the slot does not. */
  surface: number;
  slot: number;
  colour: string;
  /** False while the slot is held for a phone that dropped. */
  connected: boolean;
  /** The phone's animal (#339): fox, octopus, owl, frog, turtle, penguin, butterfly, unicorn, otter, hedgehog, whale or bee. */
  avatar?: string;
  /** With the animal, the fun name: `sunny` and `fox` make "Sunny Fox". */
  mood?: string;
  /** The name the visitor gave themselves, if any. */
  name?: string | null;
}

export interface SessionState {
  protocol: number;
  /** `join_url` is what the TV's QR code points at; null when phones cannot reach the host. */
  session: { id: string; code: string; port: number; join_url: string | null; /** The visitors' language now (#80). */ language?: string; /** False while the controller's sound switch mutes the table (#282). */ sound?: boolean; /** The layer whose ribbon the controller chose (#231); absent or null is Auto. */ ribbon?: string | null };
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
