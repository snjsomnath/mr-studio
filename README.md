# MR Studio 2.0

MR Studio puts a real place on a projected table so a group can explore it together, with a TV for controls and dashboards and phones for participation.
This repository is the ground-up rebuild: one desktop app, sites as folders, layers as packages, and a shared GPU compute engine.

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The interface contracts are in [docs/contracts](docs/contracts).

## Try it

You need Rust (stable), Node 22 and pnpm.

```bash
pnpm install
pnpm dev
```

Open <http://localhost:5173/dev>. That is the layer dev mode: the table view of the sample site with the generated controls beside it, with hot reload.

Open <http://localhost:5173/edit> for the editor, the authoring window around the live table. It is the first step of the main authoring tool and will replace the composer.

Open <http://localhost:5173/compose> to assemble a scene: drag layers from the palette into the stack, reorder them and edit their settings. The sample site starts as a dark base map with traffic, public transport, building lights and trees. Every change is saved to the site's `site.json`.
`/table`, `/tv` and `/phone?c=<session code>` are the real surfaces; the session code is printed when the host starts.
To join from a real phone, run `pnpm dev -- --lan` and scan the QR code shown on `/tv` or `/dev`.

```bash
cargo run -p mrs-cli -- validate sites/sample      # check a site and report its scene
pnpm dev -- --site sites/chalmers                  # the Chalmers campus instead of the sample
cargo run -p mrs-cli -- new-site sites/mysite --lon 11.94 --lat 57.706
cargo run --release -p mrs-cli -- bench sites/sample   # time the kernels on GPU and CPU
```

## The desktop app

```bash
pnpm app          # build the surfaces and run the app from source
pnpm app:build    # make an installer for this computer (target/release/bundle)
```

The app opens on Home: your tables, **New table** (a short wizard: name, place, size, then the editor takes you through the map, the layers and the controller) and **Open a folder**. A table opens in the editor; **Present** there puts it on the displays you chose under Displays and settings, one borderless fullscreen window each.
The display choice is remembered, and a table can be set to start by itself. While presenting, Ctrl+Shift+E goes back to the editor, Ctrl+Shift+S brings the launcher back and Ctrl+Shift+Q quits.
The launcher's Colour tab boosts or corrects the colours of each display (saturation, contrast, brightness, gamma, white balance), live on the running table, with presets and a test card.
The Calibration tab starts the projector calibration tool on the table.
Every merge to `main` is a numbered release (see [CHANGELOG.md](CHANGELOG.md)): each pull request writes a release note with screenshots in `changes/`, and the "Desktop app" workflow raises the version, builds the Windows and macOS installers and publishes them with the notes. Home shows **What's new** when a newer version is out, each new feature with its picture, and a button that downloads the installer for this computer; after an update it shows what the new version brought, once. The Updates tab under Displays and settings has the full notes and the build stamp. See [docs/RELEASING.md](docs/RELEASING.md).
Pull request builds attach their installers to the run as artifacts.
The installers are not signed yet: Windows SmartScreen asks once ("More info", "Run anyway"), and on macOS open the app the first time with right click, Open.

## Layout

```
crates/mrs-engine    compute engine: scene on the GPU, WGSL kernels, CPU reference
crates/mrs-site      site.json, validation, scene baking
crates/mrs-host      local host: surfaces, session hub, engine streams
crates/mrs-cli       the `mrstudio` command
apps/studio          desktop shell (Tauri): one window per display
packages/sdk         @mrstudio/sdk: layer API, connection, engine client
packages/runtime     the surfaces: table, tv, phone, dev
packages/layers      core layers (listed below)
packages/mcp         MCP server: build a site by talking to an LLM
sites/sample         a small synthetic site for tests and dev mode
sites/chalmers       the Chalmers campus, the flagship reference site
changes              release notes waiting for the next version (docs/RELEASING.md)
```

## Core layers

| Layer | What it shows | Package |
| --- | --- | --- |
| Base map | Streets and buildings drawn dark, light, grey or terrain maps, aerial photos, maps from your sources, or plain ground | `basemap` |
| Sunlight | Shadows at any moment, hours of direct sun over a day, three seasons side by side, and how much sun one spot gets | `sunlight` |
| Wind | How the wind moves between buildings and through trees (lattice Boltzmann kernel), as speed, ribbons or particles | `wind` |
| Stormwater | Rain running off roofs and slopes, gathering and pooling, live (shallow-water kernel) | `stormwater` |
| Cool paths | The shortest walk between two points and the one with the least heat (PET) | `coolpaths` |
| Mobility | Trips played over time, and a map of how travel differs from place to place | `mobility` |
| Isovist | What a person standing here can see, how green that view is (with Street View), and how it sounds | `isovist` |
| Traffic | Cars, taxis and buses with headlights on the street network, now and then an emergency vehicle | `cars` |
| Public transport | Trams, buses, trains and ferries, simulated or live from Västtrafik | `transit` |
| Street life | Walkers, cyclists and streetlights along the streets | `street-life` |
| Street glow | Streets glowing by kind, pulsing, with light flowing along them | `street-glow` |
| Building lights | Lit windows that come on and go off | `building-lights` |
| Trees | Tree crowns swaying in a light wind | `trees` |
| Table grid | A glowing grid on the model's tile seams, to check the projection | `grid` |
| Map data | A GeoJSON dataset coloured by category, revealed one category at a time | `mapdata` |
| Masterplan | A plan drawing (SVG or picture) revealed phase by phase; its lines can trace in and turn to colour, and pointing at a phase lights it | `plan` |
| Magnifier | A glass people move over the table: a larger view of what is under it, or an X-ray of the layers placed inside it | `lens` |
| Reveal line | A line people move across the table: on one side the layers placed inside it show, such as pipes and tunnels | `swipe` |
| Video walk | A video on the controller, its walker moving along the path on the table | `walkthrough` |
| Slideshow | Images, video, map data and layers one after another; with presenter notes it is a guided tour on the guide's phone | `slideshow` |
| Picture or video | A picture or video of the site over the whole table: a simulation, an old photo, a film of a sun study | `media` |
| Web map (WMS) | A map from a WMS or ArcGIS service laid over the table | `wms` |
| Sketch | Places, routes and areas marked from a phone | `sketch` |
| Building blocks | A demo of two scenes assembled from the SDK's building blocks | `blocks-demo` |

