// Written by scripts/site-types.mjs from docs/contracts/site.schema.json (#537, #543). Do not edit.

export interface SiteJson {
  format: number;
  id: string;
  name: string;
  origin: LonLat;
  extent: Extent;
  timezone?: string | null;
  table?: Table | null;
  scene: SceneSpec;
  /** Named datasets for layers (`requires.data`), as site-relative paths. */
  data?: Record<string, string>;
  basemap?: Basemap;
  layers?: LayerRef[];
  /** Custom layers saved in this site, by id. A scene uses one as `custom:<id>`. */
  custom?: Record<string, CustomLayer>;
  /** The table's colours (#93): a built-in set and the slots this table changes. */
  palette?: Palette | null;
  tv?: unknown;
  /** Outside compute the table's layers reach through the host (#278): programs the host
   * starts beside the table (a Python model in its own venv) or addresses it forwards to. */
  services?: Service[];
  /** How the table's surfaces render (#134): `{ "quality": "draft" | "good" | "best", "sounds": 0..1 }`. */
  display?: unknown;
  branding?: Branding;
  /** Where the table's data came from and on what terms (#731): sources, licences, credits
   * and whether a file may travel with the table. See `data_licences.rs`. */
  data_licences?: DataLicence[];
}

export interface LonLat {
  lon: number;
  lat: number;
}

export interface Extent {
  width_m: number;
  height_m: number;
  /** Bearing of the table's "up" edge, clockwise from north. */
  rotation_deg?: number;
}

export interface Table {
  width_cm: number;
  height_cm: number;
  tile_cm?: number | null;
  /** The edge of the projected image where visitors stand. At-a-glance info goes there first,
   * because for a viewer at the front the model hides what is projected on the far side. */
  front?: TableSide | null;
  /** What the projector's blank space around the model shows, per side (present.md, Ribbon). */
  ribbons?: Ribbons;
  /** A soft glow in the projector's blank space in the model's own colours (#476, present.md, Ambient glow). */
  glow?: Glow | null;
  /** How the projected table opens when it starts and after the controller's Reset: the place
   * building itself from its streets, buildings and trees (the default, #697), the layers fading
   * in one after another, or the zoom in from the city around it (#446). */
  intro?: Intro | null;
}

/** A side of the projected image. */
export type TableSide = 'top' | 'bottom' | 'left' | 'right';

export interface Ribbons {
  top?: Ribbon | null;
  bottom?: Ribbon | null;
  left?: Ribbon | null;
  right?: Ribbon | null;
}

/** One side's ribbon: `"off"`, `"auto"` (use the free band when there is one) or a size. */
export type Ribbon = RibbonMode | RibbonSize;

export type RibbonMode = 'off' | 'auto';

export interface RibbonSize {
  cm: number;
}

/** The ambient glow around the model: the colours along the model's edges, or one colour for all of it. */
export interface Glow {
  on?: boolean;
  /** 0 to 1: how bright the glow is at the model's edge. */
  strength?: number;
  colours?: GlowColours;
}

export type GlowColours = 'edges' | 'one';

/** The projected table's opening (present.md, Opening). */
export type Intro = 'build' | 'fade' | 'zoom';

export interface SceneSpec {
  cell_m: number;
  buildings?: Buildings | null;
  terrain?: Terrain | null;
  mesh?: Mesh | null;
  trees?: Trees | null;
  /** Water: a river, a lake, the sea (#343). Cool ground for thermal comfort, and a sink for stormwater. */
  water?: Water | null;
  /** Buildings around the table that only shape the wind (#488): footprints reaching past the
   * table's edge. Nothing draws them. */
  context?: WindContext | null;
  /** What covers the ground and the soil under it (#624): where stormwater soaks in, runs fast
   * or drains away. Left out, the site's `roads`, `streets` and `walkways` datasets are read
   * as OpenStreetMap surfaces; `[]` reads none. */
  surfaces?: SurfaceSource[] | null;
}

export interface Buildings {
  path: string;
  height_property?: string;
  default_height_m?: number;
  /** Whether the footprints are raised into the top surface. Turn off when a mesh
   * provides the building shapes and the footprints are only drawn. */
  extrude?: boolean;
}

/** Ground elevation. Either a GeoTIFF (`.tif`, `.tiff`), placed by its own georeference,
 * or raw little-endian f32 elevations covering the extent, row 0 at the top, which
 * need `width` and `height`. */
