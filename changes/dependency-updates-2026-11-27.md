---
bump: patch
audience: developers
---
### Dependencies updated: MapLibre 6, three.js 0.187, Vite 8 and the rest

The eleven open dependency updates are folded into one change:

- **MapLibre GL 5 → 6.** MapLibre 6 has no default export and looks for its worker file next to its own module, which the bundle does not keep. `packages/runtime/src/maplibre.ts` now imports it, ships the worker as an asset and points MapLibre at it. Every module imports MapLibre from there.
- three.js and its types 0.180 → 0.187, Vite 7 → 8, Playwright 1.63 → 1.65, the Tauri CLI, Tauri and tauri-build patch releases.
- Rust: tower-http 0.6 → 0.7, pollster 0.4 → 1.0, base64 0.22 → 0.23, and patch releases of anyhow, clap and zip.
- GitHub Actions: checkout, setup-node, pnpm setup, upload/download artifact, Pages and the release action to their current majors. The Rust toolchain stays at 1.100.0: Dependabot proposed 1.120.0, which does not exist, and it now leaves that action alone.

Nothing behaves differently on a table. The unit tests, the type checks and the end-to-end run pass.

![The table drawn with MapLibre 6](docs/screenshots/deps-maplibre6-table.png)
