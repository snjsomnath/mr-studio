# Releasing MR Studio

Every merge to `main` that carries a release note is a release. Nobody tags or writes notes by hand.

1. A pull request adds a release note to `changes/` (below). CI fails without one.
2. When it merges, the "Desktop app" workflow turns the notes waiting in `changes/` into the next version: it raises `version` under `[workspace.package]` in `Cargo.toml` (with `Cargo.lock` and the `package.json` files), adds the version's section to [CHANGELOG.md](../CHANGELOG.md), removes the notes, commits "Release vX.Y.Z" to `main` and tags it.
3. The same run builds the Windows installer and the macOS dmg from that tag and publishes the GitHub release, with the notes and their screenshots, and the MCP server of the same version (`mrstudio-mcp.mjs`, and `mr-studio.mcpb` for Claude Desktop). Once switched on, it also publishes the server to npm and the MCP Registry (below).
4. Installed apps see it the next time they start: Home shows **What's new**.

`node scripts/release.mjs pending` prints the version the waiting notes would make. `node scripts/release.mjs apply` does step 2 on your computer, if you ever need to.

## Writing a release note

One file per pull request, `changes/<short-name>.md`:

```markdown
---
bump: minor
issues: 195, 230
---
### Street life at rest

Walkers on the footways, cyclists on the cycleways and warm streetlights along the main streets, while nobody touches the controller.

![Street life on the table at rest](docs/screenshots/195-at-rest.png)
```

- `bump`: `minor` for something new (the default), `patch` for a fix only, `none` for a change nobody running a table notices (docs, CI, tests). `major` only on purpose. The biggest bump among the waiting notes decides the next version.
- `issues` (optional): the issues the pull request closes. They are linked after the title.
- `breaking` (optional): one sentence of what stops working the way it did and what people must do, for example `breaking: Tables saved by this version do not open in older versions; update the app on every computer.` Breaking changes are listed first, and the app shows them in red before anyone updates.
- The `###` line is the title the app shows on Home next to the first picture. Write it for the people who run a table, in their words.
- Pictures are paths from the repository root, usually `docs/screenshots/<issue>-<what>.png`, committed in the same pull request. The check fails if a picture is missing. In the published notes they become links to the tagged commit, so they keep working.
- A pull request with several separate changes may add several notes.

## What people with the app installed see

The app asks GitHub for the published releases a few seconds after it starts (this can be turned off on the Updates tab). The request carries nothing about the computer or its user.

- **Home** shows a What's new card when a newer version exists: which version, how many releases newer it is, and each new feature as a tile with its first picture. A tile opens the full notes at that feature. **Download** opens this computer's installer (the Windows setup or the macOS dmg) in the browser. After an update, Home shows what the running version brought, once, until "Put away".
- **Displays and settings, Updates** has the same notes, breaking changes first in a red box, and the build stamp: the version, the commit and the date it was built.
- Drafts and pre-releases are never offered.

Installing stays by hand: run the downloaded installer. The installers are not code-signed, so Windows SmartScreen asks once ("More info", "Run anyway"), and on macOS the first open is right click, Open.

## Publishing the MCP server

After each release, the `publish-mcp` job puts the same server on npm as `@mrstudio/mcp` (what `npx -y @mrstudio/mcp` runs, with provenance) and lists it in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.snjsomnath/mr-studio`, with the npm package and the release's Claude Desktop extension. A version already on npm is skipped, so re-running is safe. It is off until these are set:

1. On [npmjs.com](https://www.npmjs.com), create the free organisation `mrstudio` (the `@mrstudio` scope) and a granular access token that can publish to it.
2. In the repository's settings, under Secrets and variables, Actions, add the secret `NPM_TOKEN` (the token) and the variable `MCP_PUBLISH` set to `true`.
3. The registry needs no key: it signs in with the workflow's GitHub identity, which owns the `io.github.snjsomnath/` names.

To publish the version already released, run the "Desktop app" workflow by hand on its tag. To stop, set `MCP_PUBLISH` to anything else; versions already on npm stay there (npm only lets a version be withdrawn in its first 72 hours).

## Installing in place (optional, not set up)

The app can also install an update itself and restart, if releases are signed with an updater key. It is not set up, and nothing above needs it. If it is wanted later:

1. Make the key pair: `pnpm --filter @mrstudio/studio exec tauri signer generate -w ~/.tauri/mr-studio.key`, with a password.
2. In the repository's settings, under Secrets and variables, Actions, add the secrets `TAURI_SIGNING_PRIVATE_KEY` (the key file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the variable `MRS_UPDATER_PUBKEY` (the `.pub` file).
3. From then on, releases carry signed update files and `latest.json`, and the Home button reads "Update to x" and installs. Copies installed before that need one manual install. If the key is lost, installed copies need one manual install of a build made with a new key.

## Older site files

An update never strands a site. `site.json` carries a `format` number; when a release changes the format, it adds one step to `crates/mrs-site/src/migrate.rs` and its release note says so under `breaking`.
Opening a site saved by an older version runs the steps it needs, rewrites `site.json` and keeps the original beside it as `site.format-<n>.json`.
`mrstudio migrate <site>` does the same from the command line. A site saved by a newer version than the app is refused with a message that says to update the app.