export interface Terrain {
  path: string;
  width?: number | null;
  height?: number | null;
  /** `EPSG:<code>` of a GeoTIFF that does not name its coordinate system itself. */
  crs?: string | null;
  /** The terrain has the buildings raised in it (a surface model, #344): the ground under each
   * footprint, and one cell around it, is set back to the ground beside it when baking. */
  flatten_buildings?: boolean;
}

/** A 3D model of the site's top surface (ground and buildings), rasterised into the dsm.
 * A mesh has no georeference of its own, so the manifest places it. */
export interface Mesh {
  /** An STL (binary or ASCII), OBJ or GLB file. */
  path: string;
  /** Which of the file's axes points up. CAD and 3D printing use Z, glTF and many modelling tools Y. */
  up?: Up;
  /** Whether the model is a mirror image (its X axis is flipped), as some exports are. */
  mirror?: boolean;
  /** A model in map coordinates (#344): this point of the file, in its own units with the
   * up axis made Z, is taken as its origin, so the numbers stay small. The anchor is where it lies. */
  offset?: number[] | null;
  /** Where the mesh's own origin (0, 0) is, after `offset`. */
  anchor: LonLat;
  /** Metres per mesh unit. */
  unit_m?: number;
  /** Compass bearing of the mesh's +Y axis, clockwise from north. +X is 90 degrees clockwise from +Y. */
  bearing_deg?: number;
  /** Elevation of the mesh's z = 0, in the terrain's height datum. */
  base_m?: number;
  /** The mesh's ground never matches the terrain exactly. Cells where the mesh is less
   * than this above the terrain stay ground instead of becoming low obstacles. */
  ground_tolerance_m?: number;
}

/** The up axis of a mesh file. */
export type Up = 'z' | 'y';

export interface Trees {
  path: string;
  height_property?: string;
  default_height_m?: number;
  crown_radius_m?: number;
}

/** Where the water is: GeoJSON polygons, or a GeoTIFF mask (cells above 0.5 are water). */
export interface Water {
  path: string;
  /** `EPSG:<code>` of a GeoTIFF mask that does not name its coordinate system itself. */
  crs?: string | null;
}

/** Footprints around the table, for the wind kernel only (#488). */
export interface WindContext {
  /** GeoJSON footprints. Those inside the table are left to `buildings`. */
  path: string;
  /** How far past the table's edge they count, in metres. */
  reach_m?: number;
}

/** One source of ground surfaces or soils (#624). Exactly one of `data` and `path`. */
export interface SurfaceSource {
  /** A dataset of the site, by its name in `data` (or `roads`, `trees`… of the scene). */
  data?: string | null;
  /** Or a file in the site folder: GeoJSON, or a GeoTIFF of class codes. */
  path?: string | null;
  /** How to read it. Default `osm`. */
  classes?: SurfaceClasses;
  /** The property that names the surface or soil, for `kind` (default `kind`) and `soil`
   * (default: SGU's `jg2_tx`, else the first text property that names a soil). */
  property?: string | null;
  /** How wide a point is on the ground, metres. Default by surface: a drain 1, a rain garden 4, else 3. */
  size_m?: number | null;
  /** `EPSG:<code>` of a GeoTIFF that does not name its coordinate system itself. */
  crs?: string | null;
}

/** How a surface source names what is on the ground (#624). */
export type SurfaceClasses = 'osm' | 'nmd' | 'soil' | 'kind';

export interface Basemap {
  background?: string;
  /** A MapLibre style URL, or null for no basemap. */
  style?: string | null;
}

export interface LayerRef {
  /** What the instance runs: a core layer id, a relative path to a site-only layer package,
   * or `custom:<id>` for a custom layer saved in the site's `custom`. */
  use: string;
  /** Names this instance. Unique in the whole scene, items included; steps and the session refer to it. */
  id: string;
  /** Whether the layer starts active. */
  active?: boolean;
  params?: Record<string, unknown>;
  /** How the layer is offered on the controller. What is left out comes from the layer package. */
  button?: LayerButton;
  /** Ids of the layer's controls that the controller and phones do not show. The editor still does. */
  hide?: string[];
  /** Instances that belong to this layer: shown while it is open, gone when it closes.
   * Drawn on top of it, in this order. */
  items?: LayerItem[];
  /** How Next moves through the layer, and for a sequence (a slideshow) the steps themselves. */
  steps?: Steps | null;
}

/** The button that opens a layer on the controller: the words and icon the site's
 * author chose for it, and where on the controller it sits. */
