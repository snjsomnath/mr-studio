# App, display and session contract

## Model

- **Studio**: one installed app on one computer. It runs one host.
- **Session**: one site running in a studio. It has a short join code and holds all shared state.
- **Surface**: a connected page with a role: `table`, `tv`, `phone`, `guide` or `dev`.
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

The shell has two windows of its own. **Home** is the first one: the tables on this computer, **New table** and **Open a folder**. **Displays and settings** (called the launcher below; restyled to the editor's light identity in #40) has Screens (which display shows the table and which the controller, saved with `save_displays` as it is chosen), Calibration, Colour, Phones and startup (saved with `save_settings { lan, autostart }`; a running table restarts on the new network setting) and Updates. Opening tables is Home's job. It writes `displays.json`, and keeps its other choices in `studio.json` beside it:

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
- **Present** opens the surface windows on the displays; **Stop presenting** (or Esc on a surface while the editor is open) closes them. Without a saved choice that still fits the connected displays, Present guesses from each display's make and model (#188): the table goes fullscreen on a projector (Epson, Optoma, BenQ, ViewSonic, XGIMI and the like, or a name with "projector" or "PJ"), else on a display other than the primary one, and the controller (`tv`) fullscreen on a TV ("TV", Bravia, Samsung, Philips, TCL, Hisense and the like), else on the primary one. On Windows the make and model come from the display's EDID, since the system name is `\\.\DISPLAYn`. With a single display, the table alone goes fullscreen on it. A saved choice fits when every window finds its display and no two windows share one; a saved `dev` window alone, which older versions wrote before anything was chosen, does not count. The editor stays open and the session keeps its state.
- A new site is created in the sites folder with a base map and sunlight; the same code backs `mrstudio new-site`.

The editor window is the only remote page with access to the shell, and only to these commands, through `window.__TAURI__.core.invoke` (see `capabilities/editor.json`):

| Command | Does |
| --- | --- |
| `presenting_state` | `{ version, site, presenting, displays, windows, configured }`: the connected displays (each with `model` and `kind`: `projector`, `tv` or null) and the windows Present would open; `configured` is false when those are the automatic guess |
| `save_displays { windows }` | Saves the table and controller displays as `present` does, without presenting; while presenting, the windows move at once. An empty list forgets the choice. Used by the Display tab's Screens group (#188) |
| `identify` | Shows each display's number on it for a few seconds |
| `present { windows? }` | Presents. `windows` is a list of `{ display, role, fullscreen }` (display by index in `displays`) and is saved as `displays.json`; without it the saved displays are used while they fit, else the automatic choice above |
| `stop_presenting` | Closes the surface windows |
| `open_home` | Opens Home |
| `open_settings` | Opens Displays and settings |
| `create_site { site: { name, lat, lon, width_m, height_m, rotation_deg? } }` | Creates a table in the sites folder with a base map, and sunlight ready to open. `rotation_deg` turns it clockwise from north (default 0). Returns its folder |
| `open_site { path, welcome? }` | Runs that table and shows it in the editor window, at `/edit`, or `/edit?welcome=1` when `welcome` is true |
| `open_home` | Opens the launcher |
| `quit` | Quits the app |
| `colour_state`, `set_colour { display, colour }`, `save_preset { name, colour }`, `delete_preset { name }`, `test_card { display, on }`, `set_layer_intensity { layer, intensity }` | The colour pass of each display and how strongly each layer is drawn, the same commands as the Colour tab of Displays and settings. Used by the editor's Display ribbon tab (#151) |
| `calibration_state`, `calibration_mode { active }`, `calibration_clear` | Whether a window shows the table, and opening or closing the calibration tool there (#153) |

The shell adds a small bar to the editor window with Present, Stop presenting and "Sites and displays". When the page has an element with `data-shell-present` (its own Present button) the bar leaves Present to the page and shows Stop only while presenting. A page that sets `window.mrsShellControls = true` before it finishes loading gets no bar. The editor at `/edit` does this: its title bar has Present, which becomes Stop presenting, and Home. The page must work without `window.__TAURI__` too, for an editor opened in a browser.

What the shell does when it starts:

| Start | Result |
| --- | --- |
| `displays.json` exists, `autostart` is on and `site` is set | Presents the site on the saved displays, with no editor. If that fails, Home opens and says why |
| Anything else | Home opens |
| `mr-studio --setup` | Displays and settings opens. With no `displays.json` it suggests the table on a projector and the controller on a TV, by their makers, else as Present does |
| `mr-studio <site folder>` or `MRS_SITE` | Presents that site on the saved displays, or on the automatic choice when none fit |

The site picker lists site folders added by hand, the packages in the sites folder (`Documents/MR Studio/sites`, or `sites` in the app's data folder on a computer without Documents), and the sample site shipped inside the app.
With `lan` off the host listens on this computer only (127.0.0.1), so Windows shows no firewall prompt. The host uses port 4170, or a free port if that one is taken.

In a running session, Ctrl+Shift+S (Cmd on macOS) in any window opens the launcher, Ctrl+Shift+Q quits, and Ctrl+Shift+E on a surface stops presenting and goes back to the editor. Esc on a surface does the same when an editor window is open; a table presenting by itself ignores it, and so does any page that handled the key itself (`preventDefault`). A surface asks for these by navigating to `/__shell/setup`, `/__shell/quit`, `/__shell/edit` or `/__shell/escape`, which the shell intercepts; surfaces have no other access to the shell.
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
| `/guide` | The guide's phone (#98): `?g=<guide code>`. Starts a slideshow, shows each step's notes and moves it with Next and Previous |
| `/dev` | Table view with controls side by side, for layer development |
| `/compose` | Scene composer: layer palette, table view and the scene's stack. Joins with the `dev` role |
| `/edit` | The editor: the authoring window around the live table. The home screen holds layers of category `base` and `ambient`; every other layer is a layer of its own. Joins with the `dev` role. With `?welcome=1` or `?setup=1`, or when the table has no layers yet, it opens in the setup guide |
| `/new` | The first step of the setup wizard, for a table that does not exist yet: name, place and size. It joins no session. Inside the desktop app it calls `create_site { site: { name, lat, lon, width_m, height_m, rotation_deg? } }`, then `open_site { path, welcome: true }`; Cancel calls `open_home` |
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
  parent?: string;                         // for an item: the layer it belongs to
  steps?: Steps;                           // how Next moves through it, and a sequence's steps, as site.json has them
  step?: StepState;                        // where Next is, while the layer is on (see below)
  shown_by?: string;                       // for the layer a sequence is showing as its current step: that sequence
}
interface StepState {
  index: number;                           // a sequence: its current step. Any other layer: how many sub-steps are revealed, 0..count
  count: number;
  sub?: { index: number; count: number };  // a sequence: the shown layer's sub-steps
  playing: boolean;                        // moving on by itself (timed mode)
  title?: string; description?: string; source?: string;  // a sequence's current step, for the controller's info strip
  titles?: string[];                       // what each sub-step is called
}
```

**Steps.** A sequence (the slideshow) has `step` from the moment it turns on, at step 0. The host shows the current step's layer: it turns that layer on with the step's params (its own params come back when the step ends) and sets its `shown_by`; the layer shown before goes off. Turning the sequence off turns off the layer it shows. Opening a shown layer with `layer.activate` (its own button) takes it out of the sequence, so it stays on when the sequence closes. A sequence's own items come on only as its steps show them.

A layer that reveals its parts one at a time reports how many with `layer.substeps` when it starts (`ctx.steps.define` in the SDK); its `step` then counts them, and a sequence showing it mirrors them in `step.sub`. Next on a sequence reveals the shown layer's next sub-step first; after the last one it moves on to the next step, or stays when the step's `next` (or the sequence's `reveal`) is `"stop"`. `"skip"` always moves on. `"previous"` goes to the start of the previous step. In timed mode the host moves on after each step's `duration_s` (default 8 s), playing sub-steps 1.4 s apart first. `loop` (default true) goes back to the first step after the last; without it a playing sequence stops at the end.

`session.join_url` is the address the TV's QR code carries, `http://<address>:<port>/phone?c=<code>`.
The host works the address out from the interface it listens on. It is `null` when the host listens on the loopback interface only, and it can be set outright (`SessionOptions::public_url`, `mrstudio dev --public-url`) when phones reach the studio through something else, such as the web dev server or a relay.

## Rasters on the site grid

```
GET /api/data/field?name=<dataset>[&hour=<0-23>]
```

Reads a raster dataset of the site (`data` in site.json: a GeoTIFF, or a folder of one GeoTIFF per hour whose file names end in the two-digit hour) and samples it at the centre of every grid cell. Answers a version 1 field frame (engine.md) with f32 values, NaN where the raster has no data; 404 when the folder has no raster for that hour, 422 when the dataset is missing or unreadable. Cool paths reads the Chalmers demo's prepared PET this way (#196).

## A table's media

```
GET /api/media
GET /api/wms/layers?url=<address>[&service=wms|arcgis][&source=<id>]
```

`/api/media` lists everything the table has to show (#306), as `{ items: [{ kind, name?, path, bytes?, missing? }] }`: the scene's `buildings`, `terrain` and `trees`, every dataset of `data` (by `name`), then the pictures and video under `data/media/`, the sounds under `data/sounds/` and the 3D model (by `path` only). `kind` is `map` (GeoJSON), `table` (CSV), `raster` (GeoTIFF or a folder of them), `drawing` (SVG), `picture`, `video`, `sound`, `model` or `data` (anything else, such as trips). `missing` is true for a file `site.json` names that is not in the folder. The editor's Media tab shows the list, and every setting with `media` in its control (layer.md) picks from it. Online sources are `GET /api/sources`.

`/api/wms/layers` asks a WMS service for its GetCapabilities, or an ArcGIS map service for its `?f=json`, and answers `{ layers: [{ name, title }] }` (an ArcGIS layer's `name` is its id). `source` signs the request with a source of the Sources manager, and stands in for `url` when that is empty. From this computer only. A WMS layer's Layers setting picks from it.

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
| `data:<name>` | An SVG plan drawing (#193) | `data/<name>.svg` | `data.<name>` |
| `data:<name>` | A video: MP4, QuickTime or WebM (#194) | `data/<name>.mp4`, `.mov` or `.webm` | `data.<name>` |

Settings already in `scene.buildings` or `scene.trees` are kept. Coordinates that are not WGS84 are recognised when the file names its system or when SWEREF99 TM, a SWEREF99 local zone or the site's UTM zone puts them on the table, and are converted. Buildings with only `building:levels` (or `levels`, `floors`, `våningar`) get a height of 3 m a storey. A terrain GeoTIFF that only cites its grid is tried as SWEREF99 TM, the local zones, the site's UTM zone and WGS84, and the first that covers the table is kept and written as `crs`; `crs=EPSG:<code>` names it outright. Its report says how much of the table it covers and the range of ground heights. `crop=1` leaves out what lies more than a tenth of the table's size outside it; `swap=1` reads the first coordinate as latitude.

An SVG (by its `.svg` name or its first element) is read as a plan drawing in `crates/mrs-site/src/plan.rs`: it covers the table's frame, its top-level groups (or the groups inside a single wrapping group) are its phases, and it is made safe to show, with scripts, embedded pages, event handlers and links to other files taken out. Each phase group is marked `data-mrs-phase` (from 0) and `data-mrs-name`. The summary names the phases; `plan.shape` warns when the drawing is another shape than the table, `plan.cleaned` lists what was taken out, and the Masterplan layer (`packages/layers/plan`) shows it.

A video is known by its first bytes (`crates/mrs-site/src/video.rs`): an ISO `ftyp` box (MP4, or QuickTime when its brand is `qt  `) or a Matroska header (WebM). Only the headers are read, for the summary's length and picture size; the file is saved as it came. `video.length` warns when the file does not say how long it is, `video.format` notes that only MP4 (H.264) plays on every screen, `video.large` warns over 100 MB, and `video.walk` tells the editor to show it as a Video walk (`packages/layers/walkthrough`). A video cannot replace buildings, roads or another built-in dataset (`video.target`).

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
  preview?: GeoJSON.FeatureCollection;        // what was read, WGS84, in file order, at most 5000 features, on and off the table (before any crop), also on an 'extent.outside_all' refusal; not for trips or terrain
  path?: string;             // after an import: where it was saved
}
```

### A 3D model

```
POST /api/data/model?lon=&lat=&unit_m=[&bearing_deg=][&base_m=][&up=y][&mirror=1][&extrude=0]   saves or places the model, re-bakes, sends `site.changed`
POST /api/data/model?remove=1                                                                takes it out of the scene
```

The body is an STL, OBJ or GLB file (its name in `X-Filename`, which gives the format), saved as `data/model.<ext>`; with an empty body the model the site already has is placed again. The query is `scene.mesh` without its path (see site.md, "Buildings from a mesh"): `lon`/`lat` is the anchor. `extrude=0` sets `scene.buildings.extrude: false` (the model gives the buildings their shape), `extrude=1` raises the footprints again; without it the setting stays. Removing the model raises the footprints again. The answer is `{ site, triangles, coverage }` (coverage: the share of the table the model covers), or 422 with `{ error }` when the file can't be read; nothing is written then. The site's `mesh` in `site.changed` carries the placement and `extrude`, so the editor can open it again.

The editor reads the file itself to show it from above while the author sets units, axes, turn, scale and place (`packages/runtime/src/editor/model-import.ts`); the host only checks and saves.

### From OpenStreetMap

Add `source=osm` and send an empty body: the host asks OpenStreetMap (Overpass) for the table's extent plus a tenth on each side and reads the answer as a GeoJSON file, so the report, options and saving are the same as for a file. It is never done unless the author asks.

| `target` | What is fetched |
| --- | --- |
| `buildings` | `building` ways and multipolygon relations; `height` or `building:levels` give the height |
| `trees` | `natural=tree` points |
| `walkways` | `highway` footway, path, pedestrian, steps, cycleway, track, living street, residential, service, unclassified |
| `data:roads` | `highway` streets, motorway to service, with `kind: 'street'` for the cars layer |

#### Everything at once (#310)

```
POST /api/data/osm?targets=buildings,trees,walkways,data:roads   asks once, writes nothing
```

One Overpass query for every target (the same mirrors and retries), split into one GeoJSON per dataset by tag and kept for 15 minutes, so the `source=osm` import of each that follows asks OpenStreetMap nothing more. The answer is `{ datasets: [{ dataset, ok: true, count } | { dataset, ok: false, report }] }` in the order asked; `dataset` is the name layers know (`roads` for `data:roads`) and `report` is the refusal above (`osm.offline`, `osm.empty`, `osm.unavailable`). The wizard's **Fetch everything from open data** (`packages/runtime/src/editor/fetch-all.ts`) calls it, then imports each dataset in turn and the ground with `source=elevation`, holding the editor's reload until the last one is in.

Every OSM tag is kept as a property, with `osm_id` (`way/123`). The saved file carries `source: { name: 'OpenStreetMap', layer, attribution: '© OpenStreetMap contributors', licence: 'ODbL-1.0', fetched: 'YYYY-MM-DD' }`, and the report has a note with code `source.osm`: the credit must be shown wherever the table is. A refusal is a 422 report with one blocker: `osm.unavailable` (trips, terrain or another dataset name), `osm.offline` (no answer; try again) or `osm.empty` (nothing mapped there). `MRS_OVERPASS_URL` points the host at another Overpass server.

`message` is written for the author and can be shown as it is. `fix` names the option that applies the recommended fix, so an editor can offer it as a button and send the same file again with that option.

## Moving or renaming a table

```
POST /api/site/place   { "name"?: "Harbour", "origin": { "lon": 11.97, "lat": 57.70 }, "extent": { "width_m": 1000, "height_m": 600, "rotation_deg": 0 }, "table_width_cm"?: 100 }
```

Loopback only, like the data requests. It rewrites `name` (left out: kept), `origin` and `extent` of `site.json`, the table's `width_cm` when `table_width_cm` is given (10 cm to 20 m; it sets the model scale, 1 : `width_m` × 100 / `width_cm`), and the table's `height_cm` so its shape follows, then re-bakes the scene for the ground the table now covers, closes every engine stream and sends `site.changed`; surfaces reload. Data brought in stays where it is in the world. Answers `{ "site": <SiteInfo> }`, or 422 `{ "error" }` with the reason: a name over 60 characters, a place off the map, a side under 10 m or over 50 km, or a table whose ground is a raw height grid (`terrain.f32`), which is made for one extent and cannot move (a GeoTIFF can). The setup guide's "Name and place" step uses it.

## A picture of the table for Home

```
POST /api/site/thumbnail   <JPEG bytes>
```

Loopback only. The editor sends a picture of the map (640 px wide) when the table is left or saved (#131); the host keeps it as `.mrstudio/thumbnail.jpg` in the site folder, where the desktop app's Home finds it for the table's card. `.mrstudio/` is the app's own: Save As (#130) does not copy it and an export (#85) leaves it out. Answers 204, or 400 for anything that is not a JPEG under 4 MB.

## Wire protocol

Text frames are JSON. Binary frames are engine field frames (see engine.md).

```ts
// surface to host
{ t: 'hello', protocol: 1, role: 'table' | 'tv' | 'phone' | 'guide' | 'dev', code?: string, resume?: string }
{ t: 'req', id: number, m: string, p?: object }
{ t: 'alive', window: string, fps: number }  // table and tv windows of the desktop app, every 2 s (see Running unattended)
{ t: 'error', message: string, stack?: string, layer?: string, window?: string }  // an error in the window, for the app's log (see Layers in trouble)

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
| `layer.activate` | `{ layer, active }` | table, tv, dev, phone | Turns a layer on or off. Phones only when `tv.phone_switch` is not false, the layer's `phone_switch` is not false, and no slideshow is showing; the host then broadcasts `phone.switched` (#335), unless `cue: false` (a layer closed to make way) |
| `layer.intensity` | `{ layer, intensity }` | table, tv, dev | Sets how strongly the layer is drawn, clamped to 0..2. The runtime applies it to the layer's overlays and decorations; layers need no code |
| `layer.set` | `{ layer, params }` | all (phones only for `phone: true` controls) | Validates, merges, broadcasts |
| `layer.action` | `{ layer, action }` | all (phones only for `phone: true`) | Broadcast to the table |
| `layer.publish` | `{ layer, values }` | table, dev | Merges into `shared`, broadcasts |
| `layer.health` | `{ layer, status, reason?, retry_in? }` | table, dev | How a layer that is on is doing (#259). `status` is `retrying` or `failed` (with `reason` in words, and for `retrying` the seconds to the next try) or `running`. Kept as the layer's `health` (absent while it runs) and broadcast; ignored while it is off. Returns `{ incident }` when trouble starts or ends, which goes to the operator log |
| `layer.retry` | `{ layer }` | tv, dev | Retry for a layer in trouble: the table starts it again now (event `layer.retry { layer }`) |
| `tool.input` | `{ layer, tool, geometry }` | all | Checked, then forwarded to the table |
| `engine.*` | see engine.md | table, tv, dev | Kernel streams |
| `calibration.get` | none | table, tv, dev | Returns `{ projector }`, the saved projector calibration or null (see model.md) |
| `calibration.set` | `{ projector }` | table, tv, dev | Saves it to the site's `calibration.json` (null clears it) and broadcasts `calibration` |
| `calibration.mode` | `{ active }` | table, tv, dev | Asks the table to open or close its calibration tool |
| `scene.add` | `{ use, id?, parent?, index?, active?, params? }` | tv, dev | Adds a layer from the catalogue (`use` is its id, or `custom:<id>` for a custom layer) at `index` (default: on top, active). With `parent`, it becomes an item of that layer, at `index` among its items. Returns `{ id }`; without `id` the first copy is named after the layer and later ones `<layer>-2`, `-3`, ... |
| `scene.remove` | `{ layer }` | tv, dev | Takes a layer, with its items, or one item out of the scene. Steps of a sequence that showed it go too; the answer says how many: `{ dropped_steps }` |
| `scene.move` | `{ layer, index, parent? }` | tv, dev | Moves a layer (with its items) or an item to `index` in its list: the scene's layers (0 is the bottom), or its layer's items. `parent` moves it into another layer as an item; `parent: null` makes an item a layer of the scene. A layer with items, steps or a button cannot become an item |
| `scene.set` | `{ layer, params?, active?, button?, hide?, steps? }` | tv, dev | Like `layer.set` and `layer.activate`, and also saved as the layer's starting state. For an item, `active` is whether it comes on with its layer. `button` is `{ name?, description?, icon?, side?, group?, order? }`: a value sets a field, `null` clears it, a field left out stays; items have none. `hide` is the whole list of control ids the controller and phones leave out. `steps` replaces the layer's steps whole (`null` clears them); only a sequence layer (`"sequence": true`) may have `steps.sequence`, and each step's params are checked against the layer it shows. `scene.add` takes `button` and `hide` too |
| `custom.save` | `{ id, recipe }` | tv, dev | Saves a custom layer (site.md, Custom layers) under `custom` in site.json, new or replacing the one with that id, and offers it at once: every surface gets `catalog.changed { manifest }`. Instances of it on the table restyle in place and keep the params its controls still take. Refused for the id of a core layer. Returns `{ id, use }` (`use` is `custom:<id>`) |
| `custom.remove` | `{ id }` | tv, dev | Removes a custom layer from site.json, refused while the table uses it. Surfaces get `catalog.removed { id }` |
| `palette.set` | `{ palette }` | tv, dev | Saves the table's palette (`{ set?, slots? }`, site.md; `null` removes it). Surfaces get `palette.changed { palette }`, and the site's `palette` follows it; custom layers recolour at once |
| `site.table` | `{ name?, timezone?, branding?: { title?, logo?, welcome? } }` | tv, dev | Changes the table settings that are not its place (see "Settings" below). A field left out stays, `null` clears an optional one. `name` 1 to 60 characters, `timezone` an IANA zone such as `Europe/Stockholm`, `title` up to 80, `welcome` up to 160, `logo` a picture inside the site folder. Every surface gets `site.settings`. Moving or resizing goes through `POST /api/site/place` |
| `site.sources` | `{}` | table, tv, dev | Which outside sources (Sources manager, #41) this table's layers use: `{ sources: [{ source, layers: [{ id, name }] }] }`, read from the layer controls that name a source (`"sources"` in layer.json) |
| `history.list` | `{}` | table, tv, dev | The table's revision history (see "Revision history" below): `{ revisions, head, can_undo, can_redo }`, newest first |
| `history.undo` | `{}` | tv, dev | Puts back the version of site.json before the current one, whoever made the change. Answers like `history.list` |
| `history.redo` | `{}` | tv, dev | Puts back the version undo last took away. A new change drops what could be redone |
| `history.restore` | `{ revision }` | tv, dev | Brings back any kept revision as a new revision on top, so nothing is lost |
| `layer.step` | `{ layer, to }` | all | Moves a layer that is on through its steps: `"next"`, `"previous"`, `"first"`, `"skip"` (the next step, whatever sub-steps are left), `"all"` (every sub-step revealed) or a step number. See Steps above |
| `layer.play` | `{ layer, playing }` | all | Plays or pauses a layer's steps; the host moves them on |
| `layer.substeps` | `{ layer, count, titles? }` | table, dev | A layer that is on says how many sub-steps it has (at most 64), with a name for each. 0 removes them |

In every `layer.*` and `tool.input` request, `layer` is the instance id.
Items are instances like any other: they are in `scene` (right after their layer) and `layers`, with `parent` in their state. Turning a layer on turns on its items that are set to come on with it, and turning it off turns all of them off, each with its own `state.layer` event. `layer.activate` on an item works only while its layer is on.
The `scene.*` requests rewrite the `layers` list of `site.json` before they take effect, and fail without changing anything if it cannot be saved.
`layer.set` and `layer.activate` change the running session only, so a slider moved on the TV or a phone is not written to the site.

Events:

| Event | Payload |
| --- | --- |
| `state.layer` | `{ layer, state: LayerState }` after any change to a layer |
| `state.scene` | `{ scene, layers }` after a layer was added, removed or moved: the new order and every layer's state |
| `state.participants` | `{ participants }` |
| `layer.action` | `{ layer, action, from }` |
| `catalog.changed` | `{ manifest }` after `custom.save`: a custom layer was added or changed |
| `catalog.removed` | `{ id }` after `custom.remove` |
| `palette.changed` | `{ palette }` after `palette.set` |
| `tool.input` | `{ layer, tool, geometry, from, participant? }` |
| `phone.switched` | `{ layer, active, participant? }` after a phone turned a layer on or off; `participant` is `{ slot, colour }` |
| `calibration` | `{ projector }` after a calibration was saved or cleared |
| `calibration.mode` | `{ active }` |
| `site.changed` | `{ site: SiteInfo }` after data was imported, or an undo or outside edit changed more than the live keys: the scene is re-baked and the engine and twin already use it. Replace `state.site`; layers that read site data at start need a reload |
| `history.changed` | `{ revision, head, stepped, can_undo, can_redo }` after every change to site.json, from any writer. `stepped` is true for undo and redo. `revision.surface` is the surface that made it, so an editor can say "changed by someone else" |
| `site.problem` | `{ message, revision }`: site.json was changed outside MR Studio and does not load. The table keeps what it shows; undo puts the last good version back |
| `site.tv`, `site.display` | `{ tv }`, `{ display }` after those settings changed |
| `site.settings` | `{ name, timezone, branding }` after `site.table`, or an undo or outside edit of those keys. The controller starts again to show the new title and welcome line |

### The session changing

`session.changed {session}` is sent to every surface when the session's details change after the welcome, such as the join address when the host links to or loses a phone relay (#89). Surfaces showing the QR code redraw it.

### Languages (#80)

`session.language` is the language the visitors' screens speak now, one of the site's `branding.languages` (English when it lists none). `session.language { language }` switches it, from the controller (`tv`), the editor (`dev`) or the guide; the host sends `session.changed` to every surface. The controller and the phones start again in the new language; the table only redraws its ribbons. A phone may keep a language of its own (the SV / EN buttons in its header, kept in the phone's browser): it no longer follows the controller. A phone turned away at the door speaks its own choice, else its browser's language.

`session.sound` is whether the table plays sound, true when the session starts (#282). `session.sound { on }` switches it, from the controller (the **Sound** button under Map controls), the editor or the guide, and the host sends `session.changed`. While it is false the table plays nothing: no voice beds (layer.md, Sound voices) and no sounds on points; what follows the sound on the map carries on.

`session.ribbon` is the layer whose ribbon the table shows, or null for Auto (the layer turned on last that has ribbon panels), null when the session starts (#231). `session.ribbon { layer }` sets it, from the controller (the **Ribbon** button under Map controls, shown when more than one open layer has ribbon panels), the dev page or the guide; the layer must be on the table. The host sends `session.changed`. The controller sets it back to null when that layer closes (present.md, Ribbon).

### The guide's phone (#98)

A guide leading a group runs a slideshow from a phone of their own, with presenter notes in hand.

- A slideshow step may carry `notes` (plain text, blank lines or new lines start a paragraph). They are in the step in `site.json` and in the broadcast state, but only the guide's phone and the editor show them: never the table, the TV or the visitors' phones.
- The guide joins with the `guide` role and the **guide code**, six digits made when the session starts and different from the visitors' code. Only the TV and the editor (`tv`, `dev`) can ask for it: `session.guide {}` → `{ code, url }`, where `url` is `<join base>/guide?g=<code>` when phones can join and `null` otherwise. The editor shows it with a QR code under a slideshow's slides.
- A guide takes no participant slot and no colour. It can do what the controller's buttons do: turn layers on and off, step them and set their controls (`layer.activate`, `layer.step`, `layer.set`, `layers.reset`). It cannot edit the scene, use the engine, calibrate, or read the table's sources and history. Through the relay (#89) a guide joins like a phone, with its own code.

### Running unattended (#79)

A table in an exhibition runs all day with nobody at the computer.

- **Engine.** The engine thread looks after itself. If it panics, or its GPU device is lost,
  a new engine starts with the same scene. After a GPU failure it runs on the CPU until the
  table is started again. Every surface gets `engine.restarted { message, backend }`: the
  streams are gone, so the table and the controller reload. The incident goes to the
  operator log.
- **Windows.** Each table and controller window of the desktop app sends
  `{ t: 'alive', window, fps }` every 2 s. `window` is the label the app gave it, as
  `window.__MRS_WINDOW__`. Phones' and the editor's beats are ignored.
- **Watchdog.** The app's watchdog (apps/studio/src-tauri/src/watchdog.rs) checks every 2 s:
  - A window silent for 8 s is reloaded by navigation (a new or reloaded window gets 30 s to
    load first), which works even when the page's
    script has stopped. After two reloads that did not help, every window is opened again.
  - A server that stopped by itself is started again and presented again.
  - At the nightly restart time (`nightly_restart` in studio.json, "03:00"), a presented
    table is started anew.
- **Operator log.** `operator-YYYY-MM-DD.log` in the app's log folder, in local time. It
  records starts, presenting, stopping, recoveries, engine incidents and nightly restarts.
  90 days are kept. Displays and settings › Phones and startup has a button that shows it.
- **Start with the computer.** "Start with this computer and present the last table by
  itself" adds a login item: a LaunchAgent on macOS, a Run entry on Windows. The app starts
  with `--at-login` and presents the last table on the saved screens.

### Layers in trouble, and diagnostics (#259, #260)

A layer must never be silently missing from the table.

- **Health.** When a layer's `table()` throws, or a site dataset it uses cannot be read (the
  SDK's `readSiteData`, `loadSiteData` and `loadSiteField` report it through `onDataProblem`,
  after their own retries for a host that is restarting), the table's runtime sends
  `layer.health { status: 'retrying', reason, retry_in }` and starts the layer again after
  1 s, 2 s, 5 s, 15 s, then every minute while it is on. A dataset is pinned on the layers that
  name it in `requires.data` or in a setting; otherwise on the one layer starting just then.
  Once a start reads everything, it sends `running` and the trouble ends. A layer whose code is
  not in the app is `failed` and waits.
- **Where it shows.** The editor puts a red dot on the layer's row, with why in its tooltip,
  and a box with the reason and **Retry** at the top of its settings. The controller dims the
  layer's button and writes "Not available right now" under its name; it comes back by itself.
  The start and end of trouble go to the operator log.
- **Window errors.** Every surface sends uncaught errors, rejected promises and errors thrown
  by a layer's handlers as `{ t: 'error', message, stack, layer, window }`: the same error at
  most once a minute, 20 a minute in all. The host counts repeats, allows 30 a minute per
  window, keeps the last 200, and writes new ones to the app's log and (except phones') to the
  operator log.
- **Diagnostics.** `GET /api/diagnostics` is the host's report as JSON (`?format=text` for
  text): version, table and site format, the engine's backend and GPU, every layer with its
  state and trouble, the windows' last beats and frame rates, window errors and incidents. In
  the app, Help › Copy diagnostics (also in the editor's Help tab) adds the app's build stamp,
  the computer, the displays and which window is on each, and the last 500 lines of the app's
  log, shows it and copies it. Save diagnostics… writes it to a file; Open log folder shows the
  logs. Keys never pass through it, and anything in a log line that looks like a key or token
  is blanked.

### Settings: this computer or this table

Every setting has one home (#73):

| | App settings | Table settings |
| --- | --- | --- |
| Belongs to | This computer, every table on it | This table only |
| Stored in | The app's config folder (`displays.json`, colour, `sources.json` plus the OS keychain) | `site.json` and `calibration.json` in the table's folder |
| Holds | Screens (which display is the table, which the controller), colour correction, the projector calibration tools, updates, keys and outside sources (Sources manager), phones on the network, present on open | Name, place and size, time zone, the controller's title, logo and welcome line (`branding`), welcome loop and idle reset (`tv.attract_s`, `tv.idle_reset_s`), the controller's theme and About page (`tv`), display quality (`display`), palette, and which sources its layers use (`site.sources`, a read-only view of the app's Sources) |
| Opened from | *MR Studio > Settings…* on macOS, *File > Settings…* on Windows, Home's "Displays and settings" | The table's name at the top of the editor's layer list, or *File > Table settings…* |

A table copied to another computer brings its table settings and none of the app settings: that computer's screens and keys apply. A source a table uses but the computer lacks shows as missing in the Sources manager, never as a key in site.json. The controller page in the editor (#54) previews the title and welcome line; it edits the same `branding` fields, so there is one copy of them.

### Revision history

The host keeps every version of `site.json` (#72), whoever wrote it, in one list:

- **Who**: `by` is `editor` (a dev surface), `controller` (a tv surface), `import` (Add data, OpenStreetMap, elevation), `mcp` (the MCP server), `outside` (a text editor, `git pull`, any other program), `history` (a restore) or `start`.
- **A revision** is `{ rev, at, by, summary, keys, surface? }`: `rev` counts up and is never reused, `at` is Unix seconds, `summary` is one line in plain words ("Added Sun study", "Changed outside MR Studio: the palette"), `keys` are the top-level keys of site.json that changed.
- **Outside edits**: the host looks at `site.json` about once a second. A change it did not make becomes a revision and shows on every surface at once: the layers, custom layers, palette and the `tv` and `display` settings change live (`state.scene`, `catalog.*`, `palette.changed`, `site.tv`, `site.display`); anything else re-bakes the ground and sends `site.changed`. A file that does not load is recorded too and reported with `site.problem`.
- **Naming an outside change**: a tool that writes site.json may first write `.mrstudio/next-change.json` in the site folder: `{ "by": "mcp", "summary": "Added trees", "at": <unix seconds> }`. The next outside change found within 30 seconds takes that name; the note is then deleted.
- **Undo and redo** walk the list and rewrite site.json; the running table follows as for an outside edit. A version that no longer loads (a layer package that is gone) is refused and site.json stays as it was.
- **A dragged slider** is one revision: the same change from the same surface within 3 seconds joins the revision before it.
- **Two editors**: each change is written as it arrives, so the later one wins; the other editor learns of it from `history.changed` with another `surface`.
- **Where**: `.mrstudio/history/` in the site folder, one file per revision and `head.json`, the newest 200 kept. It belongs to this computer: it is left out of Save As, copies, exports and the site's repository. Only `site.json` is versioned: a data file replaced by an import stays replaced after an undo, though site.json points back to the file it named before.

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
