---
bump: patch
audience: developers
---
### Dependency updates, 28 November

This updates globals, eslint 10, @types/node 26, sha2 0.11, parking_lot 0.13, tiny-skia 0.12 and rusqlite 0.43 in one go, with the one code change rusqlite needed. TypeScript 7 is left out: typescript-eslint can't check with it yet, so dependabot now skips TypeScript major versions until it can.

![What was updated and what was left out](docs/screenshots/deps-2026-11-28.png)