export interface LayerButton {
  name?: string | null;
  description?: string | null;
  /** An icon name from the editor's set, such as `sun` or `route`. */
  icon?: string | null;
  side?: ButtonSide | null;
  /** The group of buttons it sits in on its rail, such as "Simulations". */
  group?: string | null;
  /** Its place in the rail; lower first. Buttons without one follow the scene order. */
  order?: number | null;
  /** Kept off the controller and phones without taking the layer out of the table (#58). */
  hidden?: boolean;
  /** Who made what the layer shows, as one line under its name on the controller (#659),
   * such as "Artwork by Vishvi Rajakaruna and Fabio Latino". */
  credit?: string | null;
  /** How the controller shows the layer's legend (#660). Without it, `auto`. */
  legend?: LegendMode | null;
}

export type ButtonSide = 'left' | 'right';

/** How much of a layer's legend the controller shows (#660). */
export type LegendMode = 'auto' | 'full' | 'compact' | 'off';

/** An instance owned by a layer (public transport inside a sun study, a data visual on a
 * slide). It has no button: it comes on and goes off with its layer. */
export interface LayerItem {
  use: string;
  id: string;
  /** Whether it comes on when its layer opens. */
  active?: boolean;
  params?: Record<string, unknown>;
  hide?: string[];
  /** For an item of a revealing layer (an X-ray glass, a Reveal line, #606): `1` puts it in the
   * surface stack, shown outside the glass or on the other side of the line; `2` (or none) in
   * the stack underneath, shown through it. */
  stack?: number | null;
}

/** How Next moves through a layer (`docs/contracts/present.md`, Steps). */
export interface Steps {
  mode?: StepMode | null;
  /** After the last step, back to the first. */
  loop?: boolean | null;
  /** What Next does when a step's sub-steps (category reveals, staged builds) are done. */
  reveal?: Reveal | null;
  /** How a sequence goes from one step to the next, unless a step says otherwise (#43). */
  transition?: StepTransition | null;
  /** How long that transition takes. */
  transition_s?: number | null;
  /** The steps of a sequence: other instances shown one after another. Only for layers
   * whose layer.json says `"sequence": true`, such as the slideshow. */
  sequence?: SequenceStep[];
}

export type StepMode = 'manual' | 'timed';

export type Reveal = 'stop' | 'then-next';

/** How a sequence goes from one step to the next (#43). `Fade` cross-fades the two layers;
 * `Dip` fades the old one out to the empty map, then the new one in. */
export type StepTransition = 'cut' | 'fade' | 'dip';

/** One step of a sequence. It shows another instance: a layer of the scene (which keeps its
 * own button) or one of the sequence's own items (which exist only inside it). */
export interface SequenceStep {
  /** The instance id this step shows. */
  layer: string;
  /** Params the instance takes for this step only, such as another hour of the day. */
  params?: Record<string, unknown>;
  /** How long the step stays in timed mode. */
  duration_s?: number | null;
  transition?: StepTransition | null;
  transition_s?: number | null;
  /** Overrides the sequence's `reveal` for this step. */
  next?: Reveal | null;
  /** For the controller's info strip. The table never shows them. */
  title?: string | null;
  description?: string | null;
  source?: string | null;
  /** What the guide says at this step (#98). Shown on the guide's phone and in the editor,
   * never on the table or the visitors' controller. */
  notes?: string | null;
}

/** A custom layer: a recipe of blocks the layer editor saves (#38), run by the runtime
 * without code of its own. data, then look, motion and interaction, in that order. */
export interface CustomLayer {
  name: string;
  description?: string | null;
  icon?: string | null;
  /** `base`, `ambient`, `analysis` (the default) or `media`, as in layer.json. */
  category?: string | null;
  /** What it shows: datasets of the site, files in the site, or map services. */
  data?: RecipeData[];
  /** How each dataset is drawn (2D only): points, lines, fills, rasters and their styles. */
  look?: RecipeBlock[];
  /** What moves: reveals, pulses, particles, attractors, time. */
  motion?: RecipeBlock[];
  /** What a visitor can do: tap, step, pointer. */
  interaction?: RecipeBlock[];
  /** How the layer comes onto the table and leaves it. */
  enter?: Transition | null;
  /** Controls, as in layer.json. A control's `bind` names the block prop it drives: `look.<block id>.<prop>`. */
  controls?: unknown[];
  legend?: LegendItem[];
  attract?: Attract | null;
}

