# The MR Studio guide

These pages are the Help window in the app (the Help tab of the editor's ribbon). They are written for the people who make and run a table, not for developers.
`scripts/build-help.mjs` turns them, the core layers and `CHANGELOG.md` into the window's content when the app is built, so the app's help always matches its version.

- Each guide is one file: a `#` title, a one-line summary in italics, then numbered steps. Pictures are paths from the repository root (`docs/screenshots/...`).
- `features.md` lists every core layer; CI fails when a layer is missing from it (`scripts/check-docs.mjs`).
- The order of the guides in the window is the order of the file names.
