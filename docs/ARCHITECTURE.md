# MR Studio 2.0 architecture

Status: the working contract for everyone building MR Studio 2.0. It describes what is built; what is planned and not built is said so in place.
Change a contract by editing its file in the same pull request as the code that needs it.

## What MR Studio is

MR Studio puts a real place on a projected physical table so a group can explore it together.
A TV shows controls and dashboards, and visitors steer from their phones.
Version 2.0 keeps those functions and replaces everything else.

Functions that must survive from the current app (`Nodal-Works/interactive_map`):

| Function today | Where it lives in 2.0 |
| --- | --- |
| Projected table map with calibration | `runtime` table surface, calibration stored in the site package |
| TV controller and dashboards | `runtime` tv surface, controls generated from layer manifests, optional layer panels |
| Phone participation | `runtime` phone surface served by the host on the local network |
| Wind (CFD), sunlight, stormwater, isovist, thermal comfort | Kernels in the compute engine, each with a thin visual layer |
| Street life, transit, slideshow, ECOM energy, street view, bird sounds | Layer packages (no kernel needed, or a Python service behind the gateway) |
| Touch, keyboard | Inputs that produce the same layer actions and tool inputs |
| Multi-screen launch | The desktop shell places one window per display |
| Per-site variants (Chalmers, Lindholmen, Universeum) | Site packages, never branches |

## Shape of the system

```
                         one desktop app per studio (Windows and macOS)
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  apps/studio  (Tauri shell: windows on displays, kiosk, updates)             │
 │  ┌──────────────────────────────┐   ┌─────────────────────────────────────┐  │
 │  │ mrs-host                     │   │ mrs-engine (own thread, wgpu)       │  │
 │  │  HTTP: surfaces, site files  │   │  Scene: dtm, dsm, canopy on the GPU │  │
 │  │  WS:   session hub, RPC      │◄─►│  Kernels: sunlight, wind, ...       │  │
 │  │  field streams (binary)      │   │  Jobs, scheduler, CPU reference     │  │
 │  └───────────▲──────────────────┘   └─────────────────────────────────────┘  │
 └──────────────┼───────────────────────────────────────────────────────────────┘
                │ one protocol (JSON requests and events, binary field frames)
   ┌────────────┼──────────────┬──────────────────────┐
   │ table window              │ TV window            │ phones on local Wi-Fi
   │ runtime + layers (TS)     │ controls + panels    │ generated controls, tools
```

One process owns everything. The shell embeds the host, and the host owns the engine.
Every screen, including a phone, is a *surface*: a web page that speaks one WebSocket protocol to the host.
`mrstudio dev` runs the same host without the shell, which is also the layer dev mode.

## Principles

1. **The host is the authority.** Layer state (active, params) lives in the host. Surfaces send requests and render what the host broadcasts. No surface-to-surface channels.
2. **The engine computes, layers draw.** Heavy work is a kernel in `mrs-engine`. A layer asks for a field and renders it. Layer code never contains a solver.
3. **Geometry loads once.** A site's terrain, buildings and canopy are baked to one grid and uploaded to the GPU once. Every kernel reads the same scene.
4. **Every kernel has a CPU reference.** GPU and CPU run the same algorithm, and a parity test compares them in CI. Speed-ups cannot silently change results.
5. **Nothing site-specific in core.** Paths, bounds, branding and datasets live in `sites/<id>`.
6. **Contracts are versioned.** `site.json` has `format`, layer manifests have `api`, the wire protocol has `protocol`.
7. **Building blocks before ports.** A layer is a short composition of shared primitives, not a port of an old layer. When a layer from the old app is wanted (cultural gravity, ECOM, street life), first ask which reusable blocks it is made of, build those in the SDK or the engine, and then assemble the layer from them. The blocks fall into three groups: visuals (field overlays, markers, animated paths, glows, legends, charts), data sources (site datasets, live feeds, services, kernel streams) and interactions (a pointer on the table driving a person marker or a magnifier, phone tools, drawing). A primitive earns its place when a second layer can use it unchanged; the sunlight layer's soft field overlay, table decoration and sun position helper are the first examples.

## Workspace

```
crates/
  mrs-engine/     compute engine (Rust, wgpu, WGSL kernels, CPU reference)
  mrs-site/       site package format, validation, scene baking
  mrs-host/       local host: HTTP, WebSocket session hub, engine bridge
  mrs-cli/        `mrstudio` binary: dev, validate, new-site, prepare, bench
  mrs-relay/      the phone relay (#89): carries phones to a table that is not on their network
apps/
  studio/         Tauri shell (embeds mrs-host)
packages/
  sdk/            @mrstudio/sdk: layer API, protocol types, engine client, field rendering
  dashboard/      @mrstudio/dashboard: the TV panel grid, widgets, density budget, themes
  runtime/        @mrstudio/runtime: surfaces (table, tv, phone, dev), scene composer, layer manager, generated controls
  layers/         core layer packages: basemap, ambient (cars, building-lights, street-life, street-glow, transit, trees), slideshow, sunlight, sketch, then wind, stormwater, isovist, ...
  join/           the join page on GitHub Pages that a QR code opens
  mcp/            @mrstudio/mcp: MCP server that lets a team's LLM assemble sites and draft core requests
sites/
  sample/         small synthetic site used by tests and layer dev mode
samples/          a kit of sample data; service-example (a small Python service a site can bring, site.md, Services), controller-map-example and map-stage-example
templates/        site: the source of the site template repository
docs/contracts/   the interface contracts below
```

