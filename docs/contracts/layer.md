# Layer contract

A layer is a package: a manifest plus a TypeScript module. Adding a layer touches no core file.

```
packages/layers/sunlight/        (or sites/<id>/layers/<name>/)
  layer.json
  src/index.ts
```

## layer.json

```jsonc
{
  "api": 1,
  "id": "sunlight",
  "name": "Sunlight",
  "description": "Shadows and hours of direct sun",
  "icon": "sun",
  "category": "analysis",
  "requires": { "kernels": ["sunlight"], "data": [], "services": [] },
  "controls": [
    { "id": "mode", "type": "select", "label": "Show", "default": "instant",
      "options": [{ "value": "instant", "label": "Shadows now" }, { "value": "day", "label": "Sun hours" }] },
    { "id": "date", "type": "date", "label": "Date", "default": "2026-06-21" },
    { "id": "hour", "type": "range", "label": "Time", "min": 0, "max": 24, "step": 0.25, "default": 12, "unit": "h", "phone": true },
    { "id": "play", "type": "toggle", "label": "Animate the day", "default": false }
  ],
  "tools": []
}
```

`id` is lowercase letters, digits and dashes, and is the folder name for a core layer.
`category` puts the layer in a group of the composer's palette: `base`, `ambient`, `analysis` (the default) or `media`.
On the controller screen a layer of category `analysis` or `media` is a button, and pressing it opens that layer and closes the others. `base` and `ambient` layers are the map at rest and have no button there.
`sub_steps: "drawing"` says the layer's sub-steps are the phase groups of its drawing (the `dataset` param, else the table's first SVG): the host counts them as the layer turns on, plus one when `finale` is on, unless `reveal` is off. Next, phones and the MCP can then step the layer before any table window has called `ctx.steps.define`; the table's later report with the same count only adds the names (#421). Used by the Masterplan.