Custom layers made in the editor's layer builder (data, look, motion and interaction blocks) are saved in the table itself, not as packages.

## Adding things

- **A layer**: copy `packages/layers/sunlight`. A layer is `layer.json` (id, controls, tools) plus `src/index.ts`. The TV and phone controls are generated from the manifest. List the layer in a site's `site.json`. See [docs/contracts/layer.md](docs/contracts/layer.md).
- **A kernel**: add `crates/mrs-engine/src/kernels/<id>/` with `kernel.wgsl`, `cpu.rs` and `mod.rs`, register it in `kernels/mod.rs`, and add `tests/<id>.rs` with physics tests on the CPU reference and a GPU/CPU parity test. See [docs/contracts/engine.md](docs/contracts/engine.md).
- **A site**: `mrstudio new-site`, add data, `mrstudio validate`. See [docs/contracts/site.md](docs/contracts/site.md).
- **A site, with an LLM**: connect the MCP server and use its `new_project` prompt. Ideas the core cannot serve become module requests to this repository. See [docs/MCP.md](docs/MCP.md).

## Tests

```bash
pnpm test        # cargo test, typecheck, SDK tests
pnpm test:e2e    # real browser against the real host (needs Playwright with Chromium)
```

Measured on an Apple M4 Pro (Metal), 2026-11-14, sunlight kernel:

| Grid | Sun hours over a day, GPU | CPU reference | One instant, GPU | CPU reference |
| --- | --- | --- | --- | --- |
| 1000 x 600 | 72 ms | 390 ms | 5.8 ms | 3.0 ms |
| 2000 x 1200 | 261 ms | 2838 ms | 11.8 ms | 24.0 ms |

The GPU wins clearly on accumulated work. A single instant on a small grid is dominated by the round trip to the GPU, which is the next thing to optimise (keep the field on the GPU instead of reading it back).

The GPU tests need a Vulkan, Metal or DirectX 12 adapter. Without one they are skipped and the CPU reference tests still run. CI installs a software Vulkan driver so they always run there.

## Status

As of 2026-11-24. What changed release by release is in [CHANGELOG.md](CHANGELOG.md).

| Part | State |
| --- | --- |
| Engine: scene, jobs, kernels on GPU and CPU with parity tests: `sunlight`, `wind`, `stormwater`; point questions (`engine.probe`) | Working |
| Site format 3, validation, migration, bake from footprints, meshes (STL), 3D models, terrain (raw or GeoTIFF) and trees; one-file `.mrstable` export | Working |
| Host: session state, roles, validated params, field streaming, revision history with undo and redo | Working |
| Phones: QR join on the local network or through the relay from any network, point, line and polygon tools, the guide's phone | Working; tested in desktop browsers, not yet on a real phone |
| Controller: layer rails, stage with heroes and legends, attract loop and idle reset, map controls, credits, Swedish and English | Working |
| Table: projector calibration, colour per display, ribbons in the blank margins, table grid | Working |
| Editor (`/edit`): Home, New table wizard, layers, buttons, slideshows and tours, custom layer builder, styling, history, Display and Table settings | Working; the main authoring tool |
| Core layers (table above) | Working |
| Base map tiles: free styles, Sources maps (Mapbox, CARTO, Lantmäteriet, WMS, ArcGIS), offline tile store | Working |
| Sources and keys (OS keychain, host-signed requests) | Working |
| Desktop app: Home, editor window, fullscreen per display, unattended running (watchdog, nightly restart, start at login), What's new | Working on Linux and on macOS (Apple M4 Pro); the first run on the Windows studio PC is still to do |
| Releases: a version per merge to main, notes with screenshots, installers for Windows and macOS | Working; the installers are not code-signed |
| MCP server for building sites with an LLM | Working; CI runs it on Linux, Windows and macOS |
| Lindholmen and Universeum site packages | Not started |
| Python services gateway (ECOM) | Not started; ECOM is left for later |
