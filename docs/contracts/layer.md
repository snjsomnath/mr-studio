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
`alongside: true` keeps the layer open when another layer's button is pressed, and lets it open without closing the others. Use it for a tool people keep while they look at something else, such as the sketch layer. Default false.
Any open button layer pauses the map at rest's life on the table, keeping only the base map (#303). `hidesAtRest: true` turns the whole map at rest off while the layer is open, the base map included: every top-level `base` and `ambient` layer stops, and starts again when the layer closes. The host's state does not change, so the controller and editor still show them as on. The slideshow does this, so slides are seen on their own (#205). Default false.

`sequence: true` makes the layer a sequence: an instance of it may have `steps.sequence`, steps that show other layers one after another (see site.md). The slideshow is one.
`legend` and `attract` are proposed in [present.md](present.md); site format 3 already carries them for custom layers.
`requires.data` lists the site datasets the layer reads, by name (see `data` in site.md). A layer must still start when one is missing.

Control types: `range`, `select`, `toggle`, `date`, `color`, `text`, `action` (a button, no stored value).
Every control has `id`, `type`, `label` and `default`. `phone: true` lets phone participants change it.
`visibleWhen: { "mode": "day" }` hides a control unless another control has that value; a list, `{ "style": ["light", "dark"] }`, means any of them.

The controls are the single source of truth for a layer's params:

- The host builds the initial params from the defaults and the site's overrides.
- The TV and phone surfaces generate their UI from them.
- The host validates and clamps every change against them.

`requires` states what the layer needs from the app and the site:

- `kernels`: engine kernels it opens streams on.
- `data`: named datasets the site must provide. A site maps each name to a file under `data` in `site.json` (see site.md), and the host refuses to start a site, or to add a layer to a scene, when one is missing; the composer's palette says so beforehand. The scene's `buildings` and `trees` count as datasets. The layer loads it with `loadSiteData(ctx.site, name)`. A layer may also use a dataset it does not require: it checks `hasSiteData(ctx.site, name)` and does without when the site has none. A raster dataset (a GeoTIFF, or a folder of one GeoTIFF per hour such as `pet_08.tif` .. `pet_20.tif`) is read laid on the site grid with `loadSiteField(ctx.site, name, hour)`: a field frame of exact values, NaN where the raster has no data, null when a folder has no raster for that hour (`GET /api/data/field?name=&hour=`).
- `services`: Python services it reaches through the gateway.

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

Tools are spatial inputs a layer accepts: `point`, `line`, `polygon`. Each is `{ "id", "type", "label" }`. The input system (touch, phone) delivers them as `ToolInput` with coordinates in WGS84:

```ts
interface ToolInput {
  layer: string;
  tool: string;                                   // the tool's id
  geometry: ToolGeometry;                         // GeoJSON Point, LineString or Polygon, checked by the host
  from: number;                                   // the sending surface
  participant?: { slot: number; colour: string }; // when it came from a phone
}
```

A phone shows a layer's tools on a small map as soon as the manifest declares them; the layer writes no phone code.
`packages/layers/sketch` is the reference for a layer with tools.

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
      action(id) {},                                        // an action control was pressed
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
});
```

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
  src/index.ts      table(), panel(), hero() as above, importing from '@mrstudio/sdk'
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
not offer is a module request (MCP `draft_module_request`), not a copy of core code.

## Dev mode

`mrstudio dev --site sites/sample` serves the runtime with the layer loaded against the sample site.
`pnpm dev` runs the host and the web dev server together.
`/dev` shows the table view with the generated controls beside it and a small preview of the TV dashboard under it, in a normal browser, with hot reload.
`/compose` shows the palette, the table and the scene's stack: drag layers in, reorder them and edit their settings.
No table, projector or calibration is needed.
