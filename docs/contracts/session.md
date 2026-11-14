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

A display is matched by name first (exactly, then as part of the name), then by index. `index` is the position in the order the system lists displays.
`role` is `table`, `tv` or `dev`. A window whose display is not connected opens on the primary display.
The shell never uses browser popups, so there are no permission prompts.

The launcher is the shell's own window with the site picker and the display picker. It writes `displays.json`, and keeps its other choices in `studio.json` beside it:

```jsonc
// studio.json
{
  "sites": ["D:/sites/chalmers"],   // site folders added by hand
  "site": "D:/sites/chalmers",      // the site that ran last
  "lan": false,                     // listen on the local network so phones can join
  "autostart": true,                // start `site` on the saved displays without showing the launcher
  "skip_update_check": false        // true stops the look for a newer version at start-up
}
```

What the shell does when it starts:

| Start | Result |
| --- | --- |
| `displays.json` exists, `autostart` is on and `site` is set | Runs the site on the saved displays. If that fails, the launcher opens and says why |
| Anything else, or `mr-studio --setup` | The launcher opens. With no `displays.json` it suggests the table on the second display and the TV on the primary one, or one `dev` window if there is a single display |
| `mr-studio <site folder>` or `MRS_SITE` | Runs that site on the saved displays, or in one windowed `dev` window if there are none |

The site picker lists site folders added by hand, the packages in `Documents/MR Studio/sites`, and the sample site shipped inside the app.
With `lan` off the host listens on this computer only (127.0.0.1), so Windows shows no firewall prompt. The host uses port 4170, or a free port if that one is taken.

In a running session, Ctrl+Shift+S (Cmd on macOS) in any window opens the launcher and Ctrl+Shift+Q quits. A surface asks for these by navigating to `/__shell/setup` or `/__shell/quit`, which the shell intercepts; surfaces have no other access to the shell.
Starting the app a second time brings up the launcher of the one already running.

### Colour per display

The shell applies a final colour pass to every window on a display, because a projector on a physical model usually needs more saturation and contrast than a monitor.
The launcher's Colour tab edits it live, with a test card, and saves it in `colour.json` beside `displays.json`:

```jsonc
// colour.json
{
  "displays": {                      // by display name, or "#<index>" for a display without one
    "EPSON PJ": { "saturation": 1.35, "brightness": 1, "contrast": 1.12, "gamma": 1.1, "temperature": 0, "tint": 0 }
  },
  "presets": { "Evening demo": { "saturation": 1.6, "contrast": 1.2 } },  // saved on this machine, besides the built-in ones
  "layers": { "chalmers": { "sunlight": 1.4 } }                            // layer intensity by site id and layer id
}
```

Ranges: `saturation` 0 to 2.5, `brightness` 0.5 to 1.5, `contrast` 0.5 to 2, `gamma` 0.5 to 2.5 (above 1 lifts midtones), `temperature` and `tint` -1 to 1 (white balance, applied as channel gains that never exceed 1). Missing values are neutral.
The pass is one CSS filter on the page's root element, injected by the shell, in the order saturation, white balance, gamma, contrast, brightness. Surfaces and layers do not know about it and must not set a filter on the root element themselves. It is per display, not per layer.

The same tab has a slider per layer of the running session for `LayerState.intensity`. The shell sends `layer.intensity` to the host with the TV's rights, saves values other than 1 under `layers`, and sends them again when that site next starts.

### Calibration tab

The launcher's Calibration tab does not calibrate anything itself. It shows the running site's saved projector calibration (when, and the average error), sends `calibration.mode` to open or close the tool on the table surface and moves the keyboard focus to the table window, and can clear the calibration with `calibration.set { projector: null }`. The tool and the file format are in [model.md](model.md).

Surface URLs served by the host:

| URL | Surface |
| --- | --- |
| `/table` | Projected table view |
| `/tv` | Controller and dashboards |
| `/phone` | Phone controller |
| `/dev` | Table view with controls side by side, for layer development |
| `/site/*` | Files from the active site package (read only) |
| `/api/model` | The site's digital twin mesh (see model.md) |
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
  intensity: number;                       // 0..2, how strongly the layer is drawn on the table; 1 is as designed
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
| `layer.intensity` | `{ layer, intensity }` | table, tv, dev | Sets how strongly the layer is drawn, clamped to 0..2. The runtime applies it to the layer's overlays and decorations; layers need no code |
| `layer.set` | `{ layer, params }` | all (phones only for `phone: true` controls) | Validates, merges, broadcasts |
| `layer.action` | `{ layer, action }` | all (phones only for `phone: true`) | Broadcast to the table |
| `layer.publish` | `{ layer, values }` | table, dev | Merges into `shared`, broadcasts |
| `tool.input` | `{ layer, tool, geometry }` | all | Checked, then forwarded to the table |
| `engine.*` | see engine.md | table, tv, dev | Kernel streams |
| `calibration.get` | none | table, tv, dev | Returns `{ projector }`, the saved projector calibration or null (see model.md) |
| `calibration.set` | `{ projector }` | table, tv, dev | Saves it to the site's `calibration.json` (null clears it) and broadcasts `calibration` |
| `calibration.mode` | `{ active }` | table, tv, dev | Asks the table to open or close its calibration tool |

Events:

| Event | Payload |
| --- | --- |
| `state.layer` | `{ layer, state: LayerState }` after any change to a layer |
| `state.participants` | `{ participants }` |
| `layer.action` | `{ layer, action, from }` |
| `tool.input` | `{ layer, tool, geometry, from, participant? }` |
| `calibration` | `{ projector }` after a calibration was saved or cleared |
| `calibration.mode` | `{ active }` |

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
