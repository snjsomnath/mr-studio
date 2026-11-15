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

The shell has two windows of its own. **Home** is the first one: the tables on this computer, **New table** and **Open a folder**. **Displays and settings** (called the launcher below) has the display picker, colour, calibration and updates. It writes `displays.json`, and keeps its other choices in `studio.json` beside it:

```jsonc
// studio.json
{
  "sites": ["D:/sites/chalmers"],   // site folders added by hand
  "site": "D:/sites/chalmers",      // the site that ran last
  "lan": false,                     // listen on the local network so phones can join
  "autostart": true,                // start `site` on the saved displays without showing the launcher
  "skip_update_check": false,       // true stops the look for a newer version at start-up
  "recent": ["D:/sites/chalmers"]   // the sites opened last, newest first; they top the launcher's list
}
```

### Editing and presenting

A site that is open is in one of two states: open in the editor, or also presented on the displays. Both use the same running host, so what is authored is what is shown.

- Opening a table from Home runs the site and opens the editor window: the host's `/edit` page in a normal window. Nothing goes on the displays. Closing the editor window leads back to Home.
- **New table** is a wizard. With `features.json` in the web bundle saying `{ "new_table_wizard": true }`, the editor window opens at `/new` (over the sample site, because a host needs a site) and that page asks the first questions and calls `create_site` then `open_site`. Without it, Home asks for the name, the place (coordinates or a pasted map link) and the size itself. Either way the new table opens at `/edit?welcome=1`, where the editor continues the wizard.
- **Present** opens the surface windows on the displays; **Stop presenting** closes them. The editor stays open and the session keeps its state. The launcher's Present button does the same for a site without opening the editor.
- A new site is created in the sites folder with a base map and sunlight; the same code backs `mrstudio new-site`.

The editor window is the only remote page with access to the shell, and only to these commands, through `window.__TAURI__.core.invoke` (see `capabilities/editor.json`):

| Command | Does |
| --- | --- |
| `presenting_state` | `{ version, site, presenting, displays, windows }`: the connected displays and the windows Present would open |
| `present { windows? }` | Presents. `windows` is a list of `{ display, role, fullscreen }` (display by index in `displays`) and is saved as `displays.json`; without it the saved displays are used |
| `stop_presenting` | Closes the surface windows |
| `open_home` | Opens Home |
| `open_settings` | Opens Displays and settings |
| `create_site { site: { name, lat, lon, width_m, height_m } }` | Creates a table in the sites folder with a base map, and sunlight ready to open. Returns its folder |
| `open_site { path, welcome? }` | Runs that table and shows it in the editor window, at `/edit`, or `/edit?welcome=1` when `welcome` is true |
| `open_home` | Opens the launcher |
| `quit` | Quits the app |

The shell adds a small bar to the editor window with Present, Stop presenting and "Sites and displays". When the page has an element with `data-shell-present` (its own Present button) the bar leaves Present to the page and shows Stop only while presenting. A page that sets `window.mrsShellControls = true` before it finishes loading gets no bar. The editor at `/edit` does this: its title bar has Present, which becomes Stop presenting, and Home. The page must work without `window.__TAURI__` too, for an editor opened in a browser.

What the shell does when it starts:

| Start | Result |
| --- | --- |
| `displays.json` exists, `autostart` is on and `site` is set | Presents the site on the saved displays, with no editor. If that fails, Home opens and says why |
| Anything else | Home opens |
| `mr-studio --setup` | Displays and settings opens. With no `displays.json` it suggests the table on the second display and the TV on the primary one, or one `dev` window if there is a single display |
| `mr-studio <site folder>` or `MRS_SITE` | Presents that site on the saved displays, or in one windowed `dev` window if there are none |

