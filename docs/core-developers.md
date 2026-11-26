# For core developers

What you need to work on MR Studio itself: the engine, the host, the runtime, the core layers and
the desktop app. A team making a table for its own site does not need any of this: it starts
from the [site template repository](https://github.com/snjsomnath/mr-studio-site-template) and the
[author's guide](guide/README.md), and installs the app.

To run it from source, see "Try it" in the [README](../README.md). The design is in
[ARCHITECTURE.md](ARCHITECTURE.md) and the interface contracts are in [contracts](contracts).
Releasing is in [RELEASING.md](RELEASING.md).

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

## Adding things

- **A layer**: copy `packages/layers/sunlight`. A layer is `layer.json` (id, controls, tools) plus `src/index.ts`. The TV and phone controls are generated from the manifest. List the layer in a site's `site.json`. See [docs/contracts/layer.md](docs/contracts/layer.md).
- **A kernel**: add `crates/mrs-engine/src/kernels/<id>/` with `kernel.wgsl`, `cpu.rs` and `mod.rs`, register it in `kernels/mod.rs`, and add `tests/<id>.rs` with physics tests on the CPU reference and a GPU/CPU parity test. See [docs/contracts/engine.md](docs/contracts/engine.md).
- **A layer of your own site**: `mrstudio layer new <id> --site <site>`, then `mrstudio layer build`. It lives in the site's `layers/` folder and runs in the installed app, with no change to the core. See "Site layers" in [docs/contracts/layer.md](docs/contracts/layer.md#site-layers).
- **A site**: `mrstudio new-site`, add data, `mrstudio validate`. See [docs/contracts/site.md](docs/contracts/site.md).
- **A site, with an LLM**: connect the MCP server and use its `new_project` prompt. Ideas the core cannot serve become module requests to this repository. See [docs/MCP.md](docs/MCP.md).

## Tests

```bash
pnpm test        # cargo test, typecheck, SDK tests
pnpm test:e2e    # real browser against the real host (needs Playwright with Chromium)
pnpm smoke webkit  # every core layer on and off in one engine: chromium, webkit or msedge
pnpm lint        # promises nobody awaits or catches
cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

CI runs all of these on every pull request: the end-to-end check in Chromium on Linux, and the engine smoke with WebKit on macOS (as the Mac app draws) and Edge on Windows (as WebView2 does). The smoke fails on any error a page throws, a frame slower than 5 s, and known engine traps such as large SVG filters, which WebKit draws in software. Dependabot opens grouped dependency updates weekly, and a weekly security audit warns about known advisories.

Measured on an Apple M4 Pro (Metal), 2026-11-14, sunlight kernel:

| Grid | Sun hours over a day, GPU | CPU reference | One instant, GPU | CPU reference |
| --- | --- | --- | --- | --- |
| 1000 x 600 | 72 ms | 390 ms | 5.8 ms | 3.0 ms |
| 2000 x 1200 | 261 ms | 2838 ms | 11.8 ms | 24.0 ms |

The GPU wins clearly on accumulated work. A single instant on a small grid is dominated by the round trip to the GPU, which is the next thing to optimise (keep the field on the GPU instead of reading it back).

The GPU tests need a Vulkan, Metal or DirectX 12 adapter. Without one they are skipped and the CPU reference tests still run. CI installs a software Vulkan driver so they always run there.
