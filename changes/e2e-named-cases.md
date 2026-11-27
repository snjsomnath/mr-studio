---
bump: none
issues: 545
audience: developers
---
### The end-to-end run is 78 named cases that fail one by one

`scripts/e2e.cjs` and `scripts/e2e-editor.cjs` were two long lists of steps sharing one host, and the first broken step hid every check after it. They are now Playwright test files in `scripts/e2e/`, one per area: controller, table and layers, phones, editor scene, editor flows, setup guide, and import and new tables. Every case starts its own host on a fresh copy of `sites/sample`, so cases don't depend on each other and run side by side. A failed case keeps a screenshot of each page it had open, a trace and the host's log in `e2e-results/`, and the others still run. `pnpm e2e -g "slideshow"` runs only the matching cases (after `pnpm build && cargo build -p mrs-cli`). `pnpm e2e:shots` also keeps the screenshots the release notes and docs use. To check the split, the controller's "Next step" button was renamed on purpose: exactly the two cases that press it failed, and 76 passed. The Edge smoke now also reports a lost WebGL context and names the WebGL renderer, so a failure gives its cause instead of an empty shader log.

![Breaking one button fails only the cases that use it](docs/screenshots/545-named-cases.png)
