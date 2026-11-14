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

Tools are spatial inputs a layer accepts: `point`, `line`, `polygon`. The input system (touch, phone, hand tracking) delivers them as `ToolInput` with coordinates in WGS84.

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

  // Optional TV panel, mounted while the layer is on.
  panel(ctx, el) {
    el.textContent = '...';
    return { update() {} };                                 // params or shared values changed
  },
});
```

The module is loaded on every surface. `table` runs only on the table surface and `panel` only on the TV. Phones need no code.
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
  onFrame(cb: (dt: number) => void): void;   // every animation frame while the layer is on
  onCleanup(cb: () => void): void;      // extra teardown
}

// PanelContext has site, params, setParams, shared and onCleanup.

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
  addField(id: string, style: { colormap: Colormap; opacity?: number; smooth?: boolean }): FieldOverlay;
}

interface FieldOverlay {
  set(frame: FieldFrame): void;     // uploads the frame as a texture, coloured on the GPU
  setStyle(style: { colormap?: Colormap; opacity?: number; smooth?: boolean }): void;
  remove(): void;
}
```

Rules for layers:

1. No solver code. Heavy computation is a kernel or a service.
2. No site paths or coordinates in code. Use `ctx.site` and data declared in `requires.data`.
3. No direct communication between surfaces. Use `setParams` and `publish`.
4. Clean up is automatic for everything opened through `ctx`. Anything else is released with `ctx.onCleanup`.
5. `update` must be cheap. Send params to the stream and return; frames arrive asynchronously.

## Dev mode

`mrstudio dev --site sites/sample` serves the runtime with the layer loaded against the sample site.
`pnpm dev` runs the host and the web dev server together.
`/dev` shows the table view with the generated controls beside it, in a normal browser, with hot reload.
No table, projector or calibration is needed.