## Contracts

| Contract | File | Owner crate or package |
| --- | --- | --- |
| Engine API: scene, kernels, jobs, fields | [contracts/engine.md](contracts/engine.md) | `mrs-engine` |
| Layer API: manifest, lifecycle, controls, tools | [contracts/layer.md](contracts/layer.md) | `@mrstudio/sdk` |
| Site package format | [contracts/site.md](contracts/site.md) | `mrs-site` |
| App, display and session model, wire protocol | [contracts/session.md](contracts/session.md) | `mrs-host` |
| Mobile controller | [contracts/mobile.md](contracts/mobile.md) | `@mrstudio/runtime` |
| Presentation: buttons, stage, steps, ribbons, attract and idle reset | [contracts/present.md](contracts/present.md) | `@mrstudio/runtime` |
| Model surface: digital twin, projector cameras, calibration | [contracts/model.md](contracts/model.md) | `@mrstudio/runtime` |
| TV dashboard: panels, widgets, density budget, themes | [contracts/dashboard.md](contracts/dashboard.md), design in [DASHBOARD.md](DASHBOARD.md) | `@mrstudio/dashboard` |
| Visualisation philosophy: what goes on which surface, encodings, colour, motion, learnings from the table | design in [visualisation.md](visualisation.md) (living document) | all layers |
| Editor UI: layout, ribbon tabs, one home per setting, right-click, help, wizard | rules in [editor-ui.md](editor-ui.md) (agreed 2026-11-24) | `@mrstudio/runtime` editor |

## Key decisions