The site picker lists site folders added by hand, the packages in the sites folder (`Documents/MR Studio/sites`, or `sites` in the app's data folder on a computer without Documents), and the sample site shipped inside the app.
With `lan` off the host listens on this computer only (127.0.0.1), so Windows shows no firewall prompt. The host uses port 4170, or a free port if that one is taken.

In a running session, Ctrl+Shift+S (Cmd on macOS) in any window opens the launcher, Ctrl+Shift+Q quits, and Ctrl+Shift+E on a surface stops presenting and goes back to the editor. A surface asks for these by navigating to `/__shell/setup`, `/__shell/quit` or `/__shell/edit`, which the shell intercepts; surfaces have no other access to the shell.
Starting the app a second time brings up Home of the one already running.

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
| `/compose` | Scene composer: layer palette, table view and the scene's stack. Joins with the `dev` role |
| `/edit` | The editor: the authoring window around the live table. The home screen holds layers of category `base` and `ambient`; every other layer is a layer of its own. Joins with the `dev` role. With `?welcome=1` or `?setup=1`, or when the table has no layers yet, it opens in the setup guide |
| `/new` | The first step of the setup wizard, for a table that does not exist yet: name, place and size. It joins no session. Inside the desktop app it calls `create_site { site: { name, lat, lon, width_m, height_m } }`, then `open_site { path, welcome: true }`; Cancel calls `open_home` |
| `/features.json` | What this build of the surfaces offers the shell: `{ "new_table_wizard": true }` |
| `/site/*` | Files from the active site package (read only) |
| `/api/model` | The site's digital twin mesh (see model.md) |
| `/ws` | WebSocket endpoint |

## State

```ts
interface SessionState {
  protocol: 1;
  session: { id: string; code: string; port: number; join_url: string | null };
  site: SiteInfo;                          // id, name, origin, extent, grid, timezone, table, data, tv
  scene: string[];                         // layer instance ids in draw order, bottom first
  layers: Record<string, LayerState>;      // by instance id (the layer id unless site.json names the entry)
  participants: Participant[];
}
interface Participant {
  surface: number;      // the surface in the slot now; changes when the phone reconnects
  slot: number;         // 0-based; stable for as long as the person stays
  colour: string;
  connected: boolean;   // false while the slot is held for a phone that dropped
}
interface LayerState {
  layer: string;                           // the layer package this instance runs
  active: boolean;
  intensity: number;                       // 0..2, how strongly the layer is drawn on the table; 1 is as designed
  params: Record<string, unknown>;         // validated against the layer's controls
  shared: Record<string, unknown>;         // published by the table surface
  button: { name?: string; description?: string; icon?: string; side?: 'left' | 'right' };  // the site's own words for the layer on the controller; empty fields fall back to layer.json
}
```

`session.join_url` is the address the TV's QR code carries, `http://<address>:<port>/phone?c=<code>`.
The host works the address out from the interface it listens on. It is `null` when the host listens on the loopback interface only, and it can be set outright (`SessionOptions::public_url`, `mrstudio dev --public-url`) when phones reach the studio through something else, such as the web dev server or a relay.

## Bringing data into a site

Two HTTP endpoints take a file as the request body (any content type), with its name in an `X-Filename` header. Only this computer may call them: the host listens on the network while presenting, and a request from another address gets 403.

```
POST /api/data/inspect?target=<target>[&crop=1][&swap=1][&crs=EPSG:<code>]   reads and checks, writes nothing
POST /api/data/import?target=<target>[&crop=1][&swap=1][&crs=EPSG:<code>]    the same, then saves, re-bakes and sends `site.changed`
```

| `target` | Accepts | Saved as | `site.json` |
| --- | --- | --- | --- |
| `buildings` | GeoJSON polygons | `data/buildings.geojson` | `scene.buildings` (`height_property` set to what was found) |
| `trees` | GeoJSON points, or CSV with position columns | `data/trees.geojson` | `scene.trees` |
| `walkways` | GeoJSON lines | `data/walkways.geojson` | `data.walkways` |
| `trips` | The mobility layer's `trips.json` | `data/trips.json` | `data.trips` |
| `terrain` | A GeoTIFF of ground heights | `data/terrain.tif` | `scene.terrain` (`crs` only when the file does not name it) |
| `data:<name>` | GeoJSON, or CSV with position columns | `data/<name>.geojson` | `data.<name>` |

Settings already in `scene.buildings` or `scene.trees` are kept. Coordinates that are not WGS84 are recognised when the file names its system or when SWEREF99 TM, a SWEREF99 local zone or the site's UTM zone puts them on the table, and are converted. Buildings with only `building:levels` (or `levels`, `floors`, `våningar`) get a height of 3 m a storey. A terrain GeoTIFF that only cites its grid is tried as SWEREF99 TM, the local zones, the site's UTM zone and WGS84, and the first that covers the table is kept and written as `crs`; `crs=EPSG:<code>` names it outright. Its report says how much of the table it covers and the range of ground heights. `crop=1` leaves out what lies more than a tenth of the table's size outside it; `swap=1` reads the first coordinate as latitude.

Both answer with a report: 200 when it can be imported, 422 when a blocker stops it (nothing is written), 400 for a bad request such as an unknown target.

```ts
interface ImportReport {
  ok: boolean;
  target: string;            // 'buildings', 'trees', 'walkways', 'trips' or the dataset name
  summary: string;           // one sentence: '788 buildings, 702 with a height'
  count: number;             // items read
  inside: number;            // on the table
  outside: number;
  crs?: { code: string; guessed: boolean };   // 'EPSG:3006', guessed when the file did not say
  height_property?: string;  // buildings and trees
  issues: { code: string; severity: 'blocker' | 'warning' | 'note'; message: string; fix?: 'crop' | 'swap' }[];   // a terrain with code 'coords.unknown' needs `crs`
  preview?: GeoJSON.FeatureCollection;        // what will be written, WGS84, in file order, at most 5000 features; not for trips
  path?: string;             // after an import: where it was saved
}
```

`message` is written for the author and can be shown as it is. `fix` names the option that applies the recommended fix, so an editor can offer it as a button and send the same file again with that option.

## Wire protocol

Text frames are JSON. Binary frames are engine field frames (see engine.md).

```ts
// surface to host
{ t: 'hello', protocol: 1, role: 'table' | 'tv' | 'phone' | 'dev', code?: string, resume?: string }
{ t: 'req', id: number, m: string, p?: object }

// host to surface
{ t: 'welcome', surface: number, state: SessionState, manifests: LayerManifest[], resume?: string }   // manifests: every layer that can be in a scene
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
| `scene.add` | `{ use, id?, index?, active?, params? }` | tv, dev | Adds a layer from the catalogue at `index` (default: on top, active). Returns `{ id }`; without `id` the first copy is named after the layer and later ones `<layer>-2`, `-3`, ... |
| `scene.remove` | `{ layer }` | tv, dev | Takes a layer out of the scene |
| `scene.move` | `{ layer, index }` | tv, dev | Moves a layer to `index` in the draw order (0 is the bottom) |
| `scene.set` | `{ layer, params?, active?, button?, hide? }` | tv, dev | Like `layer.set` and `layer.activate`, and also saved as the layer's starting state. `button` is `{ name?, description?, icon?, side? }`: text sets a field, `null` clears it, a field left out stays. `hide` is the whole list of control ids the controller and phones leave out. `scene.add` takes `button` and `hide` too |

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
| `tool.input` | `{ layer, tool, geometry, from, participant? }` |
| `calibration` | `{ projector }` after a calibration was saved or cleared |
| `calibration.mode` | `{ active }` |
| `site.changed` | `{ site: SiteInfo }` after data was imported: the scene is re-baked and the engine and twin already use it. Replace `state.site`; layers that read site data at start need a reload |

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