/** One source of a custom layer. Exactly one of `dataset`, `path`, `wms` and `tiles`. */
export interface RecipeData {
  id: string;
  /** A named dataset of the site (`data`, or the scene's buildings, trees and terrain). */
  dataset?: string | null;
  /** A file in the site folder: GeoJSON, GeoTIFF, CSV points, an image or a video. */
  path?: string | null;
  wms?: Wms | null;
  /** An XYZ tile URL template with `{z}`, `{x}` and `{y}`. */
  tiles?: string | null;
}

/** A WMS map. Sign-in, when the service needs it, comes from the app's Sources manager by
 * `source`; nothing secret is in the site. */
export interface Wms {
  url: string;
  layers: string;
  styles?: string | null;
  format?: string | null;
  source?: string | null;
}

/** One block in a custom layer's recipe. The block names are the SDK's (docs/blocks.md). */
export interface RecipeBlock {
  /** Names the block so controls and other blocks can refer to it. */
  id: string;
  /** Which block: `points`, `lines`, `fill`, `raster`, `glow`, `pulse`, `particles`, `tap-info`… */
  block: string;
  /** The data it draws or reads, by `data[].id`. */
  data?: string | null;
  /** For motion and interaction: the look block it acts on. */
  on?: string | null;
  props?: Record<string, unknown>;
}

export type Transition = 'cut' | 'fade';

/** One row of a layer's legend on the controller (present.md, Stage). */
export interface LegendItem {
  id: string;
  label: string;
  color?: string | null;
  shape?: string | null;
}

/** The effect behind a layer on the controller's attract loop (present.md, Button). */
export interface Attract {
  effect: string;
}

/** The table's palette: one of the built-in sets the SDK knows (`night` when missing) and
 * the slots this table overrides, by slot name, as `#rrggbb`. Layers and custom layers
 * refer to slots (`@accent`, `@cat3`), so changing the palette recolours them all. */
export interface Palette {
  set?: string | null;
  slots?: Record<string, string>;
}

/** One outside service (#278). Exactly one of `run` and `url`. Contract in docs/contracts/site.md. */
export interface Service {
  /** What layers call it by: `requires.services` and `ctx.service(id)`. */
  id: string;
  /** Its name for people, in the operator's view. Default: the id. */
  name?: string | null;
  /** A program the host starts with the table and keeps running. */
  run?: ServiceRun | null;
  /** A service that runs elsewhere, such as `https://ecom.example.org`. The host forwards to it. */
  url?: string | null;
  /** The path that answers 200 when the service is ready. Default `/`. */
  health?: string | null;
}

/** How the host starts a service of this site. */
export interface ServiceRun {
  /** Its folder, relative to the site, for example `services/ecom`. */
  cwd: string;
  /** The program and its arguments. `{port}` is the port the host picked for it, and
   * `{python}` the Python of `venv` (or of this computer when there is none). */
  command: string[];
  /** A virtual environment, relative to `cwd`, for example `.venv`. The host makes it on the
   * first start when it is missing, and installs `requirements` into it. */
  venv?: string | null;
  /** A requirements file, relative to `cwd`, installed when the venv is made or the file changed. */
  requirements?: string | null;
  /** Extra environment variables. `{port}` is filled in here too. Keys go in Sources and keys, never here. */
  env?: Record<string, string>;
  /** Seconds the service may take to answer its health path after it starts. Default 60. */
  start_s?: number | null;
}

export interface Branding {
  title?: string | null;
  logo?: string | null;
  /** The line under the title on the controller's home screen, for visitors (#73). */
  welcome?: string | null;
  /** The languages visitors can switch between (#80), the first the table starts in:
   * `["en", "sv"]`. Empty or one language: no switch. */
  languages?: string[];
  /** The site's own words in other languages, by language and then by the English text:
   * `{ "sv": { "Sample district": "Exempelstadsdelen" } }`. Titles, the welcome line, button
   * names, slide titles and the like. A layer's own words are in its package (`locales/`). */
  translations?: Record<string, Record<string, string>>;
}

/** A `site.json` `data_licences` entry: the terms of some of the table's files. */
export interface DataLicence {
  /** Site-relative paths. A path ending in `/` or `*` covers everything under it. */
  files: string[];
  /** Who it came from, such as "Lantmäteriet" or "SGU". */
  source: string;
  /** The licence, such as "CC0", "ODbL-1.0", "CC BY 4.0" or "FUK". */
  licence?: string | null;
  /** The credit to show, such as "© Lantmäteriet". */
  attribution?: string | null;
  /** Whether it may travel with the table. Worked out from the licence when left out. */
  share?: Share | null;
  note?: string | null;
}

/** Whether a file may leave this computer with the table. */
export type Share = 'open' | 'attribution' | 'restricted';
