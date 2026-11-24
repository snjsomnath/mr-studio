# MR Studio MCP server

`@mrstudio/mcp` lets a team build an MR Studio project by talking to their own LLM (Claude, or any client that speaks the Model Context Protocol).
The model gets tools that read the core's layers, building blocks and contracts, create and edit a site package with every change validated, and turn ideas the core cannot serve yet into requests for this repository.

It follows the distribution model in [ARCHITECTURE.md](ARCHITECTURE.md): a team keeps only its site, never a fork.
The server writes `site.json`, never layer code. When a project needs a new layer, block, kernel or site setting, the server drafts a module request (an issue on `snjsomnath/mr-studio`) so it is built once, in the core, for everyone.

## What it offers

**Tools**

| Tool | Does |
| --- | --- |
| `overview` | What MR Studio is, the core version, the layers, kernels and blocks it has, and the workflow |
| `read_doc` | Architecture, roadmap, the changelog and every contract, verbatim |
| `whats_new` | What changed in the core, newest version first, from `CHANGELOG.md`, plus notes merged but not yet released; `since` limits it to versions newer than a team's |
| `list_layers`, `describe_layer` | Core (and site) layers with their controls, tools, data needs and panels; planned roadmap layers |
| `find_capabilities` | Everything MR Studio can and cannot do for a goal in plain words: layers, building blocks, kernels, site features, planned work and constraints, ranked, each with why it matched, its status from the code (`available`, `needs_setup`, `planned`, `unsupported`), what it needs, what the table, controller and phones do, what it pairs with and the files that prove it. With `site`, requirements say whether that site meets them |
| `describe_capability` | One capability in full: purpose, questions it answers, requirements, surfaces, limits, example sites, evidence, related issues, and a layer's controls |
| `list_building_blocks` | Visual, data, interaction and TV primitives, each marked built or planned from the code itself (`find_capabilities` with `kind` gives the same with evidence) |
| `create_site` | A new site package: `site.json`, `data/`, `requests/`, README, `.gitignore` |
| `get_site`, `update_site` | Read a site with effective params; change settings (place, table, scene sources, basemap, branding, tv) |
| `add_layer`, `set_layer`, `move_layer`, `remove_layer` | Compose the scene by instance id: layers, items inside a layer (`parent`), and buttons with groups; params are checked against the layer's controls with the host's rules |
| `set_steps` | How Next moves through a layer, and a slideshow's sequence of layers, with presenter `notes` per step for the guide's phone |
| `save_custom_layer` | Save or remove a custom layer: a recipe of data, look, motion and interaction blocks, used as `custom:<id>`. Blocks, props, colours, ramps, pictograms and icons are checked against the recipe player in `packages/sdk`, and the controller's legend is worked out from the looks and their data, as the editor does |
| `validate_site` | The site and layer contracts, plus `mrstudio validate` when the CLI is installed |
| `preview_site` | How to see the site on this computer: open it in the installed app, or a `mrstudio dev` command on a free port (never the app's 4170) with the app's own surfaces; URLs of the editor, table, controller, guide's phone, phone and dev view |
| `check_layer_idea` | Says whether an idea is an existing layer to configure, a new core layer from existing blocks, or needs new blocks or kernels |
| `draft_module_request` | Writes `requests/<date>-<title>.md` and a prefilled GitHub issue link. Sends nothing |
| `submit_module_request` | Opens a draft as an issue, with `GITHUB_TOKEN`/`GH_TOKEN` or a signed-in `gh`; otherwise returns the link |

**Prompts**: `new_project` (story, place, scene, data, branding and welcome, TV, validation), `brainstorm_layer`, `design_dashboard`, `request_module`.

**Resources**:

| Resource | Holds |
| --- | --- |
| `mrstudio://concepts` | How to design an experience: the three surfaces, what goes where, the words and the constraints ([experience-design.md](experience-design.md)) |
| `mrstudio://patterns/<id>` | Experience patterns (compare today and the proposal, map it together, a guided story…), each with the table, controller and phone roles and the capability ids it uses |
| `mrstudio://capabilities`, `mrstudio://capabilities/<id>` | The capability catalogue, and one record in full |
| `mrstudio://schema/site`, `mrstudio://schema/recipe` | The keys `site.json` accepts at each level, and a custom layer recipe's blocks, props, colours, ramps and icons |
| `mrstudio://examples/<id>` | Real sites and samples in the core: their layers, steps and custom layers |
| `mrstudio://docs/<name>`, `mrstudio://layers/<id>` | Every doc verbatim, and each layer's `layer.json` |

**Results.** Every tool declares an output schema and returns `structuredContent` (with a text copy for older clients): `ok`, a one-line `summary`, and the tool's own fields. A refusal has `ok: false` and `error: { code, message, recoverable, next }`, for example `would_invalidate`, `unknown_layer`, `unknown_setting`, `site_invalid` or `not_submitted`; nothing is written when a tool refuses. Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`); only `submit_module_request` reaches outside the computer.

The server also sends short instructions on connect: build from what exists, configure rather than code, edit only through the tools, and submit requests only after the person agrees.

## Where its knowledge comes from

The server describes one core version. It looks, in order, for:

1. `--core <folder>` or `MRSTUDIO_CORE`: a checkout of this repository, read live.
2. A checkout above the project folder, the working folder or the server file itself (so running it from this repository is always current).
3. The snapshot built into `dist/mrstudio-mcp.mjs`: the layers, docs and block status of the commit it was built from.

Layers are read from `packages/layers/*/layer.json`, docs from `docs/`, the changelog from `CHANGELOG.md` and `changes/`, site settings from the structs in `crates/mrs-site/src/manifest.rs`, kernels from `crates/mrs-engine/src/kernels/`, a block counts as built only when its API appears in the SDK, runtime or dashboard source, and what each layer is for (purpose, questions it answers, what it pairs with, limits) from the `about` in its `layer.json`. The capability catalogue is built from all of these; a roadmap row counts as planned only while nothing in the code covers it. A new core layer, doc or site setting shows up without touching the server.

### Keeping it current

`node scripts/check-docs.mjs` runs in CI on every pull request. It fails, saying which file to change, when a layer, a kernel, a site setting, an MCP tool or an SDK module exists that the docs or the server do not cover: every layer must be in `README.md` and `docs/ROADMAP.md`, every kernel in `docs/contracts/engine.md`, every site setting in `docs/contracts/site.md`, every tool in this file, and every SDK module in `packages/mcp/src/blocks.ts` (the building blocks the server offers) or `docs/blocks.md`.
Each pull request also writes a release note in `changes/` (see [RELEASING.md](RELEASING.md)), and `whats_new` reads them, so an LLM connected to the server knows what was added since a team's version.

## Install

Build it once from this repository (Node 22.18 or newer for the build; the built file runs on Node 20+):

```sh
pnpm install
pnpm --filter @mrstudio/mcp build      # writes packages/mcp/dist/mrstudio-mcp.mjs
```

`dist/mrstudio-mcp.mjs` is a single file with no dependencies. Copy it anywhere. Every release on GitHub has it attached as `mrstudio-mcp.mjs`, built from the same commit as the app, so a team can take the server that matches the app they run. Shipping it inside the app and publishing it to npm as `@mrstudio/mcp` is still to do.

### Claude Code

From the team's site repository:

```sh
claude mcp add mrstudio -- node /path/to/mrstudio-mcp.mjs --project .
```

### Claude Desktop

Edit the config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "mrstudio": {
      "command": "node",
      "args": ["/Users/me/mrstudio/mrstudio-mcp.mjs", "--project", "/Users/me/code/harbour-site"]
    }
  }
}
```

On Windows use paths like `"C:\\Users\\me\\mrstudio\\mrstudio-mcp.mjs"`. Desktop clients start servers in an arbitrary folder, so always pass `--project`.

### Other clients

Any MCP client that launches a stdio server works (Cursor, VS Code, Zed): command `node`, arguments `[<path to mrstudio-mcp.mjs>, "--project", <site repo>]`.

### Options

| Option | Environment | Meaning |
| --- | --- | --- |
| `--project <folder>` | `MRSTUDIO_PROJECT` | Folder that relative site paths resolve against. Default: the working folder |
| `--core <folder>` | `MRSTUDIO_CORE` | Read the core live from a checkout instead of the snapshot |
| | `MRSTUDIO_CLI` | Path to the `mrstudio` binary, if it is not on `PATH` |
| | `MRSTUDIO_REPO` | Repository requests go to. Default `snjsomnath/mr-studio` |
| | `GITHUB_TOKEN`, `GH_TOKEN` | Lets `submit_module_request` open issues directly |

## A session, roughly

> **Person**: Use the new_project prompt. We want the harbour area for a public workshop on the 2040 plan.
>
> The model asks for the story and the area, calls `create_site`, lists layers, adds sunlight with an autumn afternoon, sets the title and background, and runs `validate_site`.
>
> **Person**: Can we show buses moving along their routes?
>
> The model calls `check_layer_idea`. Animated paths and live feeds are planned blocks, so the verdict is `needs-new-module`, linked to the roadmap's Public transport layer. It drafts a `block` request in `requests/`, shows the link, and files it only when asked.

## Developing the server

```sh
pnpm --filter @mrstudio/mcp typecheck
pnpm --filter @mrstudio/mcp test       # builds, then drives the bundle over stdio in a scratch folder
```

The allowed `site.json` keys are read from the serde structs in `crates/mrs-site/src/manifest.rs`, so a new site setting reaches the server without a change here. Param checks mirror the host's control validation (`crates/mrs-host/src/layers.rs`); when that changes, change `src/site.ts` in the same pull request. `mrstudio validate` stays the authority and runs whenever it is found.
The block list is `src/blocks.ts`: add a block there when it is planned, with the pattern that will prove it exists.
