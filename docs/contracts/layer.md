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

Control types: `range`, `select`, `toggle`, `date`, `color`, `text`, `action` (a button, no stored value).
Every control has `id`, `type`, `label` and `default`. `phone: true` lets phone participants change it.
`visibleWhen: { "mode": "day" }` hides a control unless another control has that value.

The controls are the single source of truth for a layer's params:

- The host builds the initial params from the defaults and the site's overrides.
- The TV and phone surfaces generate their UI from them.
- The host validates and clamps every change against them.

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
});
```

The module is loaded on every surface. `table` runs only on the table surface and `panel` only on the TV, once for each `custom` panel in the manifest. Phones need no code.
State lives in the closure, so a layer has no module-level variables and no explicit teardown:
overlays and streams opened through `ctx` are released when the layer is turned off.
`packages/layers/sunlight` is the reference to copy.

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
  readonly pointer: TablePointer;       // mouse, touch and pen on the table surface
  onFrame(cb: (dt: number) => void): void;   // every animation frame while the layer is on
  onCleanup(cb: () => void): void;      // extra teardown
}

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
  addElement(): HTMLElement;        // a layer-owned element covering the table, for SVG or canvas decorations
  addShapes(id: string, style?: { opacity?: number }): ShapeOverlay;   // points, lines and areas above the fields
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
```

Rules for layers:

1. No solver code. Heavy computation is a kernel or a service.
2. No site paths or coordinates in code. Use `ctx.site` and data declared in `requires.data`.
3. No direct communication between surfaces. Use `setParams` and `publish`.
4. Clean up is automatic for everything opened through `ctx`. Anything else is released with `ctx.onCleanup`.
5. `update` must be cheap. Send params to the stream and return; frames arrive asynchronously.

## Building blocks and interactions

Layers are composed from the primitives in `@mrstudio/sdk` (`packages/sdk/src/blocks/`): data sources,
scales, visual blocks, staging and interaction behaviours. The catalogue is [../blocks.md](../blocks.md).

Table pointers are local to the table surface and do not pass through the host. Phone tools arrive
through `tool(input)`; `fromToolInput(input, frame)` turns a point input into the same `PointerSample`,
so a layer routes both to the same behaviours. What other surfaces need goes out with `setParams` or `publish`.

## Dev mode

`mrstudio dev --site sites/sample` serves the runtime with the layer loaded against the sample site.
`pnpm dev` runs the host and the web dev server together.
`/dev` shows the table view with the generated controls beside it and a small preview of the TV dashboard under it, in a normal browser, with hot reload.
No table, projector or calibration is needed.
