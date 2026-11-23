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
| `read_doc` | Architecture, roadmap and every contract, verbatim |
| `list_layers`, `describe_layer` | Core (and site) layers with their controls, tools, data needs and panels; planned roadmap layers |
| `list_building_blocks` | Visual, data, interaction and TV primitives, each marked built or planned from the code itself |
| `create_site` | A new site package: `site.json`, `data/`, `requests/`, README, `.gitignore` |
| `get_site`, `update_site` | Read a site with effective params; change settings (place, table, scene sources, basemap, branding, tv) |
| `add_layer`, `set_layer`, `move_layer`, `remove_layer` | Compose the scene by instance id: layers, items inside a layer (`parent`), and buttons with groups; params are checked against the layer's controls with the host's rules |
| `set_steps` | How Next moves through a layer, and a slideshow's sequence of layers |
| `save_custom_layer` | Save or remove a custom layer: a recipe of data, look, motion and interaction blocks, used as `custom:<id>` |
| `validate_site` | The site and layer contracts, plus `mrstudio validate` when the CLI is installed |
| `preview_site` | The command and URLs to preview the site on this machine |
| `check_layer_idea` | Says whether an idea is an existing layer to configure, a new core layer from existing blocks, or needs new blocks or kernels |
| `draft_module_request` | Writes `requests/<date>-<title>.md` and a prefilled GitHub issue link. Sends nothing |
| `submit_module_request` | Opens a draft as an issue, with `GITHUB_TOKEN`/`GH_TOKEN` or a signed-in `gh`; otherwise returns the link |

**Prompts**: `new_project` (story, place, scene, data, branding and welcome, TV, validation), `brainstorm_layer`, `design_dashboard`, `request_module`.

**Resources**: `mrstudio://docs/<name>` and `mrstudio://layers/<id>`.

The server also sends short instructions on connect: build from what exists, configure rather than code, edit only through the tools, and submit requests only after the person agrees.

## Where its knowledge comes from

The server describes one core version. It looks, in order, for:

1. `--core <folder>` or `MRSTUDIO_CORE`: a checkout of this repository, read live.
2. A checkout above the project folder, the working folder or the server file itself (so running it from this repository is always current).
3. The snapshot built into `dist/mrstudio-mcp.mjs`: the layers, docs and block status of the commit it was built from.

Layers are read from `packages/layers/*/layer.json`, docs from `docs/`, kernels from `crates/mrs-engine/src/kernels/`, and a block counts as built only when its API appears in the SDK, runtime or dashboard source. A new core layer or doc shows up without touching the server.

## Install

Build it once from this repository (Node 22.18 or newer for the build; the built file runs on Node 20+):

```sh
pnpm install
pnpm --filter @mrstudio/mcp build      # writes packages/mcp/dist/mrstudio-mcp.mjs
```

`dist/mrstudio-mcp.mjs` is a single file with no dependencies. Copy it anywhere. Until releases exist, that file is the distributable; the plan is to ship it inside the app next to the `mrstudio` CLI and publish it to npm as `@mrstudio/mcp` with the same version as the app (the "Release and distribution" work package).

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
