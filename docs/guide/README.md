# The MR Studio guide

These pages are the Help window in the app (the Help tab of the editor's ribbon). They are written for the people who make and run a table, not for developers.
`scripts/build-help.mjs` turns them, the core layers and `CHANGELOG.md` into the window's content when the app is built, so the app's help always matches its version.

- Each guide is one file: a `#` title, a one-line summary in italics, then numbered steps. Pictures are paths from the repository root (`docs/screenshots/...`).
- `features.md` lists every core layer; CI fails when a layer is missing from it (`scripts/check-docs.mjs`).
- `layers/<id>.md` is each core layer's own page (#291): `## What it shows` (with a picture), `## Good for`, `## Set it up` (numbered steps) and `## Tips`. The build adds what the layer needs and every setting from its `layer.json`, so those never fall behind. CI fails when a layer has no page.
- `troubleshooting.md` goes by what the person sees: one `##` per problem, then what to do.
- The order of the guides in the window is the order of the file names.
