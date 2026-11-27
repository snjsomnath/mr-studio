---
bump: none
issues: 540
audience: developers
---
### The editor's saved state is its own module, with tests

The first part of splitting `editor.ts` (#540) moves the title bar's Saved, Saving… and problem states into `packages/runtime/src/editor/save-state.ts`. Changes still reach the host the same way. The rules live in one place with no DOM: a change says Saving… only if the host takes longer than 300 ms, a refused change keeps its reason until a later change is saved, and a read-only copy never says Saved. `packages/runtime/test/save-state.test.ts` checks them without starting the editor. All 43 editor end-to-end cases pass unchanged.

![The saved state tests](docs/screenshots/540-save-state.png)
