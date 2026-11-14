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

The app opens a launcher where you pick or create a site. **Open in editor** opens it for authoring; **Present** puts it on the displays you chose, one borderless fullscreen window each, and the editor has the same Present button.
The display choice is remembered, and a table can be set to start by itself. While presenting, Ctrl+Shift+E goes back to the editor, Ctrl+Shift+S brings the launcher back and Ctrl+Shift+Q quits.
The launcher's Colour tab boosts or corrects the colours of each display (saturation, contrast, brightness, gamma, white balance), live on the running table, with presets and a test card.
The Calibration tab starts the projector calibration tool on the table.
The Updates tab says when a newer version is published, shows what it brings and any breaking changes, and installs it; see [docs/RELEASING.md](docs/RELEASING.md).
Windows and macOS installers are built by the "Desktop app" workflow on every pull request and push to `main` (download them from the run's artifacts), and attached to a draft release for a `v*` tag.
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
packages/layers      core layers: sunlight (the reference for analysis), trees (for ambient layers), sketch (for phone tools), wind (the simulation example), coolpaths, mobility
packages/mcp         MCP server: build a site by talking to an LLM
sites/sample         a small synthetic site for tests and dev mode
sites/chalmers       the Chalmers campus, the flagship reference site
```

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

| Part | State |
| --- | --- |
| Engine: scene, jobs, sunlight kernel on GPU and CPU, parity tests | Working |
| Site format, validation, scene bake from footprints, meshes (STL), terrain (raw or GeoTIFF) and trees | Working |
| Host: session state, roles, validated params, field streaming | Working |
| Phones: QR join, slots that survive a reload (60 s hold), per-phone rate limit, point, line and polygon tools | Working; tested in a desktop browser, not yet on a real phone |
| Surfaces: table, TV, phone, dev, with generated controls | Working, first version |
| Scene composer (`/compose`), base map, ambient layers and slideshow | Working, first version |
| Sunlight layer (shadows, sun hours, animation, TV panel) | Working |
| Cool paths layer (shortest and shadiest walk over a site's walkways, live shade from the engine) | Working; thermal comfort (PET) kernel proposed |
| Mobility layer (a site's trips played over time, values per cell) | Working |
| Desktop app: launcher (site and display picker), fullscreen per display, colour per display, installers from CI | Working on Linux with two displays. The earlier shell started on macOS (Apple M4 Pro, Metal); the launcher, fullscreen placement and the installers still need a first run on real Windows and macOS hardware |
| Wind kernel (lattice Boltzmann on GPU and CPU) and layer (speed map, ribbons, particles, TV panel) | Working |
| Stormwater, isovist kernels and layers | Not started; see the work packages in ARCHITECTURE.md |
| Table calibration | Read from the site and applied on the table surface; the calibration tool is not started |
| Basemap tiles | Not started |
| Chalmers site package | Working, with the sunlight layer |
| Lindholmen and Universeum site packages | Not started |
| Python services gateway (ECOM, CoolPaths, site prep) | Not started |
| MCP server for building sites with an LLM | Working, first version; CI runs it on Linux, Windows and macOS |
