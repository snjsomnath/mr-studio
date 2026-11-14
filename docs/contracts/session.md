# App, display and session contract

## Model

- **Studio**: one installed app on one computer. It runs one host.
- **Session**: one site running in a studio. It has a short join code and holds all shared state.
- **Surface**: a connected page with a role: `table`, `tv`, `phone` or `dev`.
- **Participant**: a person on a phone surface, with a slot (colour and number). The slot belongs to the person, not the connection: it survives a reload or a brief drop (see mobile.md).

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
| `/site/*` | Files from the active site package (read only) |
| `/ws` | WebSocket endpoint |

## State

```ts
interface SessionState {
  protocol: 1;
  session: { id: string; code: string; port: number; join_url: string | null };
  site: SiteInfo;                          // id, name, origin, extent, grid, timezone, table
  layers: Record<string, LayerState>;      // by layer id
  participants: Participant[];
}
interface Participant {
  surface: number;      // the surface in the slot now; changes when the phone reconnects
  slot: number;         // 0-based; stable for as long as the person stays
  colour: string;
  connected: boolean;   // false while the slot is held for a phone that dropped
}
interface LayerState {
  active: boolean;
  params: Record<string, unknown>;         // validated against the layer's controls
  shared: Record<string, unknown>;         // published by the table surface
}
```

`session.join_url` is the address the TV's QR code carries, `http://<address>:<port>/phone?c=<code>`.
The host works the address out from the interface it listens on. It is `null` when the host listens on the loopback interface only, and it can be set outright (`SessionOptions::public_url`, `mrstudio dev --public-url`) when phones reach the studio through something else, such as the web dev server or a relay.

## Wire protocol

Text frames are JSON. Binary frames are engine field frames (see engine.md).

```ts
// surface to host
{ t: 'hello', protocol: 1, role: 'table' | 'tv' | 'phone' | 'dev', code?: string, resume?: string }
{ t: 'req', id: number, m: string, p?: object }

// host to surface
{ t: 'welcome', surface: number, state: SessionState, manifests: LayerManifest[], resume?: string }
{ t: 'refused', e: string }                 // wrong code, session full, protocol mismatch; also sent later, see below
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
| `tool.input` | `{ layer, tool, geometry }` | all | Checked, then forwarded to the table |
| `engine.*` | see engine.md | table, tv, dev | Kernel streams |

Events:

| Event | Payload |
| --- | --- |
| `state.layer` | `{ layer, state: LayerState }` after any change to a layer |
| `state.participants` | `{ participants }` |
| `layer.action` | `{ layer, action, from }` |
| `tool.input` | `{ layer, tool, geometry, from, participant? }` |

Rules:

- A surface applies a param change only when the host broadcasts it. Controls may show the value optimistically.
- The host clamps numbers to `min` and `max`, snaps to `step`, and rejects unknown controls and options.
- Events for one layer are delivered in order. A slow surface receives the latest state, not a backlog: field frames are dropped rather than queued, and a surface that falls behind on events gets one `resync`.
- Only `table` and `dev` surfaces may publish.
- `tool.input` geometry is GeoJSON in WGS84 and must match the tool's type: `Point` for `point`, `LineString` (2 or more positions) for `line`, `Polygon` (closed rings) for `polygon`, at most 256 positions in all. The host forwards only `type` and `coordinates`, with positions cut to `[lon, lat]`. Input for a layer that is off is refused. `from` is the sending surface; `participant` is `{ slot, colour }` when it is a phone, so a layer can draw in the sender's colour without tracking participants.
- `resume` in `welcome` is given to phones only. Sent back in a later `hello` (with the code) it returns the phone to its slot; an unknown or expired token is an ordinary new join.
- `refused` can also arrive after `welcome`, when the same phone joins again with its token (a reload that beat the old connection's close, or a second tab). The older connection gets `refused` and is closed, and must not reconnect.
- The host accepts 20 requests per second from each phone, with bursts up to 20. Further requests are answered `ok: false` with `e: 'rate limited'` and have no effect. Other roles are not limited.
- The host pings every surface every 10 seconds and closes a connection it has not heard from for 30 seconds.
