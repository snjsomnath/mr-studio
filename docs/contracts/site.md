# Site package contract

A site is a folder. It is never a branch and never a fork of the app.

```
sites/<id>/
  site.json          the manifest below
  data/              source data: GeoJSON in WGS84, rasters, media
  scene/             baked rasters written by `mrstudio prepare`, for inspection (generated, git-ignored)
  layers/            site-only layer packages (optional)
  calibration.json   table calibration, written by the app (optional)
```

## site.json

```jsonc
{
  "format": 3,
  "id": "sample",
  "name": "Sample district",
  "origin": { "lon": 11.9778, "lat": 57.6884 },   // centre of the table area, WGS84
  "extent": {
    "width_m": 1000,        // size of the area shown on the table
    "height_m": 600,
    "rotation_deg": 0       // bearing of the table's "up" edge, clockwise from north
  },
  "timezone": "Europe/Stockholm",
  "table": { "width_cm": 100, "height_cm": 60, "tile_cm": 20,
             "ribbons": { "bottom": { "cm": 9 }, "top": "auto" } },   // optional, see present.md
  "scene": {
    "cell_m": 2,
    "buildings": { "path": "data/buildings.geojson", "height_property": "height", "default_height_m": 12 },
    "terrain":   { "path": "data/terrain.f32", "width": 100, "height": 60 },   // optional, flat if absent; or a GeoTIFF
    "mesh":      { "path": "data/model.stl", "anchor": { "lon": 11.972, "lat": 57.6826 }, "unit_m": 1 },   // optional
    "trees":     { "path": "data/trees.geojson", "height_property": "height", "crown_radius_m": 3 }  // optional, points
  },
  "data": {                                        // optional, named datasets for layers
    "roads": "data/roads.geojson",
    "transit": "data/transit.geojson"
  },
  "basemap": { "background": "#0b0e14", "style": null },
  "data": {                                           // named datasets for layers (optional)
    "walkways": "data/walkways.geojson",
    "trips": "data/trips.json"
  },
  "layers": [                                      // the scene, bottom first
    { "use": "basemap", "id": "basemap", "active": true },
    { "use": "cars", "id": "cars", "active": true },
    { "use": "sunlight", "id": "sun-study", "params": { "hour": 15 },
      "button": { "name": "Sun study", "group": "Simulations", "order": 1 },
      "items": [ { "use": "transit", "id": "sun-transit" } ] },      // shown only while the sun study is open
    { "use": "cars", "id": "rush-hour", "params": { "density": 30 } },
    { "use": "custom:heat-walk", "id": "heat-walk" },
    { "use": "slideshow", "id": "tour",
      "items": [ { "use": "custom:aerial-1960", "id": "aerial-1960" } ],
      "steps": { "mode": "manual", "loop": true, "sequence": [
        { "layer": "aerial-1960", "transition": "fade", "title": "Campus in 1960" },
        { "layer": "sun-study", "params": { "hour": 9 }, "title": "Morning sun" },
        { "layer": "heat-walk", "next": "then-next" }
      ] } },
    { "use": "./layers/artwork", "id": "artwork" }
  ],
  "custom": {                                      // custom layers saved in this site (optional)
    "heat-walk": { "name": "Heat walk", "icon": "route",
      "data": [ { "id": "paths", "dataset": "walkways" } ],
      "look": [ { "id": "lines", "block": "lines", "data": "paths", "props": { "color": "#ff8800", "width": 3 } } ],
      "motion": [ { "id": "glow", "block": "glow", "on": "lines" } ] },
    "aerial-1960": { "name": "Aerial photo 1960", "category": "media",
      "data": [ { "id": "photo", "wms": { "url": "https://example.org/wms", "layers": "ortho_1960" } } ],
      "look": [ { "id": "photo", "block": "raster", "data": "photo" } ] }
  },
  "tv": { "layout": "default" },
  "branding": { "title": "MR Studio", "logo": null, "welcome": "Choose a layer to bring it to the table." }
}
```

Rules:

- `format` is the contract version, a whole number. A site with an older format is upgraded when it is opened: the app and `mrstudio migrate` rewrite `site.json` and keep the original as `site.format-<n>.json`; anything else that reads a site (`Site::load`) upgrades it in memory. A site with a newer format than the app knows is refused with a message that says to update the app. Every format change adds one step to `mrs-site`'s `migrate` module, which is the only place that knows about older formats.
  - Format 2: the base map is a layer. Format 1 drew ground, streets and footprints under every layer by itself; the upgrade puts `{ "use": "basemap", "active": true }` first in `layers` unless the site already lists it.
  - Format 3: every entry in `layers` has an `id`, and layers can hold `items`, sequences have `steps`, custom layers are saved under `custom`, buttons have `group` and `order`, and the table has `ribbons`. The upgrade writes into each entry the id format 2 gave it implicitly (the layer's id, or the folder name of a site layer), so the session and the editor keep calling every layer what they called it before. Nothing else changes.
- `extent` is the table area: a `width_m` by `height_m` rectangle centred on `origin`, rotated by `rotation_deg`. Its aspect ratio should match the table's.
- The scene grid covers exactly the extent with `cell_m` cells, so `width = round(width_m / cell_m)`.
- Paths are relative to the site folder and may not leave it.
- `layers[].use` is a core layer id, a relative path to a site-only layer package, or `custom:<id>` for a custom layer saved under `custom`. `params` override the layer's defaults and `active` turns it on at start.
- `layers[].id` names an entry: lowercase letters, digits and dashes, up to 40. It is required, and unique across the whole scene, items included. Items, steps, the session's state and the editor all refer to an entry by it. New entries get the layer's id, then `-2`, `-3`… when that is taken.
- `layers[].button` is how the layer is offered on the controller: `{ "name", "description", "icon", "side", "group", "order" }`, all optional. `name` (up to 40 characters) and `description` (up to 200) replace the layer package's own words, `icon` is an icon name in lowercase letters, digits and dashes, `side` is `"left"` or `"right"`, `group` (up to 40 characters) puts it in a named group of its rail, and `order` (a number, lower first) places it there. The map never shows these; they are for the controller and phones. How the controller uses them is in [present.md](present.md).
- `layers[].items` and `layers[].steps`: see [Layers, items and sequences](#layers-items-and-sequences).
- `custom`: see [Custom layers](#custom-layers).
- `branding` is what the controller says about the table: `title` (up to 80 characters; the table's `name` without it), `logo` (a picture inside the site folder) and `welcome`, the line under the title on the controller's home screen (up to 160; a default sentence without it). With `name` and `timezone` these are the table settings the editor changes through `site.table` (session.md, "Settings: this computer or this table"). Nothing in site.json belongs to the computer: screens, colour, keys and outside sources are app settings. `branding.languages` lists the languages visitors can switch between (#80), the first the table starts in: `["en", "sv"]`, or `["sv", "en"]` to start in Swedish; with one or none there is no switch. `branding.translations` holds the table's own words in other languages, by language and then by the English text: `{ "sv": { "Sample district": "Exempelstadsdelen" } }`. The editor lists them under Table settings, Languages for visitors.
- `palette` is the table's colours (#93): `{ "set": "night", "slots": { "accent": "#ff8a4c" } }`. `set` is one of the SDK's built-in sets (`night`, the default, `ember`, `harbour`; `PALETTE_SETS` in `packages/sdk/src/palette.ts`), and `slots` changes single slots, each `#rrggbb`. The slots are `accent`, `focus`, `warm`, `cool`, `green`, `warning`, `neutral` and `cat1` to `cat8`, with the meanings in [visualisation.md](../visualisation.md) C4. Custom layers name colours by slot (`"@warm"`), so changing the palette recolours them.
- `table.front` is the edge of the projected image where visitors stand: `"bottom"` (the default), `"top"`, `"left"` or `"right"`. For a viewer at the front, the model hides what is projected on the far side, so ribbons and other at-a-glance info go to the front first, and a ribbon set to `"auto"` prefers it, then the two sides next to it, and uses the far side last.
- `table.ribbons` says what the projector's blank space around the model shows, per side (`top`, `bottom`, `left`, `right`): `"off"`, `"auto"` (use the free band when there is one) or `{ "cm": 9 }`. See [present.md](present.md), Ribbon.
- `data` maps a dataset name to a file in the site. Layers ask for datasets by name (`requires.data` in `layer.json`), never by path. The scene's `buildings`, `trees` and `terrain` are always available under those names. Names the core layers read: `roads` (LineStrings; optional `width` in metres and `kind`), `transit` (see `packages/layers/transit/README.md`), `slideshow` (see `packages/layers/slideshow/README.md`).
- `terrain` is one of two things, told apart by the file extension:
  - Raw little-endian f32 elevations covering the extent, row-major with row 0 at the top, at any resolution. Needs `width` and `height`.
  - A GeoTIFF (`.tif`, `.tiff`): `{ "path": "data/terrain.tif" }`. It is placed by its own georeference, so it may be larger than the extent and on a national grid. Add `"crs": "EPSG:3006"` when the file does not name its coordinate system. See [Terrain from a GeoTIFF](#terrain-from-a-geotiff).
- `mesh` is a 3D model of the top surface, for sites whose footprints have no heights. See [Buildings from a mesh](#buildings-from-a-mesh).
- `buildings.extrude` (default `true`) says whether the footprints are raised into the scene. Set it to `false` when a mesh gives the buildings their shape; the footprints are then only drawn on the table.
- `layers[].hide` lists ids of the layer's controls that the controller and phones leave out, for example `["opacity", "detail"]`. The control keeps its value, and the editor and the developer page still show it.
- `display` says how the table's surfaces render (#134): `{ "quality": "draft" | "good" | "best" }`. `good` is the default; `draft` keeps a slow computer smooth, and `best` gives a strong one finer fields and softer edges. The editor sets it on the Display tab.
- `tv` holds the TV's settings: which side the layer buttons default to, the site's theme, and optional hand-made dashboard pages. Its shape and rules are in [dashboard.md](dashboard.md). The host passes it to surfaces as written.
- Unknown keys are an error, so a typo is caught by `mrstudio validate` rather than silently ignored.
- Vector data is GeoJSON in WGS84 (CRS84). Site prep reprojects from national grids.
- Nothing in `site.json` is a secret. Credentials for services live in the app's own config.

## Layers, items and sequences

A layer is data plus animation plus interaction. In the scene, an entry of `layers` is an **instance**: it points at a **definition** with `use` and gives it an id, params, a button and a start state. Three kinds of definition exist:

| `use` | Definition | Where it lives |
| --- | --- | --- |
| `sunlight` | A core layer: a package with code | The app |
| `./layers/artwork` | A site-only layer package | The site folder |
| `custom:heat-walk` | A custom layer: a recipe of blocks, no code | `custom` in this site.json |

A template in the New layer gallery (#59) is not a definition. Adding one writes an ordinary instance with the template's params and button, and nothing refers back to the template.

**Items.** A layer can hold `items`: instances that belong to it, such as public transport, traffic or trees inside a sun study, or a data visual on a slide. An item has `use`, `id`, `params`, `hide` and `active`, and nothing else: no button, no items and no steps of its own. It is drawn right on top of its layer, in list order. It shows only while its layer is open: when the layer turns on, each item whose `active` is true (the default) turns on with it, and when the layer turns off, all its items do. The map at rest is the layers with no button at the top level of the scene: those of category `base` and `ambient`, and any other layer that starts on (`active: true`) and has no `button`, such as a Map data layer colouring the streets (#204). So a table can have public transport at rest and another copy inside one layer. A layer at rest is not on the controller's rails and stays on while button layers open and close.

**Steps.** `steps` says how Next moves through a layer: `mode` (`"manual"` or `"timed"`), `loop` (after the last step, back to the first) and `reveal` (once a step's sub-steps are done, Next `"stop"`s or moves on: `"then-next"`). See [present.md](present.md), Steps.

**Sequences.** A layer whose layer.json says `"sequence": true` (the slideshow) may have `steps.sequence`: a list of steps, each showing another instance by id. A step shows either a layer of the scene, which keeps its own button and can still be opened on its own, or one of the sequence's own items, which exists only inside the sequence (a WMS map or a GeoJSON file made into a custom layer for one slide). A step shows one layer: never the sequence itself, another sequence, or another layer's item. Each step may have:

| Key | Meaning |
| --- | --- |
| `layer` | The instance id it shows. Required |
| `params` | Params the layer takes for this step only, checked against its controls, such as another hour of the day |
| `duration_s` | How long the step stays in timed mode |
| `transition`, `transition_s` | How the step comes in: `"cut"`, `"fade"` (a cross-fade) or `"dip"` (the old step fades out to the empty map, then this one fades in), and how many seconds that takes (0 to 10). Unset, the sequence's own `steps.transition` and `steps.transition_s` apply, and without those a 0.7 s fade |
| `next` | This step's own `reveal` |
| `title`, `description`, `source` | For the controller's info strip (up to 80, 300 and 200 characters). The table never shows them |

Removing a layer from the scene also removes the steps that showed it.

The step going out stays on the table until the step coming in has started (its data loaded), so a slow web map never leaves the table empty; then both run the transition together.

**Pictures and video** (#197) are steps too: a `media` item whose `file` is a picture (PNG, JPEG, WebP, GIF) or a video (MP4, WebM) inside the site, usually under `data/media/` where the editor keeps the files it is given. It is laid over the whole table with `fit` (`stretch`, `contain`, `cover`), `rotation` (`"0"`, `"90"`, `"180"`, `"270"`) and `opacity`. A video plays from the start while its step is on show.

## Custom layers

`custom` holds the custom layers this site has saved, by id (lowercase letters, digits and dashes, and not the id of a core layer). The layer editor (#38) writes them and the MCP server can too. A custom layer is a recipe the runtime draws without code of its own, and it is offered in the New layer gallery next to the core layers. They live in the site, so a table folder carries everything it shows; a library of custom layers shared between tables (#73) copies one into a site when it is used.

```jsonc
"heat-walk": {
  "name": "Heat walk", "description": "…", "icon": "route", "category": "analysis",
  "data":        [ { "id": "paths", "dataset": "walkways" } ],
  "look":        [ { "id": "lines", "block": "lines", "data": "paths", "props": { "color": "#ff8800", "width": 3 } } ],
  "motion":      [ { "id": "glow", "block": "glow", "on": "lines", "props": { "pulse_s": 2 } } ],
  "interaction": [ { "id": "tap", "block": "tap-info", "data": "paths" } ],
  "enter": "fade",
  "controls": [ { "id": "width", "type": "range", "label": "Width", "min": 1, "max": 8, "step": 1, "default": 3, "bind": "look.lines.width" } ],
  "legend": [ { "id": "hot", "label": "Hottest stretch", "color": "#ff4400", "shape": "line" } ],
  "attract": { "effect": "particles" }
}
```

- `name` (1 to 40 characters) is required; `description`, `icon` and `category` are as in layer.json.
- `data` lists what it shows. Each entry has an `id` and exactly one source: `dataset` (a named dataset of the site), `path` (a file in the site folder: GeoJSON, GeoTIFF, CSV points, an image or a video), `wms` (`{ "url", "layers", "styles"?, "format"?, "source"? }`) or `tiles` (an XYZ URL with `{z}`, `{x}` and `{y}`). A service that needs a sign-in names it with `source`, from the app's Sources manager (#41); no secret goes in the site.
- `look`, `motion` and `interaction` are lists of blocks, in the editor's order: data, then look, motion and interaction. Each block has an `id` (unique in the layer), the `block` name from [docs/blocks.md](../blocks.md), the `data` it reads, for motion and interaction the look block it acts `on`, and its `props`. The table is 2D: there is no extrusion or 3D camera, so height and value are drawn as colour, outline, glow or pulse.
- `enter` is how it comes onto the table (`"cut"` or `"fade"`).
- `controls` are written as in layer.json. A control's `bind` names the block prop it drives, `look.<block id>.<prop>`.
- `legend` and `attract` are the controller's, as in [present.md](present.md).

The host offers each custom layer to surfaces as a layer manifest with the recipe under `custom`, and the runtime's recipe player (`packages/runtime/src/recipe-player.ts`) draws it. The editor's layer builder writes recipes with `custom.save` (session.md).

What the player draws today (`packages/sdk/src/recipe.ts`; WMS and tiles data are drawn by the WMS layer, not yet by a recipe):

| Stage | Block | Props |
| --- | --- | --- |
| look | `points` | `color`, `radius_mm`, `opacity`, `glow` (0–1), `core`, `stroke`, `stroke_mm`, `label` (a column; place names only), `shape` (`circle`, `square`, `diamond`, `triangle`, `ring`, `icon`), `icon` (a pictogram: `star`, `pin`, `flag`, `tree`, `person`, `house`, `bus`, `bolt`, `drop`, `heart`, `plus`, `sun`), `legend` |
| look | `lines` | `color`, `width_mm`, `opacity`, `glow`, `casing`, `dash` (`solid`, `dashed`, `dotted`), `dash_mm`, `gap_mm`, `arrows` (`none`, `end`, `along`), `arrow_mm`, `arrow_gap_mm`, `legend` |
| look | `fill` | `color`, `opacity`, `stroke`, `stroke_mm`, `edge_glow`, `shadow_mm` (a soft shadow instead of height), `hatch`, `legend` |
| motion | `pulse` (on points or fill) | `period_s`, `size_mm`, `rings`, `direction` (1 out, -1 in) |
| motion | `draw-in` (on lines) | `duration_s`, `stagger` |
| motion | `flow` (on lines) | `speed_mm` |
| motion | `particles` (on lines) | `per_line`, `speed_mm`, `size_mm`: lights travelling along each line |
| motion | `attract` (on points) | `count`, `speed_mm`, `reach_mm`, `weight` (a numeric column that pulls harder), `size_mm`: a crowd drawn in across open ground |
| motion | `gravity` (on points) | `network` (a site dataset of lines, default `roads`), `count`, `speed_mm`, `weight`, `size_mm`, `trail`: people walking to each point along the street network by the shortest route |
| motion | `timeline` (on any look) | `column` (a year or date column), `duration_s`, `hold_s`, `keep` (stay, or come and go), `window` (share of the span a feature stays): features appear as a sweep passes their time, with a brief flare on points; features with no time always show |
| motion | `place` (on points) | `motion` (one of 22 place motions, `PLACE_MOTIONS` in place-motions.ts: ripples, catchment, territories, constellations, comets, metaballs, orbiters, spokes, fireflies, contours; dot-pulse, counter-rings, sound-ring, spectrum, bulge, galaxy; gravity-well, pilgrims, lit-blocks, field-lines, street-pulses, threads), its other files (`streets`, `buildings`, `targets`: site datasets; `activity`, `flows`, `links`: CSV datasets, see the place data standard below), `cycle_s` (seconds the activity table takes to play through), `colours` (`each`, `category` or a slot), `speed`, `glow` and the motion's own knobs. Places come from the look's points: `name`, `weight` and `category` are found by name |
| motion | `sound` (on points) | `column` (names each point's sound file: a bare name is in `data/sounds/`, a path is in the site folder) or `file` (one sound for every point), `trigger` (`chorus`: a few at a time at random; `loop`: every point, always; `tap`: only when asked), `voices`, `gap_s`, `volume` (0 to 1), `reach_mm`, `width_mm`, `sensitivity` (0 calm to 1 every note): each call in the sound sends out a ring in the point's colour, louder calls wider, higher sounds faster. Sounds play on the table surface only; the editor shows the rings silently unless Listen here is on. Files are added with `POST /api/data/sounds?name=` (WAV, MP3, OGG, M4A, kept as they are) and listed with `GET /api/data/sounds`. A custom layer with a sound motion also gets a `sound` point tool and a `play` param (#150): a tap on a point on the table or a phone's map, or on its card on the controller (the controller lists every sound as a card, lit while it plays), plays that sound once; a step whose `params` give `play` (the sound's name, such as `"Robin"`, or its id) plays it when the step is shown |

**Place data standard (#160).** Every place motion reads the same few files, so data is prepared once and any motion can be tried on it:

| File | Columns | Without it |
|---|---|---|
| places (points) | `name`, `weight` (any range, rescaled), `category` | weight 0.6 for all; one colour each |
| `activity.csv` | `place,time,activity`, one row per place per time step | each place swells slowly on its own |
| `flows.csv` | `from,to,volume` | comets fly between places picked by weight |
| `links.csv` | `from,to` | places sharing a category are linked |

Names in the tables match the places' `name`, case-insensitive; names that match nothing are reported. Streets and buildings come from the site, never per motion. The builder's ? button shows each motion's setup with an example. The sample kit has all four (`samples/kit`). The tables come in through Add data as "Something else, by a name of its own": a CSV without position columns is kept as `data/<name>.csv` (comma separated, UTF-8, decimal commas read as points) rather than refused.

- Sizes are millimetres on the physical table (visualisation.md E5), turned into metres by `table.width_cm`.
- A colour is a palette slot (`"@accent"`), `"#rrggbb"`, or driven by a column: `{ "by": "kind", "kind": "category", "scheme"?: "auto" | "palette" | "epc", "colors"?: { "<value>": "@cat2" } }` (six values shown, the rest grouped as Others; values that already have known colours, such as energy classes A to G, keep them and their order unless `scheme` is `palette`; `colors` wins over both, #207) or `{ "by": "population", "kind": "number", "ramp": "sun", "classes": "continuous" | "equal" | "quantile", "count": 5 }`. A size may be `{ "by": "<column>", "range": [2, 8] }`.
- A data `path` or dataset may be GeoJSON, or a CSV of points with `lon` and `lat` columns.
- The builder writes the legend the looks give into `legend`.

## Services

`services` lists the outside compute the table's layers use (#278): a model, an optimiser or an API.
The host either starts it with the table (`run`) or forwards to it where it already runs (`url`).
Layers reach a service only through the host, from this computer, and name it in `requires.services`.

```jsonc
"services": [
  {
    "id": "ecom", "name": "Energy model", "health": "/api/health",
    "run": {
      "cwd": "services/ecom",                                   // inside the site
      "command": ["{python}", "-m", "uvicorn", "app.main:app", "--port", "{port}"],
      "venv": ".venv", "requirements": "requirements.txt",     // made and installed on the first start
      "env": { "SCENARIO": "campus" },                          // never keys: those go in Sources and keys
      "start_s": 90
    }
  },
  { "id": "weather", "url": "https://models.example.org/weather" }
]
```

| Key | Meaning |
| --- | --- |
| `id` | What a layer calls it by: lowercase letters, digits and dashes |
| `run.command` | The program and its arguments. `{port}` is a free port the host picks (also in `PORT`), `{python}` the venv's Python, or this computer's without a venv |
| `run.venv`, `run.requirements` | A virtual environment, made with this computer's Python when it is missing, and the requirements installed into it. They are installed again when the requirements file changes |
| `health` | A path that answers 200 when the service is ready. Default `/` |
| `run.start_s` | Seconds it may take to become ready. Default 60 |

What the host does with them:

- Starts each `run` service when the table opens, waits for `health`, and starts it again after a crash with a growing pause (1 s up to a minute). Each stop is in the operator log. It stops them when the table closes. A change to `services` takes effect when the table opens again.
- `GET /api/services` gives each service's state (`installing`, `starting`, `up`, `down`, `remote`), why, and how often it restarted; `/api/services/<id>/log` the last lines it wrote.
- `/api/services/<id>/call/<path>` forwards any method, with its body and query, to the service. The same request from several views of the table at once (the projector and the editor both run the layer) reaches the service once, and they share the answer, so a job starts once.
- Every good answer is kept in `.mrstudio/services/<id>/`. When the service is down or fails, the kept answer to the same request is given instead, marked with `x-mrs-cached`, so a table without its model, or offline, still shows the last result. `.mrstable` exports leave this folder out.

In a layer, `ctx.service(id)` has `get(path)`, `post(path, body)` and `job(path, body, { onProgress })`: a job POST answers `{ "job": "<id>" }`, and the SDK polls `<path>/<id>` until `state` is done or failed, passing on `progress` and `message`. A finished job's result is kept too. While a call runs, the layer publishes `busy: { label, progress }` and the controller shows it under the layer's name. `samples/service-example` has a model and a layer to copy.

## Composing a scene

A table scene is the ordered `layers` list and nothing else: the first entry is drawn at the bottom, the last on top, and a layer's items right on top of it.
Everything a person sees on the table, from the dark base map to moving cars, building lights, public transport, trees and analysis layers such as sunlight or isovist, is a layer package added to that list with its params.
This is what the composer at `/compose` edits. It reads each layer's `layer.json` to offer it in a palette and to generate its settings form, and the host writes `site.json` after every change, so a scene made by drag and drop and one written by hand are the same file.
The host replaces only the `layers` list and leaves every other key as written. The file is reformatted (two-space indent) the first time it is saved.

What the composer needs, and where it stands:

| Need | Status |
| --- | --- |
| Ordered list of layers with params and initial on/off | In format 1 |
| Layers self-describe their controls, tools and data needs | In `layer.json` (`controls`, `tools`, `requires`) |
| A site says which of its files a layer should use | In format 1: `data` |
| A blank starting point | `mrstudio new-site`, and `sites/sample` as the dummy scene |
| The same layer twice with different settings | Done: every entry has an `id`, and state is keyed by it |
| Palette grouping | Done: `category` in `layer.json` (`base`, `ambient`, `analysis`, `media`) |
| Add, remove and reorder while running | Done: `scene.add`, `scene.remove`, `scene.move` and `scene.set` requests (session.md); the host rewrites `site.json` |
| Draw order follows the list | Done: everything a layer draws sits at its place in the list |
| Items that come and go with a layer, sequences, custom layers | In format 3: `items`, `steps`, `custom`; the host keeps items with their layer (`scene.add { parent }`, `scene.move { parent }`) |
| TV dashboards built from widgets | Done: `tv` (theme, pages) and layer `panels`; see [dashboard.md](dashboard.md) |

Ambient layers (`cars`, `building-lights`, `street-life`, `street-glow`, `transit`, `trees`) animate on the table surface from site data or generated paths. They need no kernel; the layer rule "no solver code" still holds.
`basemap` is the dark base map and `slideshow` shows a site's media. `sites/sample` has the data for all of them and is the dummy scene to start from.
A layer whose data a site lacks still runs where it can: traffic and transit fall back to a generated street grid, and the palette says which data is missing.

## Baking the scene

The host turns the sources into the rasters the engine loads, in memory at startup:

1. `dtm`: the terrain raster resampled to the grid, or 0 everywhere.
2. `dsm`: `dtm`, raised by the mesh where it stands clear of the ground, then by each extruded building polygon, filled with a flat roof at its height above the lowest ground it covers. Courtyards (polygon holes) stay open.
3. `canopy`: each tree as a disc of `crown_radius_m` with the tree's height.

Baking a 1000 × 600 grid takes well under a second, and the Chalmers campus (1250 × 750 cells from a GeoTIFF and a 79 000 triangle mesh) about a second. `mrstudio validate <site>` checks the manifest and reports what the bake produced; `mrstudio prepare <site>` also writes the rasters to `scene/` so they can be inspected.

When a bake becomes slow, `scene/` becomes a cache.

### Terrain from a GeoTIFF

The first band is read as elevation in metres. The file must be north-up (`ModelPixelScale` and `ModelTiepoint` tags, which is what GDAL and QGIS write), uncompressed or compressed with LZW or Deflate. Supported coordinate systems: WGS84 and ETRS89 degrees (EPSG:4326, 4258), UTM (EPSG:326xx, 327xx, 258xx), SWEREF99 TM (EPSG:3006) and the SWEREF99 local zones (EPSG:3007 to 3018). Each grid cell samples the raster bilinearly at its own position, so the raster needs no clipping or rotating first. Cells the raster does not cover, or where it has no data, take its lowest elevation, and `mrstudio validate` reports how many there are.

### Buildings from a mesh

```jsonc
"mesh": {
  "path": "data/model.stl",                       // STL (binary or ASCII), OBJ, or a single-file GLB
  "anchor": { "lon": 11.971958, "lat": 57.682628 }, // where the mesh's own origin (0, 0) is
  "unit_m": 1250,                                 // metres per mesh unit, default 1
  "bearing_deg": -2.555,                          // compass bearing of the mesh's +Y axis, default 0 (Y north, X east)
  "base_m": 0,                                    // elevation of the mesh's z = 0, default 0
  "ground_tolerance_m": 1,                        // default 1
  "up": "z",                                      // which axis of the file points up: "z" (default) or "y"
  "mirror": false                                 // the file is a mirror image: flip its X axis, default false
}
```

The file is read in its own coordinates. `up: "y"` turns a Y-up export (glTF, Blender, many modelling tools) upright, reading each vertex (x, y, z) as (x, -z, y); `mirror` then flips x. A GLB's node transforms are applied, and every triangle primitive of its default scene is used; compressed (Draco, quantised) GLBs and `.gltf` files with separate buffers are not read. OBJ faces with more than three corners are fanned into triangles.

The editor's Your place step brings a model in and places it: units guessed from its size and the table scale, Y up guessed from its shape, then turned, scaled, moved and mirrored against the table outline and the footprints, or fitted to the footprints with "Snap to buildings" (POST `/api/data/model`, session.md).

A mesh has no georeference of its own, so these five numbers place it: a point, a scale, a turn and a height. `bearing_deg` is what makes a model drawn on a national grid line up, because grid north is not true north (2.6 degrees off at Chalmers).

The mesh is rasterised from above and the highest surface in each cell wins, so undersides and base plates do not matter. A mesh of ground and buildings together needs a `terrain` in the same height datum: that is how the bake tells a roof from a hillside. Where the mesh is less than `ground_tolerance_m` above the terrain the cell stays ground, since two models of the same ground never agree to the centimetre.

## Calibration

`calibration.json` maps the site to a physical table and is written by the app's calibration tool, never by hand:

```jsonc
{
  "table": {
    "center": { "lon": 11.9778, "lat": 57.6884 },
    "zoom": 16.2,          // web map zoom (512 px tiles) at the window size below
    "bearing": 0,          // compass bearing of the window's "up"
    "window": { "width_px": 2560, "height_px": 1440 }   // optional: the window the zoom was found at
  }
}
```

The table surface (`/table`) shows exactly this view, which may be larger than `extent` when the projector overshoots the table. With `window`, the zoom is rescaled when the window has another width, so the same ground stays in view. Without a calibration, and always in dev mode, the surface fits `extent` to the window.

## One file: `.mrstable` (#85)

A table goes to another computer as one file, `<name>.mrstable`: a zip of the table folder
with `mrstable.json` at the top. `crates/mrs-site/src/package.rs` writes and reads it.

- **In it:** site.json, data, media, calibration.json, custom layers. Everything in the folder
  except what is listed below.
- **Never in it:** hidden files and folders (`.mrstudio` revision history, `.git`, `.env`,
  `.DS_Store`), names that usually hold keys (`credentials*`, `secrets*`, `sources.json`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`), links, and older `.mrstable` files. Keys live in the
  computer's keychain (#41) and never travel.
- **`mrstable.json`:** `{ format: 1, name, id, exported, app, sources: [{ id, kind, name, layers }] }`.
  `sources` are the outside sources the layers use (as `site.sources` answers), named as the
  exporting computer knew them, so the receiving computer knows what to set up.
- **Opening:** unpacks into a new folder in the sites folder (into a hidden `.<name>.unpacking`
  folder first, renamed when complete). An existing table is never overwritten. A second copy
  becomes "Name 2" with its own id. site.json is upgraded to this build's format. Opening
  reports the sources not set up here and any problems with the table. Paths that leave the
  folder are refused, and so is a package that unpacks to more than 16 GB or comes from a
  newer package format.

The app has File › Export table… and, on Home, "Open a table file". Double-clicking a
`.mrstable` file opens it as well. From the command line:
`mrstudio export <site> --out X.mrstable` and `mrstudio import X.mrstable --into <sites>`.
