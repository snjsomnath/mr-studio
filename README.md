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

Open <http://localhost:5173/edit> for the editor, the authoring window around the live table: add layers, reorder them and edit their settings. The sample site starts as a dark base map with traffic, public transport, building lights and trees. Every change is saved to the site's `site.json`.
`/table`, `/tv` and `/phone?c=<session code>` are the real surfaces; the session code is printed when the host starts.
To join from a real phone, run `pnpm dev -- --lan` and scan the QR code shown on `/tv` or `/dev`.

```bash
cargo run -p mrs-cli -- validate sites/sample      # check a site and report its scene
pnpm dev -- --site sites/chalmers                  # the Chalmers campus instead of the sample
cargo run -p mrs-cli -- new-site sites/mysite --lon 11.94 --lat 57.706
cargo run --release -p mrs-cli -- bench sites/sample   # time the kernels on GPU and CPU (--town 4000: a city-sized made-up town)
```

## The desktop app

```bash
pnpm app          # build the surfaces and run the app from source
pnpm app:build    # make an installer for this computer (target/release/bundle)
```

The app opens on Home: your tables, **New table** (a short wizard: name, place, size, then the editor takes you through the map, the layers and the controller) and **Open a folder**. A table opens in the editor; **Present** there puts it on the displays you chose under Displays and settings, one borderless fullscreen window each.
The display choice is remembered, and a table can be set to start by itself. While presenting, Ctrl+Shift+E goes back to the editor, Ctrl+Shift+S brings the Settings window and Ctrl+Shift+Q quits.
Settings (File › Settings…, or **Screens and calibration…** on the editor's Present tab) picks the screens. Its Colour page boosts or corrects the colours of each display (saturation, contrast, brightness, gamma, white balance), live on the running table, with presets and a test card.
Its Calibration page starts the projector calibration: the table shows a cross of light, and the panel that names the corner to find, with its plan and a nudge pad, is on the controller (K shows it on the table when there is no controller). With building footprints the corners are real building corners at roof height.
**Operator mode** (Phones and startup page, the Present tab or Home) runs an exhibition computer with a small operator window in place of the editor, behind a PIN. **Open read-only** on Home opens a copy of a table for a demo, so nothing changed reaches the table itself.
**Share** at the top right of the editor packs the table into one `.mrstable` file and attaches it to a new email; another computer opens it and asks before it updates a table it already has. A table names the MR Studio version it needs (`mrstudio.version`) and asks before it runs programs it brought with it.
The Command line page puts the `mrstudio` command that ships inside the app on the PATH (also MR Studio > Install command line tool on a Mac, File > Install command line tool on Windows), for validating tables, bringing data in and building site layers from a terminal, a script or an AI assistant.
Every merge to `main` is a numbered release (see [CHANGELOG.md](CHANGELOG.md)): each pull request writes a release note with screenshots in `changes/`, and the "Desktop app" workflow raises the version, builds the Windows and macOS installers and publishes them with the notes. Home shows **What's new** when a newer version is out, each new feature with its picture, and a button that downloads the installer for this computer; after an update it shows what the new version brought, once. The Updates page in Settings has the full notes and the build stamp. See [docs/RELEASING.md](docs/RELEASING.md).
Pull request builds attach their installers to the run as artifacts.
The installers are not signed yet: Windows SmartScreen asks once ("More info", "Run anyway"), and on macOS open the app the first time with right click, Open.

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
| Field walk | Spots visitors marked on a walk with their phones, each with a photo or a sound; the controller shows or plays it | `fieldwalk` |
| Slideshow | Images, video, map data and layers one after another; with presenter notes it is a guided tour on the guide's phone | `slideshow` |
| Picture or video | A picture or video of the site over the whole table: a simulation, an old photo, a film of a sun study | `media` |
| Web map (WMS) | A map from a WMS or ArcGIS service laid over the table | `wms` |
| Sketch | Places, routes and areas marked from a phone | `sketch` |

Custom layers made in the editor's layer builder (data, look, motion and interaction blocks) are saved in the table itself, not as packages.

## For a team at a new site

A table for your own place lives in a repository of your own, with no MR Studio code in it.
Make it from the [site template repository](https://github.com/snjsomnath/mr-studio-site-template)
(**Use this template** on GitHub): `site.json`, `data/`, `layers/` for your own code layers, a
README for the team, and a GitHub check that runs `mrstudio validate` on every push. Then follow the [author's guide](docs/guide/README.md).

## For core developers

The layout of this repository, how to add a layer, a kernel or a site, and the tests are in
[docs/core-developers.md](docs/core-developers.md).
How work is done here (issues first, release notes, screenshots, what belongs in core) is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Status

As of 2026-11-27 (0.53.0). What changed release by release is in [CHANGELOG.md](CHANGELOG.md).

| Part | State |
| --- | --- |
| Engine: scene, jobs, kernels on GPU and CPU with parity tests: `sunlight`, `wind`, `stormwater`; point questions (`engine.probe`) | Working |
| Site format 3, validation, migration, bake from footprints, meshes (STL), 3D models, terrain (raw or GeoTIFF) and trees; GeoJSON, CSV, zipped shapefiles, GeoPackages and rasters of values; OpenStreetMap fetches through three Overpass servers with kept parts; one-file `.mrstable` export; starter packs for QGIS, Illustrator, Photoshop and PowerPoint (`mrstudio starter-pack`) | Working |
| Host: session state, roles, validated params, field streaming, revision history with undo and redo, one idle timer for the whole table, a shared play head (`layer.clock`) | Working |
| Phones: QR join on the local network, through the join page on GitHub Pages over WebRTC (eduroam, mobile data; no server of our own), or through the relay, point, line and polygon tools, field walk spots with a photo or a sound, the guide's phone | Working; tested in desktop browsers, not yet on a real phone |
| Controller: layer rails, stage with heroes and legends, attract loop and idle reset, map controls, credits, Swedish and English | Working |
| Table: projector calibration (panel on the controller, footprint corners), colour per display, ribbons in the blank margins, table grid; everything that moves drawn on the GPU (`addSprites`, `addStrokes`) | Working; on a Mac the presented Chalmers table is still to be measured after 0.53.0 |
| Editor (`/edit`): Home, New table wizard, layers, buttons, slideshows and tours, custom layer builder (incl. raster looks with Dig, well logs, two-stack X-rays), media library, styling, history, Screens and calibration, Table settings, Share | Working; the main authoring tool |
| Core layers (table above) | Working |
| Base map tiles: free styles, Sources maps (Mapbox, CARTO, Lantmäteriet, WMS, ArcGIS), offline tile store | Working |
| Sources and keys (OS keychain, host-signed requests) | Working |
| Desktop app: Home, editor window, fullscreen per display, unattended running (watchdog, nightly restart, start at login), operator mode, read-only open, What's new | Working on Linux and on macOS (Apple M4 Pro); the first run on the Windows studio PC is still to do |
| Releases: a version per merge to main, notes with screenshots, installers for Windows and macOS | Working; the installers are not code-signed |
| MCP server for building sites with an LLM | Working; CI runs it on Linux, Windows and macOS |
| Lindholmen and Universeum tables | Built as tables of their own (`.mrstable`), outside this repository; only Chalmers and the sample are in `sites/` |
| Python services gateway (ECOM) | Not started; ECOM is left for later |

## Licence

From version 0.55.0, MR Studio is licensed under the [Business Source License 1.1](LICENSE) by
Nodal Works AB. Use for teaching, research at a university or non-profit research organisation, personal
use, evaluation, development and testing is free. Other production use, such as a table in regular use
at a municipality, museum or company, needs a commercial licence from Nodal Works AB. Four years after
each version is released, that version becomes available under the MIT License.

Versions 0.54.0 and earlier were released under the MIT License and remain under it.

These parts are licensed under MIT, each with its own LICENSE file: the MCP server
([packages/mcp](packages/mcp/LICENSE)), the SDK type definitions written into a layer package
(`mrstudio-sdk.d.ts`), the contracts ([docs/contracts](docs/contracts/LICENSE)), the site template
([templates/site](templates/site/LICENSE)) and the samples ([samples](samples/LICENSE)).