- **Results travel as binary WebSocket frames on localhost.** The same path serves the table window, the TV and a phone, and works in dev mode in a normal browser. Fields default to 8-bit quantised with a min and max, so a 1024² field is 1 MB per frame. A native shared-texture path can be added later behind the same `FieldStream` API without touching layers.
- **The host schedules the engine.** A job with subscribers is stepped inside a frame budget and pushes a frame only when its revision changes. Layers never poll.
- **The simulation grid is aligned to the table.** The grid is a rotated rectangle around the site origin, so no cells are wasted on area the table does not show. Kernels read the rotation from the scene.
- **Local metric coordinates.** The engine works in east/north metres on a tangent plane at the site origin. That needs no projection library, is accurate to centimetres over a few kilometres, and works anywhere in the world. Site prep reprojects source data to WGS84.
- **A scene is a list.** What a table shows is the ordered `layers` list in `site.json`, drawn bottom to top. The editor at `/edit` edits it through the host, and layers that are not analysis (base map, ambient life, media) are ordinary layer packages that draw into the scene's order.
- **What moves is drawn by the graphics card.** Still pictures (streets, building outlines, plans) are drawings, made once. Anything that moves every frame (lights, vehicles, people, tree crowns, trails) is GPU sprites or strokes, one instanced draw per layer, placed from a small buffer (layer.md, `addSprites`, `addStrokes`; #609). WebKit on macOS draws canvases on the processor, so a layer that redraws a whole-table picture each frame cannot keep the projector smooth there.
- **The TV has a budget.** Dashboard panels sit on a fixed 12 by 6 grid, come in eight sizes and each spend a counted share of what one screen may ask a visitor to read. A panel over its budget is refused; too many panels become another page. Sites restyle through tokens and cannot change the rules.
- **Controls are data.** A layer declares its controls in the manifest. The TV and phone UIs are generated from them, and the host validates every change against them.
- **Python stays outside the app process.** Data preparation and research models run as services declared under `services` in site.json; the host starts them, keeps them running and is the only way surfaces reach them (`/api/services`, `ctx.service`; site.md, Services).
- **Per-thing settings are data, not controller code.** Things a visitor picks and changes one by one (an energy community's buildings) are `entities` in layer.json: the runtime picks them on the table and shows their controls on the controller, and the host keeps the values in `params.entities` (layer.md, Entities; #279). A layer's own app on the controller (a map to choose on) is its `stage`, built on the SDK's `controllerMap`; it reaches the table only through the host, with tool inputs and named actions (layer.md, The controller stage; #283).

## Distribution and updates

There is one core, maintained in this repository. Nobody clones, forks or branches it to make their own table.
A team installs the core and keeps only what is theirs in a repository of their own.

What a team installs:

| Thing | Form | For |
| --- | --- | --- |
| MR Studio app | Installer for Windows and macOS from the GitHub release, not code signed (#502). The app checks for a newer version and shows its notes; installing it is by hand ([RELEASING.md](RELEASING.md)) | Running a table. Contains the engine, host, runtime and core layers |
| `mrstudio` CLI | Ships inside the app; **Install command line tool** in the app puts it on the PATH (#370); also `cargo install` | Creating, validating and previewing sites and layers |
| `@mrstudio/sdk` | Inside the app: the code is supplied when a layer loads, and its types are written into each layer package (`types/mrstudio-sdk.d.ts`, #508). Not on npm | Writing custom layers and TV widgets |
| MR Studio MCP server | One file inside the app, also npm `@mrstudio/mcp` | Building a site by talking to an LLM ([MCP.md](MCP.md)) |

What a team owns: a site repository made from the [site template repository](https://github.com/snjsomnath/mr-studio-site-template) (#86; `mrstudio new-site` makes the same `site.json`). Its source is `templates/site` in this repository, which a test opens and validates; a change there is copied to the template repository, and the template's check installs the app version the table names in `mrstudio.version`, or `MRSTUDIO_VERSION` for a table that names none.
It holds `site.json`, data, custom layers and dashboards, its own code layers in `layers/` (built with `mrstudio layer build`, loaded by the app; see layer.md, Site layers), and `mrstudio.version`, the newest MR Studio that changed it (site.md, Which MR Studio a table needs). It contains no core code.
The app opens that folder. Updating the core is installing a newer app; the site folder is not touched.

Versioning. The app, CLI and SDK share one semantic version. What that version promises is the contracts, each of which carries its own number:
`format` in `site.json`, `api` in `layer.json`, `protocol` in the wire hello, and kernel ids with their params and fields.

- Patch and minor releases never break a site or layer that worked on the same major version. New controls, kernels and fields are additions.
- A breaking change raises the contract number and the major version. The app keeps reading the previous `format` and `api` for one major version and `mrstudio migrate` rewrites a site to the new one.
- Additions are not breaks, so `format` and `api` do not say which app a table needs. A table carries the version of the newest app that changed it (`mrstudio.version`) and a site layer the oldest app it runs in (`requires.app`). An older app that cannot read the table refuses it and says which version to install; one that can read it says so and offers to open it anyway (#509).
- Kernel results are part of the promise: the parity and physics tests guard them, and a change in output beyond the stated tolerance is a breaking change.

There is one release line: every merge to `main` whose checks pass becomes a numbered release ([RELEASING.md](RELEASING.md)). A venue keeps a version by not installing the next one; the app never updates itself. Channels (`stable`, `beta`) and pinning a version are not built.

A custom layer that proves useful to more than one team moves into the core through a pull request, and from then on reaches everyone through an app update.
When a site needs a layer, block, kernel or setting the core lacks, the team files a module request (an issue from `.github/ISSUE_TEMPLATE/module-request.yml`, which the MCP server drafts) rather than writing its own copy.

Built so far: a release from every merge, the in-app update check with release notes and breaking changes, the site format migration pipeline, the site template repository (#86) and the MCP server on npm; see [RELEASING.md](RELEASING.md). In-place install from signed update files exists in code but is not set up, by decision (no updater key). Not built: channels and pinning, operating system code signing (#502) and npm publishing of the SDK (a layer package gets the SDK's types from the app instead, #508).

## Work packages

The layers planned beyond the first set, and the kernels and blocks each one reuses, are in [ROADMAP.md](ROADMAP.md).

These are independent once the contracts are fixed.

| Package | Scope | Contract |
| --- | --- | --- |
| Engine core and sunlight | Scene, job scheduler, sunlight kernel, parity harness | engine.md |
| Wind kernel | D2Q9 TRT lattice Boltzmann in WGSL, ported from `cfd-core.js`, which becomes the CPU reference | engine.md |
| Stormwater and isovist kernels | Live shallow water (local inertial) with rain, roofs and infiltration; ray-cast visibility | engine.md |
| Desktop shell | Tauri app, display placement, kiosk, auto-update, Windows and macOS builds | session.md |
| Session hub and phone controller | Rooms, slots, roles, join by QR, tools, reconnect | session.md, mobile.md |
| Layer SDK and runtime | Layer manager, generated controls, TV layout, dev mode | layer.md |
| Site tooling | `mrstudio new-site` and `prepare`, Python prep, Chalmers port | site.md |
| Scene composer and ambient layers | Instance ids, live add and reorder, dark base map, cars, lights, transit, trees, composer page | site.md, layer.md |
| Layer building blocks | Shared visual, data and interaction primitives in the SDK that layers are composed from | layer.md |
| Model surface and calibration | Digital twin of the physical model, projector cameras, three.js rendering, `ctx.model` | model.md |
| Release and distribution | Signed installers, updater and channels, npm publishing of the SDK, site template, `mrstudio migrate` | this document |
