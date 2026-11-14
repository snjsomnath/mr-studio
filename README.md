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
`/table`, `/tv` and `/phone?c=<session code>` are the real surfaces; the session code is printed when the host starts.

```bash
cargo run -p mrs-cli -- validate sites/sample      # check a site and report its scene
cargo run -p mrs-cli -- new-site sites/mysite --lon 11.94 --lat 57.706
cargo run --release -p mrs-cli -- bench sites/sample   # time the kernels on GPU and CPU
```

## Layout

```
crates/mrs-engine    compute engine: scene on the GPU, WGSL kernels, CPU reference
crates/mrs-site      site.json, validation, scene baking
crates/mrs-host      local host: surfaces, session hub, engine streams
crates/mrs-cli       the `mrstudio` command
apps/studio          desktop shell (Tauri): one window per display
packages/sdk         @mrstudio/sdk: layer API, connection, engine client
packages/runtime     the surfaces: table, tv, phone, dev
packages/layers      core layers; sunlight is the reference
sites/sample         a small synthetic site for tests and dev mode
```

## Adding things

- **A layer**: copy `packages/layers/sunlight`. A layer is `layer.json` (id, controls, tools) plus `src/index.ts`. The TV and phone controls are generated from the manifest. List the layer in a site's `site.json`. See [docs/contracts/layer.md](docs/contracts/layer.md).
- **A kernel**: add `crates/mrs-engine/src/kernels/<id>/` with `kernel.wgsl`, `cpu.rs` and `mod.rs`, register it in `kernels/mod.rs`, and add `tests/<id>.rs` with physics tests on the CPU reference and a GPU/CPU parity test. See [docs/contracts/engine.md](docs/contracts/engine.md).
- **A site**: `mrstudio new-site`, add data, `mrstudio validate`. See [docs/contracts/site.md](docs/contracts/site.md).

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
| Site format, validation, scene bake from footprints, terrain and trees | Working |
| Host: session state, roles, validated params, field streaming | Working |
| Surfaces: table, TV, phone, dev, with generated controls | Working, first version |
| Sunlight layer (shadows, sun hours, animation, TV panel) | Working |
| Desktop shell | Builds and starts on macOS (Apple M4 Pro, Metal) with a dev window; not yet run on Windows; display placement untested on real hardware |
| Wind, stormwater, isovist kernels and layers | Not started; see the work packages in ARCHITECTURE.md |
| Calibration, basemap tiles, QR join, phone tools | Not started |
| Chalmers, Lindholmen and Universeum site packages | Not started |
| Python services gateway (ECOM, CoolPaths, site prep) | Not started |
