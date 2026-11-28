# For core developers

What you need to work on MR Studio itself: the engine, the host, the runtime, the core layers and
the desktop app. A team making a table for its own site does not need any of this: it starts
from the [site template repository](https://github.com/snjsomnath/mr-studio-site-template) and the
[author's guide](guide/README.md), and installs the app.

To run it from source, see "Try it" in the [README](../README.md). The design is in
[ARCHITECTURE.md](ARCHITECTURE.md) and the interface contracts are in [contracts](contracts).
Releasing is in [RELEASING.md](RELEASING.md).
The working rules (issues, pull requests, release notes) are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Layout

```
crates/mrs-engine    compute engine: scene on the GPU, WGSL kernels, CPU reference
crates/mrs-site      site.json, validation, scene baking
crates/mrs-host      local host: surfaces, session hub, engine streams
crates/mrs-cli       the `mrstudio` command
crates/mrs-relay     the phone relay, for phones on another network (docs/relay.md)
apps/studio          desktop shell (Tauri): one window per display
packages/sdk         @mrstudio/sdk: layer API, connection, engine client
packages/runtime     the surfaces: table, tv, phone, dev, and the editor
packages/dashboard   TV panels and widgets (docs/DASHBOARD.md)
packages/layers      core layers (listed below)
packages/mcp         MCP server: build a site by talking to an LLM
packages/join        the join page on GitHub Pages that phones open from the QR code (docs/join-page.md)
sites/sample         a small synthetic site for tests and dev mode
sites/chalmers       the Chalmers campus, the flagship reference site
samples              a kit of sample data, and small examples: a Python service, a controller map, a map stage
templates/site       the source of the site template repository
changes              release notes waiting for the next version (docs/RELEASING.md)
```

## Adding things

- **A layer**: copy `packages/layers/sunlight`. A layer is `layer.json` (id, controls, tools) plus `src/index.ts`. The TV and phone controls are generated from the manifest. List the layer in a site's `site.json`. See [docs/contracts/layer.md](docs/contracts/layer.md). Draw what stays still with `ctx.map.addDrawing` and what moves every frame with `ctx.map.addSprites` or `ctx.map.addStrokes` (on the graphics card, #609); WebKit on a Mac draws canvases on the processor.
- **A kernel**: add `crates/mrs-engine/src/kernels/<id>/` with `kernel.wgsl`, `cpu.rs` and `mod.rs`, register it in `kernels/mod.rs`, and add `tests/<id>.rs` with physics tests on the CPU reference and a GPU/CPU parity test. See [docs/contracts/engine.md](docs/contracts/engine.md).
- **A layer of your own site**: `mrstudio layer new <id> --site <site>`, then `mrstudio layer build`. It lives in the site's `layers/` folder and runs in the installed app, with no change to the core. See "Site layers" in [docs/contracts/layer.md](docs/contracts/layer.md#site-layers).
- **A site**: `mrstudio new-site`, add data, `mrstudio validate`. See [docs/contracts/site.md](docs/contracts/site.md).
- **A site, with an LLM**: connect the MCP server and use its `new_project` prompt. Ideas the core cannot serve become module requests to this repository. See [docs/MCP.md](docs/MCP.md).

## Tests

```bash
pnpm test        # cargo test, typecheck, SDK tests
pnpm test:e2e    # build, then every end-to-end case in Chromium against the real host
pnpm e2e -g "slideshow"  # only the cases whose names match (after a build)
pnpm smoke webkit  # every core layer on and off in one engine: chromium, webkit or msedge
pnpm lint        # promises nobody awaits or catches
cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

What is written from what, and checked by the tests so neither side drifts alone:

| Written file | From | Rewrite with |
| --- | --- | --- |
| `docs/contracts/site.schema.json` | mrs-site's types (#537) | `UPDATE_SCHEMA=1 cargo test -p mrs-site --test schema` |
| `packages/mcp/src/site-types.ts` | `site.schema.json` (#543) | `pnpm --filter @mrstudio/mcp site-types` |
| `docs/contracts/protocol.schema.json` | the host's types (#538) | `UPDATE_SCHEMA=1 cargo test -p mrs-host --test protocol_schema` |
| `apps/studio/ui/app-commands.d.ts` | the commands in `apps/studio/src-tauri/build.rs` (#544) | `pnpm --filter @mrstudio/studio app-commands` |
| `crates/mrs-cli/templates/layer/types/mrstudio-sdk.d.ts` | the SDK's types | `pnpm --filter @mrstudio/sdk types` |

The app's own pages (`apps/studio/ui/*.js` and the scripts the shell puts into windows) are type-checked as JavaScript, so calling an app command that does not exist fails `pnpm typecheck`.

Unit tests run under plain Node (`node --test --experimental-strip-types`), with no browser. Every runtime module loads there; `registry.ts` then has no core layers, since Vite's `import.meta.glob` exists only in a build (#742). Put rules that need no page, such as which rail a button goes on, where a unit test can reach them.

The end-to-end cases are in `scripts/e2e/`, one file per area: the controller, the table and its layers, the phones, the editor's scene list, the editor's flows, the setup guide, and import and new tables. Every case starts its own host on a fresh copy of `sites/sample`, so no case depends on another and they run side by side (`E2E_WORKERS` sets how many). A failed case keeps a screenshot of each page it had open, a trace and the host's log in `e2e-results/`, and the others still run. `pnpm e2e:shots` also keeps the screenshots the release notes and the docs use, in `e2e-screenshots/`.

CI runs all of these on every pull request: the end-to-end check in Chromium on Linux, and the engine smoke with WebKit on macOS (as the Mac app draws) and Edge on Windows (as WebView2 does). The smoke fails on any error a page throws, a frame slower than 5 s, and known engine traps such as large SVG filters, which WebKit draws in software. A size guard (`scripts/size-guard.mjs`, #738) fails a pull request that adds a file over 1,500 lines or grows one past it, or adds a picture over 1 MB to `docs/screenshots`, and writes lines of code per package to the job summary; `node scripts/size-guard.mjs --report` prints the same table. Dependabot opens grouped dependency updates weekly, and a weekly security audit warns about known advisories.

Measured on an Apple M4 Pro (Metal), 2026-11-14, sunlight kernel:

| Grid | Sun hours over a day, GPU | CPU reference | One instant, GPU | CPU reference |
| --- | --- | --- | --- | --- |
| 1000 x 600 | 72 ms | 390 ms | 5.8 ms | 3.0 ms |
| 2000 x 1200 | 261 ms | 2838 ms | 11.8 ms | 24.0 ms |

The GPU wins clearly on accumulated work. A single instant on a small grid is dominated by the round trip to the GPU, which is the next thing to optimise (keep the field on the GPU instead of reading it back).

The GPU tests need a Vulkan, Metal or DirectX 12 adapter. Without one they are skipped and the CPU reference tests still run. CI installs a software Vulkan driver so they always run there.