`alongside: true` keeps the layer open when another layer's button is pressed, and lets it open without closing the others. Use it for a tool people keep while they look at something else, such as the sketch layer. Default false.
Any open button layer pauses the map at rest's life on the table, keeping only the base map (#303). `hidesAtRest: true` turns the whole map at rest off while the layer is open, the base map included: every top-level `base` and `ambient` layer stops, and starts again when the layer closes. The host's state does not change, so the controller and editor still show them as on. The slideshow does this, so slides are seen on their own (#205). Default false.

`sequence: true` makes the layer a sequence: an instance of it may have `steps.sequence`, steps that show other layers one after another (see site.md). The slideshow is one.
`legend` and `attract` are proposed in [present.md](present.md); site format 3 already carries them for custom layers.
`about` says what the layer is *for*, for people and LLMs designing an experience rather than picking a layer by name (#326): `purpose` (one sentence: what it helps a group see or do), `questions` (the questions it helps a group answer at the table), `pairs_with` (layer ids it works well with) and `limits` (what it cannot do, or what it needs). The MCP server's capability catalogue reads it (`find_capabilities`), and `scripts/check-docs.mjs` fails when a core layer has none. Example: `"about": { "purpose": "Shows shadows at any moment…", "questions": ["How does a proposal change sun and shade on squares?"], "pairs_with": ["plan", "swipe"], "limits": ["Shadows fall on the ground; sun on facades is planned"] }`.
`requires.data` lists the site datasets the layer reads, by name (see `data` in site.md). A layer must still start when one is missing.

Control types: `range`, `select`, `toggle`, `date`, `color`, `text`, `action` (a button, no stored value).
Every control has `id`, `type`, `label` and `default`. `phone: true` lets phone participants change it; a `primary` control is on phones unless it says `phone: false` (#335).

`"phone_switch": false` at the top of layer.json keeps phones from turning the layer on or off, for a layer only the controller should open (the slideshow). Default true.
`help` is one or two sentences on what a control does; the editor shows it as the control's tooltip (#64).

`clock` hands a control to the editor's time bar (#61), which previews any moment without changing the saved value: `"hour"` (a range in hours, 0 to 24), `"date"` (the day), `"progress"` (a range from 0 to 100 through a run, such as Mobility's trips) and `"play"` (the layer's own play switch, paused while the bar scrubs).

A `range` control with `"shows": "network_time"` shows that value, as the layer publishes it, in place of the number while there is one: a network's Time slider is a share of its series but reads "19:00" (#338).
`visibleWhen: { "mode": "day" }` hides a control unless another control has that value; a list, `{ "style": ["light", "dark"] }`, means any of them.

A `text` control that names something is never a box to type in (#306); the editor offers a list to pick from, with type-ahead, and refuses a name that is not in it:

- `"sources": ["wms", "arcgis"]`: the id of a source of the Sources manager of one of these kinds.
- `"media": ["map", "table"]`: a dataset or file of the table, of these kinds (as `GET /api/media` names them: `map`, `table`, `raster`, `drawing`, `picture`, `video`, `sound`, `model`, `data`). The value is the dataset's name, or the file's path for a file no dataset names; `"mediaBy": "path"` always stores the path. The list ends with Add media.
- `"columnsOf": "dataset"`: a column of the dataset that the layer's control `dataset` names.
- `"serviceLayers": { "url": "url", "service": "service", "source": "signin" }`: one or more layers (comma-separated) of the map service the layer's controls `url`, `service` (`wms` or `arcgis`) and `signin` name, as the service lists them (`GET /api/wms/layers`).
- `"none": "Built-in birdsong"` names what an empty value means; it is the list's first choice. Default "None".

The controls are the single source of truth for a layer's params:

- The host builds the initial params from the defaults and the site's overrides.
- The TV and phone surfaces generate their UI from them.
- The host validates and clamps every change against them.

`requires` states what the layer needs from the app and the site:

- `kernels`: engine kernels it opens streams on.
- `data`: named datasets the site must provide. A site maps each name to a file under `data` in `site.json` (see site.md), and the host refuses to start a site, or to add a layer to a scene, when one is missing; the composer's palette says so beforehand. The scene's `buildings` and `trees` count as datasets. The layer loads it with `loadSiteData(ctx.site, name)`. A layer may also use a dataset it does not require: it checks `hasSiteData(ctx.site, name)` and does without when the site has none. A raster dataset (a GeoTIFF, or a folder of one GeoTIFF per hour such as `pet_08.tif` .. `pet_20.tif`) is read laid on the site grid with `loadSiteField(ctx.site, name, hour)`: a field frame of exact values, NaN where the raster has no data, null when a folder has no raster for that hour (`GET /api/data/field?name=&hour=`).
- `services`: outside services it calls with `ctx.service(id)`, by their id under `services` in site.json (site.md, Services). The layer still starts when one is missing; its calls are refused, and the host warns.

## TV panels

A layer lists the panels it shows on the TV while it is on. They are data: the layer needs no TV code, and it does not place them.

```jsonc
"panels": [
  { "id": "time", "widget": "stat", "size": "tile", "title": "Time on the table",
    "visibleWhen": { "mode": "instant" },
    "props": { "value": { "bind": "params.hour" }, "format": "hour", "caption": { "bind": "shared.sun" } } }
]
```

Props are literals or bindings: `params.<control>`, or `shared.<key>` for a value the table published with `ctx.publish`.
The widgets, the sizes and the density budget every panel must fit are in [dashboard.md](dashboard.md) and [../DASHBOARD.md](../DASHBOARD.md).
A panel that breaks a rule is not shown.

## Tools

Tools are spatial inputs a layer accepts: `point`, `line`, `polygon`. Each is `{ "id", "type", "label" }`. A `line` with `"freehand": true` is drawn with one stroke of the finger and sent when it lifts, like a pen (#335). The input system (touch, phone) delivers them as `ToolInput` with coordinates in WGS84:

```ts
interface ToolInput {
  layer: string;
  tool: string;                                   // the tool's id
  geometry: ToolGeometry;                         // GeoJSON Point, LineString or Polygon, checked by the host
  from: number;                                   // the sending surface
  participant?: { slot: number; colour: string; avatar?: string; name?: string | null }; // when it came from a phone
}
```

A phone shows a layer's tools on its map as soon as the manifest declares them; the layer writes no phone code. The map has a light base map, the buildings and the table's edge; two fingers pan and zoom, Fit table goes back to the whole table, and it opens full screen (#335). A layer's action controls marked `"phone": true` sit under the map. On the table the attention cue shows the phone's animal in its colour (#423).
`packages/layers/sketch` is the reference for a layer with tools.

## Entities

Entities are things on the table a visitor picks and changes one by one (#279): the buildings of
an energy community, the stops of a line. A layer declares the sets it has; the runtime does the
picking on the table and the controls on the controller, so the layer writes no UI code.

```jsonc
"requires": { "data": ["buildings"] },
"entities": [
  { "id": "buildings", "dataset": "buildings", "key": "id", "label": "name", "group": "owner",
    "name": "Building", "debounce_ms": 800,
    "controls": [
      { "id": "in", "type": "toggle", "label": "In the energy community", "default": true, "phone": true },
      { "id": "pv", "type": "range", "label": "Solar on the roof", "min": 0, "max": 80, "step": 5, "unit": "%", "default": 0 }
    ] }
]
```

- `dataset` is a dataset of the site (the scene's `buildings` counts); each feature is one entity,
  named by its `key` property. `label` is the property shown as its name (default `key`), `group`
  a property for changing many at once, `name` what one is called on the controller.
- `controls` are layer controls without actions. They are checked by the host like the layer's own.
- `facts` (#38) lists properties shown on the controller for the picked entity, as a short list
  of names and values. A set needs `controls`, `facts` or both. `key` may be `#`: the feature's
  place in the file, for data with no id column.
- **On the table**, a tap on an entity picks it for every surface; the picked one is outlined
  and breathes, and entities with changed values get a dashed outline.
- **On the controller**, the layer's stage shows the picked entity's name and controls above the
  layer's own, a list to pick one without the table, Back to default, and "Apply to all of
  <group>" (the picked one's values to every entity of its group).
- **The host** keeps only changed values, in `params.entities[set][entity][control]`, and
  the pick in the layer state's `selection` (`{ set, id }`, cleared when the layer goes off).
  Requests: `layer.select { layer, set, id | null }` and
  `layer.entity { layer, set, ids, values }` or `{ layer, set, ids, reset: true }`. Phones may
  change only controls marked `phone`. Reset on the controller puts the saved values back.
- **Saved and undone** like any param: `scene.set { layer, params: { entities } }` (the editor,
  the MCP's `set_params`) writes them to site.json as one step of the history.
- **In the layer**, `ctx.entity(set, id)` gives one entity's values (defaults with the changes on
  top), `ctx.setEntity` and `ctx.select` change them, and `ctx.selection` is the pick. The
  table's `entities(changed)` handler names what changed, by set, once the set's `debounce_ms`
  has passed with no change, so a layer that asks a model asks once per gesture; `select` runs
  when the pick changes. `entityFeatures`, `pickEntity` and `entityValues` in the SDK do the
  same reading for a layer's own drawing.

`samples/service-example` has a layer with entities that asks a model again when a building changes.

## The controller stage

A layer can have its own app in the controller's centre (#283), such as a map to choose on, whose
actions start something on the table. The table stays the picture: the stage is for choosing and
controlling.

```jsonc
"stage": "custom",
"tools": [{ "id": "route", "type": "line", "cue": false }],
"actions": [{ "id": "travel", "label": "Send a traveller" }]
```

- `stage: "custom"` gives the centre under the layer's name to the module's `stage(ctx, el)`, which
  draws what it likes into `el` and may return `{ update() }`, called when params or shared values
  change. The rails, the step strip, the entity inspector and the layer's controls stay; the TV's
  panels keep a strip under it.
- `actions` are named actions without a button of their own. The stage (or a hero or panel)
  presses one with `ctx.action(id)`, and every view of the table gets it in `action(id)`. Phones
  cannot press them.
- `ctx.sendTool(tool, geometry)` sends a tool input from the controller as a phone would; every
  view of the table gets it in `tool(input)`.
- `controllerMap(el, ctx, options)` from the SDK is a ready map of the site: the table's outline,
  upright as it stands, with its `roads` and `buildings` (or the datasets in `data`), in the
  controller's theme. `mode: 'pick'` calls `onPick(at)` on a tap; `'line'` and `'polygon'` place
  corners and call `onDraw(geometry)` when `points` are placed or on `finish()`. `draw(g, map)`
  adds the layer's own visual, with `map.project(lonLat)`. `StreetGraph.route(from, to)` gives the
  shortest way along the streets.

### A stage made of panels, with no code

`stage` can instead be a layout of dashboard panels (#357): the same widgets, sizes, bindings and
density budget as the TV, including the map, gauge and control widgets and the layer's own team
widgets. No module code is needed.

```jsonc
"stage": {
  "controls": false,
  "panels": [
    { "id": "pick", "widget": "map", "size": "block", "title": "Pick a building",
      "props": { "entities": "buildings", "hint": "Tap a building to change it" } },
    { "id": "grid", "widget": "grid-link", "size": "tile", "props": { "value": { "bind": "shared.import_kw" } } },
    { "id": "share", "widget": "control", "size": "wide", "props": { "control": "share" } },
    { "id": "run", "widget": "control", "size": "tile", "props": { "control": "optimise" } }
  ]
}
```

- Panels without `at` are packed in the order given, like a layer's TV panels; give every panel an
  `at` to place them by hand on the 12 by 6 grid. Either way they pass the dashboard rules.
- `controls: false` (the default) leaves the layer's generated control rows out, since the panels
  carry the controls the layer wants. `controls: true` keeps them under the panels.
- The entity inspector, the step strip and the rails stay. The TV's own panels keep the strip under
  the stage; if the stage leaves too little room for them, that strip stays blank.

### A map stage, with no code (#374)

`stage` can be a map that fills the centre under the layer's name, with a few panels along its
bottom edge:

```jsonc
"stage": {
  "map": {
    "entities": "buildings",
    "fill_by": { "entity": "use", "categories": { "housing": 1, "offices": 2, "shops": 3 } },
    "hint": "Tap a building to change its use"
  },
  "panels": [
    { "id": "target", "widget": "control", "size": "tile", "title": "Homes goal", "props": { "control": "target" } }
  ]
}
```

- `map` takes the map panel's props (dashboard.md, A map on a panel): datasets, an entity set or
  a tool or a named action for taps, shapes, a hint, `fill_by`, `stroke_by` and `labels`. Drag and
  pinch zoom it (`"zoom": false` turns that off); Reset frames the table again.
- `panels` are optional here: at most 4, chip or tile only, in a strip along the map's bottom edge.
  As with panels, `controls: true` adds the generated control rows under the stage.
- `samples/map-stage-example` colours buildings by the use visitors give them.

`samples/controller-map-example` is a route planner: two taps on the controller's map make a
route along the streets on the table, and a button sends a light along it.

## Module

```ts
import { defineLayer } from '@mrstudio/sdk';
import manifest from '../layer.json';

export default defineLayer({
  manifest,

  // Runs on the table when the layer is turned on.
  async table(ctx) {
    const overlay = ctx.map.addField('sunlight', { colormap: colormaps.daylight });
    const stream = await ctx.engine.open('sunlight', kernelParams(ctx), ['shadow']);
    stream.on('shadow', (frame) => overlay.set(frame));
    return {
      update(changed) { stream.set(kernelParams(ctx)); },  // params changed
      action(id, by) {},                                    // an action control was pressed; by: the phone that pressed it (#335)
      tool(input) {},                                       // a spatial input arrived
    };
  },

  // Only for `custom` panels: draws inside a panel declared in layer.json.
  panel(ctx, el) {
    el.textContent = '...';
    return { update() {} };                                 // params or shared values changed
  },

  // Optional: fetch what the layer will show before it is shown (see below).
  async prefetch(site, params) {},

  // Optional: the layer's own widgets (#353), named `<layer>/<type>` on the site.
  widgets: [gridLink],
});
```

`widgets` brings the layer's own kinds of panel (#353), made with `defineWidget` from `@mrstudio/sdk`.
They are known on the site as `<layer id>/<type>` (TV pages, other layers), and the layer's own
`panels` may name them by `type` alone. They keep the core widgets' contract (contracts/dashboard.md,
Adding a widget): the sizes they take, a label on every prop, bindings, the theme's tokens only, and
an honest cost in reads. A widget with problems is skipped and reported in the window's console; one
that throws breaks only its own panel. The model-runs sample (`samples/service-example`) has one,
`grid-link`.

The module is loaded on every surface. `table` runs only on the table surface and `panel` only on the TV, once for each `custom` panel in the manifest. Phones need no code.
State lives in the closure, so a layer has no module-level variables and no explicit teardown:
overlays and streams opened through `ctx` are released when the layer is turned off.
`prefetch(site, params)` runs on the table when a sequence (the slideshow) that shows the layer opens, once per step, with the params that step will use. A layer that loads something slow, such as a map picture from a service, fetches it there, so stepping to it does not wait. What the host fetches it also keeps, for venues without a connection. Errors are ignored. The Web map layer (`packages/layers/wms`) is the example.
`packages/layers/sunlight` is the reference to copy. `coolpaths` shows a layer that combines a kernel with site data, `mobility` one that only plays site data, and `packages/layers/wind` a running simulation with a flow overlay.

## Context

```ts
interface TableContext<P> {
  readonly site: SiteInfo;              // id, origin, extent, grid, timezone
  readonly params: Readonly<P>;         // current params, host-authoritative
  setParams(patch: Partial<P>): void;   // request a change (goes through the host)
  readonly shared: Readonly<Record<string, unknown>>;  // values published by the table
  publish(values: Record<string, unknown>): void;      // derived values for panels
  readonly engine: EngineClient;        // open kernel streams
  readonly map: MapHandle;              // field overlays
  readonly model: ModelHandle;          // the 3D model: fields, lights, materials, focus, pick (see model.md)
  readonly pointer: TablePointer;       // mouse, touch and pen on the table surface
  sendTool(tool: string, geometry: ToolGeometry): Promise<void>;  // send a tool input through the host, as a phone does; every view of the table gets it
  cue(at: ToolGeometry, options?: { colour?: string }): void;     // play the attention cue at a change (#105); tool inputs from other surfaces get one automatically
  readonly steps: LayerSteps;           // sub-steps that the controller's Next reveals one at a time
  readonly reveal: LayerReveal;         // where the layers inside this one show, for a layer with "reveals": true (see Reveals)
  readonly view: LayerView;             // a picture for this layer's own controller: send(canvas) here, watch(cb) in its hero (#351)
  onFrame(cb: (dt: number) => void): void;   // every animation frame while the layer is on
  onCleanup(cb: () => void): void;      // extra teardown
}
interface LayerSteps {
  define(count: number, titles?: string[]): void;  // say how many parts Next reveals; call it when the layer starts
  readonly revealed: number;            // how many are revealed now, 0 (the overview) to count
  readonly state: StepState | undefined;  // the layer's steps as the host has them
}
// TableHandlers also has step?(revealed: number), called when Next or Previous changes `revealed`.


// PanelContext has site, params, setParams, shared, onCleanup and `panel`, the id of the custom panel being drawn.

interface TablePointer {
  on(cb: (sample: PointerSample) => void): void;   // released with the layer
}

// One sample of one pointer, in table metres (x right, y down from the extent's top left).
interface PointerSample {
  id: string;                                // one mouse, finger, phone or token: 'mouse:1', 'touch:7', 'phone:3'
  source: 'mouse' | 'touch' | 'pen' | 'phone' | 'token' | 'script';
  phase: 'move' | 'down' | 'up' | 'leave';
  point: [number, number];
  lonLat: [number, number];
  pressed: boolean;
  time: number;                              // seconds
  rotation?: number;                         // radians, for tokens and dials
  owner?: number;                            // the participant behind a phone pointer
}

interface EngineClient {
  open(kernel: string, params: object, fields: string[], opts?: { encoding?: 'u8' | 'f32'; maxHz?: number }): Promise<FieldStream>;
}

interface FieldStream {
  set(params: object): void;                 // coalesced: only the latest values are sent
  on(field: string, cb: (frame: FieldFrame) => void): void;
  onStatus(cb: (status: StreamStatus) => void): void;   // state, progress and kernel info
  close(): void;
}

interface MapHandle {
  addField(id: string, style: FieldStyle & { colormap: Colormap }): FieldOverlay;
  addFlow(id: string, style: FlowOverlayStyle & { colormap: Colormap }): FlowOverlay;   // a vector field as moving tracers
  addElement(): HTMLElement;        // a layer-owned element covering the table, for SVG or canvas decorations
  addCanvas(id: string, style?: { opacity?: number }): CanvasOverlay;      // a canvas above the scene, in CSS pixels, with a projection
  addShapes(id: string, style?: { opacity?: number }): ShapeOverlay;   // points, lines and areas
  addDrawing(id: string, options?: { opacity?: number; resolution?: number }): DrawingOverlay;
  addPicture(): TablePicture;       // a copy of what the table shows now, for a magnifier (#287)
  addDetail(render: (g: CanvasRenderingContext2D, scale: number) => void): void;  // draw this layer again sharply for a magnifier, in table metres (#351)
  detail(centre: [number, number], radius_m: number, size: number): HTMLCanvasElement | null;  // the other layers' sharp pictures of a square, size px across
}

// What the table shows, copied each frame after the map has drawn: the base map and every
// layer's canvases except this layer's own. `want(rect)` names the part (CSS pixels of the
// table view) to copy at the next frame; `canvas` holds it once `taken` is true.
interface TablePicture {
  want(rect: PixelRect | null): void;
  readonly canvas: HTMLCanvasElement;
  readonly taken: boolean;
  readonly revision: number;          // goes up with every copy
  remove(): void;
}

// A 2D drawing inside the scene's draw order, for layers that draw shapes themselves:
// base maps, ambient animation, media. One unit is one metre, origin top left.
interface DrawingOverlay {
  readonly ctx: CanvasRenderingContext2D;   // already scaled to metres
  readonly width: number;                    // table size in metres
  readonly height: number;
  readonly scale: number;                    // canvas pixels per metre
  clear(): void;
  commit(): void;                            // show what was drawn; nothing is uploaded until then
  setOpacity(opacity: number): void;
  remove(): void;
}

interface ShapeOverlay {
  set(shapes: { geometry: ToolGeometry; colour?: string }[]): void;   // replaces what it shows
  setOpacity(opacity: number): void;
  remove(): void;
}

interface FieldStyle {
  colormap?: Colormap;
  opacity?: number;
  smooth?: boolean;                 // interpolate between cells, default true
  soften?: number;                  // blur radius in cells, for soft edges
  glide?: number;                   // seconds a new frame takes to ease in, so stepped results move smoothly
}

interface FieldOverlay {
  set(frame: FieldFrame): void;     // uploads the frame as a texture, coloured on the GPU
  setStyle(style: FieldStyle): void;
  remove(): void;
}

// A 2D canvas locked to the table, for vectors: networks, routes, moving markers.
interface CanvasOverlay {
  readonly context: CanvasRenderingContext2D;   // one unit is one CSS pixel
  readonly width: number;                       // CSS pixels
  readonly height: number;
  readonly pixelsPerMetre: number;              // so marks can keep a physical size
  readonly revision: number;                    // raised when the size or view changes; the canvas is then blank
  project(lonLat: [number, number]): [number, number];   // WGS84 to canvas pixels
  clear(): void;
  setOpacity(opacity: number): void;
  remove(): void;
}

// A vector field drawn as moving tracers: ribbons or particles.
interface FlowOverlay {
  set(u: FieldFrame, v: FieldFrame): void;   // components towards the right and the bottom of the table
  setStyle(style: FlowOverlayStyle): void;
  remove(): void;
}

interface FlowOverlayStyle {
  colormap?: Colormap;               // colours tracers by the local magnitude
  max?: number;                      // magnitude at the top of the colormap; default the frames' max
  mode?: 'ribbons' | 'particles';    // long tapering trails, or short streaks
  count?: number;                    // tracers, default 500
  rate?: number;                     // share of the extent's longer side travelled per second, per field unit
  opacity?: number;
}
```

Fields, flows, shapes and drawings (`addDrawing`) are drawn at the layer's place in the scene: above the layers before it in `site.json` and below those after it.
A layer can be in a scene more than once. Each copy runs `table` on its own, with its own params, so state must live in the closure.

Helpers in `@mrstudio/sdk` for drawing layers: `tableSpace(site)` turns WGS84 into table metres, `readSiteData(site, name)` and `siteDataUrl(site, name)` read a named dataset, `geojsonLines`, `geojsonPolygons` and `geojsonPoints` convert GeoJSON, `streetLines(site)` gives the `roads` dataset (none when the site has none: nothing is made up), `track`, `along` and `nearestAlong` move things along a polyline, and `seededRandom` keeps "random" scenes the same on every table.
`packages/layers/trees` is the smallest animated example and `packages/layers/basemap` the smallest static one.

Elements (`addElement`) and canvases (`addCanvas`) sit above the whole scene, in the order they were added. They do not follow the scene's draw order yet.
`addCanvas` is the drawing surface for anything placed geographically: it brings the projection, the scale and the redraw signal that a bare `addElement` leaves to the layer.
A layer draws on a canvas from `ctx.onFrame`: every frame for moving things, or only when `revision` or its own data changed.
`siteProjection(ctx.site)` from the SDK converts WGS84 to local metres and to grid cells, for measuring distances and for reading a field frame at a place.

`addFlow` is how any layer shows movement (wind now, water later). The surface animates the tracers itself between frames,
so the kernel only has to deliver the field a few times a second. Cells where both components are zero are obstacles: tracers never enter them.
The tracer logic is `FlowField` and `Tracers` in `@mrstudio/sdk`, which are plain and tested, for a layer that wants to draw its own.
`stretch(colormap, fraction)` gives a legend that ends below the field's own maximum.

Rules for layers:

1. No solver code. Heavy computation is a kernel or a service. Light work on the layer's own data, such as a route search over a site's path network, may stay in the layer as a module with its own tests.
2. No site paths or coordinates in code. Use `ctx.site` and data declared in `requires.data`.
3. No direct communication between surfaces. Use `setParams` and `publish`.
4. Clean up is automatic for everything opened through `ctx`. Anything else is released with `ctx.onCleanup`.
5. `update` must be cheap. Send params to the stream and return; frames arrive asynchronously.

## Languages

Visitors read the controller, the phones and the table's ribbons in English or Swedish (#80); the editor stays in English. Everything is written in English and looked up by that English text, so a missing translation shows in English rather than breaking.

- **A layer's words** are in its package, `locales/sv.json`: one object from English to Swedish, `{ "Sunlight": "Solljus", "Time of day": "Tid på dagen" }`. The host reads it with layer.json and sends it in the manifest as `locales: { sv: {...} }`. It covers the words in layer.json (name, description, control labels and choices, tool labels, legend, panel titles and captions) without any code.
- **Words the layer makes as it runs** (a status, a caption, a hero's labels) go through `ctx.say(text, vars?)`: `ctx.say('Sunrise {time}', { time })` looks up `Sunrise {time}` and fills `{time}`. `ctx.language` is `en` or `sv`, for dates and numbers. A published text that matches an entry exactly (`'Shade'`) is said in the visitor's language on the TV's panels and the controller's legend without `ctx.say`.
- Every core layer has `locales/sv.json`; a host test checks that every core layer's name, control labels and choices have Swedish.
- The site's own words (title, welcome line, button names, slide titles) are in site.json, `branding.translations` (site.md).

## Sound voices

A layer can carry a sound bed in layer.json, `sound`, with no audio code (#282). It is up to four
slow, continuous voices whose level and colour follow what the layer publishes or a control's value:

```json
"sound": [
  { "id": "grid", "kind": "noise", "width": 1.2, "glide_s": 3,
    "level":  { "bind": "shared.import_kw", "from": [0, 400], "to": [0, 0.6], "curve": "sqrt" },
    "centre": { "bind": "shared.import_kw", "from": [0, 400], "to": [260, 900] } },
  { "id": "hum", "kind": "hum", "frequency": 100, "harmonics": 4,
    "level":  { "bind": "shared.import_kw", "from": [50, 400], "to": [0, 0.35] } }
]
```

- `kind`: `noise` (white noise through a band, `centre` Hz and `width` octaves), `hum` (a pitch with
  up to 6 `harmonics`) or `tone` (a plain sine at `frequency`).
- Each of `level` (0 to 1), `centre`, `width` and `frequency` is a number, or a binding
  `{ "bind": "shared.<key>" | "params.<control id>", "from": [a, b], "to": [c, d], "curve" }` that maps
  the value's range to the voice's, holding at the ends. `curve` is `linear` (default), `sqrt` or
  `square`. A value that is missing gives the low end, so a bed is silent until there is data.
- The rules from the ECOM learnings (docs/visualisation.md): the voices share one level ceiling, so
  more voices are never louder; every change glides over `glide_s` seconds (2 by default, at least
  0.5); there are no repeating events.
- Voices play on the table only, start and stop with their layer, and fade out while the controller's
  **Sound** switch (under Map controls) mutes the table for the session (`session.sound {on}`, which
  also silences sound on points). The host refuses a layer.json whose `sound` breaks these rules.
- From code, `VoiceBed`, `voiceTargets` and `checkVoices` are in `@mrstudio/sdk` (voices.ts).

## Reveals: X-rays, magnifiers and reveal lines

A layer with `"reveals": true` in layer.json shows the layers placed inside it (its items in
`site.json`, added in the editor) only where it says, with `ctx.reveal.set(shape)` (#287, #288):

```ts
type RevealShape =
  | { kind: 'circle'; centre: [number, number]; radius_m: number }               // a glass
  | { kind: 'side'; axis: 'x' | 'y'; at_m: number; keep: 'before' | 'after' }  // one side of a line
  | { kind: 'none' };                                                          // nowhere
ctx.reveal.set(shape | null);   // null: everywhere, as without a revealer
ctx.reveal.item(index, shape | null | undefined);  // one item (0 is the first) gets a shape of its own; undefined hands it back
```

`otherSide(shape)` turns a side round, for a Reveal line with `split` on: its first item shows on one
side and its second on the other, then and now (#349).

Places are table metres. Until the layer sets a shape its items show nowhere. The runtime does the
clipping, so the items need no code of their own: drawings (`addDrawing`) are composed through the
shape, canvases and elements (`addCanvas`, `addElement`) get a CSS clip that follows the map, and
fields (`addField`) are cut in their shader. Shapes (`addShapes`), flows (`addFlow`) and fields on the
model are not clipped yet. `revealPath(g, shape, w, h)` traces the same shape on a canvas, for a cover
under the items or a rim. The Magnifier (`packages/layers/lens`) and the Reveal line
(`packages/layers/swipe`) are the reference layers.

## Building blocks and interactions

Layers are composed from the primitives in `@mrstudio/sdk` (`packages/sdk/src/blocks/`): data sources,
scales, visual blocks, staging and interaction behaviours. The catalogue is [../blocks.md](../blocks.md).

Table pointers are local to the table surface and do not pass through the host. Phone tools arrive
through `tool(input)`; `fromToolInput(input, frame)` turns a point input into the same `PointerSample`,
so a layer routes both to the same behaviours. What other surfaces need goes out with `setParams` or `publish`.
When a pick made with the pointer has to reach every view of the table (the projector window and the
editor's live table run the layer separately), the layer sends it on with `ctx.sendTool(tool, geometry)` and
handles it where it arrives, in `tool(input)`. `packages/layers/coolpaths` is the reference: a click sets the
walk's start or end and dragging A or B moves it.

## Site layers

A site can carry layers of its own, with code, without changing or forking the core (#277). They are packages
like core layers, in the site's `layers/` folder, and the installed app loads them:

```
sites/lindholmen/layers/energy-flows/
  layer.json        as above
  src/index.ts      table(), panel(), hero(), stage() as above, importing from '@mrstudio/sdk'
  locales/sv.json
  build.mjs         bundles src/ into dist/index.js
  dist/index.js     what the app loads; commit it, so the table's computer needs no Node
```

- `mrstudio layer new energy-flows --site sites/lindholmen` writes a working package: rings where the table is
  tapped (`ctx.pointer`, `ctx.sendTool`, `tool`), a primary action on the controller, a stat panel bound to
  `ctx.publish` and a custom panel.
- `mrstudio layer build [id] --site <site> [--watch]` bundles each package with esbuild (it runs `npm install` the
  first time). Building needs Node 20 or newer on the developer's computer; running needs nothing.
- `@mrstudio/sdk` is not bundled: the build turns its imports into reads of `globalThis.MRStudio.sdk`, the SDK of
  the app the layer runs in. A layer therefore always runs against the app's SDK, and `api` in layer.json says
  which contract it was written for; the app refuses a layer of another `api`.
- The host lists every package in `layers/` in the composer's palette, whether or not the scene uses it; a scene
  uses one as `{ "use": "./layers/energy-flows" }`. A package that does not load is left out with a warning,
  unless the scene uses it, in which case the table does not open and says why.
- The host adds `module` to the package's manifest when `dist/index.js` exists (`/site/layers/<id>/dist/index.js?v=<time>`),
  and every surface but the phones imports it before it starts layers. A rebuilt layer is picked up when the
  surface reloads. Without a build the layer is still listed and draws nothing.
- A `.mrstable` export carries the packages with their `dist/`, without `node_modules`.

The rules for layers above apply to site layers too. Anything a site layer needs from the core that the SDK does
not offer is a development request (MCP `draft_development_request`, kind `sdk-runtime`), not a copy of core code.

The MCP server walks a developer through this: `create_layer`, `sdk_reference` (the SDK's exports read from its source), `check_layer` (the rules in this document), `build_layer`, `preview_layer` and `add_service`, and the prompts `build_code_layer` and `build_controller_app` (docs/MCP.md).

## Dev mode

`mrstudio dev --site sites/sample` serves the runtime with the layer loaded against the sample site.
`pnpm dev` runs the host and the web dev server together.
`/dev` shows the table view with the generated controls beside it and a small preview of the TV dashboard under it, in a normal browser, with hot reload.
`/dev` opens with the workbench beside the live table; the **Workbench** button at its foot closes and reopens it beside the live table (#358). It is the same page the editor opens with **Open in a window > Developer**:

- **Widgets:** every widget, core and the site's team widgets, at every size it takes with its made-up `example` props, what each size costs in reads against its budget, and the name to put in `"widget"`. The map and control widgets are shown on a layer that is on.
- **Live values:** each layer's `shared` values and `params` as they change. A click copies the binding (`{"bind":"shared.import_kw"}`) for a panel.
- **Controller:** the controller as the 46-inch screen shows it (1920 by 1080), scaled to fit, so a tap there and its answer on the table are both in view. It shows a stage of panels or a custom one alike.
- **Action log:** this window's requests with their round trip, and what the host sent: actions, tool inputs, param and entity edits from any controller or phone.
- **Problems:** panels the rules refused, bindings to values a layer has not published, and what layers and widgets complained about.

`/edit` (the editor) adds the layer from Insert › New layer, shows it on the map and the controller, and generates its settings in the Format pane.
No table, projector or calibration is needed.
