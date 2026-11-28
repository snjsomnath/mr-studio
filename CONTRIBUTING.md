# Contributing to MR Studio

How work is done in this repository, on one page. The layout of the code and the tests are in
[docs/core-developers.md](docs/core-developers.md); the design is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Making a table for your own place needs none of this: start from the
[site template repository](https://github.com/snjsomnath/mr-studio-site-template) and install the app.

## Before you write code

- **Every request is an issue first.** It is linked from the index in
  [#49](https://github.com/snjsomnath/mr-studio/issues/49), which is also the build order, and it
  carries a priority label. Work starts from the issue, not from a chat.
- **New site data is shown with the layers that exist** where it can be
  ([#487](https://github.com/snjsomnath/mr-studio/issues/487)): convert the data, do not add a feature.
- **A new layer is built from SDK blocks** (visuals, data sources, pointer interactions). When a
  block is missing, the block goes into the SDK and the layer uses it.
- **Nothing that belongs to one site goes into core.** A site's own layers live in its `layers/`
  folder, in its own repository.
- **The table is a 2D top-down picture with almost no text.** No extrusion and no 3D camera.
  Words and controls live on the controller and the phone.

## Pull requests

- **One pull request per issue, or per small group of related issues.** The description says what
  changed and why, names the issues it closes, and shows its screenshots inline.
- **Every pull request adds `changes/<name>.md`**: a bump (`minor` for something new, `patch` for
  a fix, `none` for docs or CI only), the issues, a title, a sentence or two, and a picture unless
  the bump is `none`. CI fails without it. Every merge to main becomes a numbered release from
  these notes ([docs/RELEASING.md](docs/RELEASING.md)).
- **A contract change edits its file in [docs/contracts](docs/contracts) in the same pull
  request.** `node scripts/check-docs.mjs` says what else must follow: the README, the Help page,
  the MCP server.
- **A change to what the SDK exports** regenerates the types that layer packages are checked
  against: `pnpm --filter @mrstudio/sdk types`.
- **Tests are fixed, not skipped.** A check that fails is not disabled to get a green run.
- **An issue is closed with a comment that shows the result**, with a screenshot.
- **Screenshots link by commit SHA or `main`, never by a PR branch.** A pull request's branch is
  deleted when it merges, so `raw.githubusercontent.com/snjsomnath/mr-studio/claude/<branch>/…`
  breaks. Link to the full commit SHA that holds the picture
  (`…/mr-studio/<sha>/docs/screenshots/<issue>-<what>.png`), or to `main` once it has merged.
  This holds for pull request descriptions and issue comments alike.
- **Only release-note pictures go on main** (#737). A picture a `changes/` note shows goes in
  `docs/screenshots/`, under 1 MB (save it at 1x, or as JPEG). Every other screenshot for an issue
  or a pull request goes on the `screenshots` branch, which holds nothing but pictures, and is
  linked by that branch's commit SHA:

  ```sh
  git fetch origin screenshots && git worktree add ../shots screenshots
  cp my-picture.png ../shots/<issue>-<what>.png
  git -C ../shots add . && git -C ../shots commit -m "Screenshots for #<issue>" && git -C ../shots push
  git -C ../shots rev-parse HEAD   # link …/mr-studio/<this sha>/<issue>-<what>.png
  ```

  The pictures already in `docs/screenshots/` stay: issues and release notes link them.
- **Keep files under 1,500 lines** (#738). CI fails a pull request that adds a file over that, or
  grows one past it, and fails pictures over 1 MB or more than 5 MB of them. A file already over
  the limit only gets a warning: split it when you next work in it (#542).

## Licence of contributions

MR Studio is licensed under the Business Source License 1.1 by Nodal Works AB (see the
[README](README.md#licence)). By opening a pull request, you agree that Nodal Works AB may distribute your
contribution under the licences of this repository, including the MIT parts, the Change License and
commercial licences.

## Code

- Rust is formatted with the pinned toolchain, and clippy warnings are errors:

  ```bash
  cargo +1.100.0 fmt --all
  cargo clippy --all-targets -- -D warnings
  ```

- TypeScript passes `pnpm -r typecheck` and `pnpm lint`.
- Comments and messages say what happens in plain words; a message a person sees says what they
  can do next.

## Running it

```bash
pnpm install
pnpm dev                                  # the host and the web dev server on the sample site
pnpm dev -- --site sites/chalmers         # another site
```

<http://localhost:5173/dev> is the layer dev mode: the table with one layer's generated controls
beside it, with hot reload. `/edit` is the editor; `/table`, `/tv` and `/phone?c=<code>` are the
real surfaces.

```bash
pnpm test             # cargo test, type checks, SDK, runtime and MCP tests
pnpm test:e2e         # a real browser against the real host (Playwright with Chromium)
pnpm e2e -g "editor"  # only the end-to-end cases whose names match, after a build
pnpm smoke chromium   # every core layer on and off in one engine: chromium, webkit or msedge
```

A layer of a site: `mrstudio layer new <id> --site <site>`, then `mrstudio layer build`
([docs/contracts/layer.md](docs/contracts/layer.md#site-layers)).
