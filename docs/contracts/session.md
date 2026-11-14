# App, display and session contract

## Model

- **Studio**: one installed app on one computer. It runs one host.
- **Session**: one site running in a studio. It has a short join code and holds all shared state.
- **Surface**: a connected page with a role: `table`, `tv`, `phone` or `dev`.
- **Participant**: a person on a phone surface, with a slot (colour and number).

One session runs at a time. The host is the only authority over its state.

## Displays

The shell opens one borderless fullscreen window per configured display and loads a surface URL into it.
Display assignment is per machine, not per site, and lives in the app's config folder:

```jsonc
// displays.json
{
  "windows": [
    { "role": "table", "display": { "name": "EPSON PJ", "index": 1 }, "fullscreen": true },
    { "role": "tv",    "display": { "index": 0 }, "fullscreen": true }
  ]
}
```

A display is matched by name first, then by index. If no file exists, the shell opens one `dev` window on the primary display and a display picker.
The shell never uses browser popups, so there are no permission prompts.

Surface URLs served by the host:

| URL | Surface |
| --- | --- |
| `/table` | Projected table view |
| `/tv` | Controller and dashboards |
| `/phone` | Phone controller |
| `/dev` | Table view with controls side by side, for layer development |
| `/compose` | Scene composer: layer palette, table view and the scene's stack. Joins with the `dev` role |
| `/site/*` | Files from the active site package (read only) |
| `/ws` | WebSocket endpoint |

## State

```ts
interface SessionState {
  protocol: 1;
  session: { id: string; code: string; port: number };
  site: SiteInfo;                          // id, name, origin, extent, grid, timezone, table, data
  scene: string[];                         // layer instance ids in draw order, bottom first
  layers: Record<string, LayerState>;      // by instance id (the layer id unless site.json names the entry)
  participants: Participant[];
}
interface LayerState {
  layer: string;                           // the layer package this instance runs
  active: boolean;
  params: Record<string, unknown>;         // validated against the layer's controls
  shared: Record<string, unknown>;         // published by the table surface
}
```

## Wire protocol

Text frames are JSON. Binary frames are engine field frames (see engine.md).

```ts
// surface to host
{ t: 'hello', protocol: 1, role: 'table' | 'tv' | 'phone' | 'dev', code?: string }
{ t: 'req', id: number, m: string, p?: object }

// host to surface
{ t: 'welcome', surface: number, state: SessionState, manifests: LayerManifest[] }   // manifests: every layer that can be in a scene
{ t: 'refused', e: string }                 // wrong code, session full, protocol mismatch
{ t: 'resync', state: SessionState, ... }   // the surface fell behind; replace all state
{ t: 'res', id: number, ok: true, r?: object } | { t: 'res', id: number, ok: false, e: string }
{ t: 'ev', m: string, p: object }
```

Requests:

| Method | Params | Roles | Effect |
| --- | --- | --- | --- |
| `layer.activate` | `{ layer, active }` | table, tv, dev | Turns a layer on or off |
| `layer.set` | `{ layer, params }` | all (phones only for `phone: true` controls) | Validates, merges, broadcasts |
| `layer.action` | `{ layer, action }` | all (phones only for `phone: true`) | Broadcast to the table |
| `layer.publish` | `{ layer, values }` | table, dev | Merges into `shared`, broadcasts |
| `tool.input` | `{ layer, tool, geometry }` | all | Forwarded to the table |
| `engine.*` | see engine.md | table, tv, dev | Kernel streams |
| `scene.add` | `{ use, id?, index?, active?, params? }` | tv, dev | Adds a layer from the catalogue at `index` (default: on top, active). Returns `{ id }`; without `id` the first copy is named after the layer and later ones `<layer>-2`, `-3`, ... |
| `scene.remove` | `{ layer }` | tv, dev | Takes a layer out of the scene |
| `scene.move` | `{ layer, index }` | tv, dev | Moves a layer to `index` in the draw order (0 is the bottom) |
| `scene.set` | `{ layer, params?, active? }` | tv, dev | Like `layer.set` and `layer.activate`, and also saved as the layer's starting state |

In every `layer.*` and `tool.input` request, `layer` is the instance id.
The `scene.*` requests rewrite the `layers` list of `site.json` before they take effect, and fail without changing anything if it cannot be saved.
`layer.set` and `layer.activate` change the running session only, so a slider moved on the TV or a phone is not written to the site.

Events:

| Event | Payload |
| --- | --- |
| `state.layer` | `{ layer, state: LayerState }` after any change to a layer |
| `state.scene` | `{ scene, layers }` after a layer was added, removed or moved: the new order and every layer's state |
| `state.participants` | `{ participants }` |
| `layer.action` | `{ layer, action, from }` |
| `tool.input` | `{ layer, tool, geometry, from }` |

Rules:

- A surface applies a param change only when the host broadcasts it. Controls may show the value optimistically.
- The host clamps numbers to `min` and `max`, snaps to `step`, and rejects unknown controls and options.
- Events for one layer are delivered in order. A slow surface receives the latest state, not a backlog: field frames are dropped rather than queued, and a surface that falls behind on events gets one `resync`.
- Only `table` and `dev` surfaces may publish.
