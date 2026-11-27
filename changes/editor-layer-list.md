---
bump: none
issues: 540
audience: developers
---
### The editor's layer list rules are their own module, with tests

The second part of splitting `editor.ts` (#540) moves the layer list's rules into `packages/runtime/src/editor/layer-list.ts`, with no DOM: what goes under At rest, down each rail and under a layer as its items, which stack an item of a glass or a reveal line is in, what each dataset is from its file, what a row and its eye say, and where a copy goes with its button. The editor builds the same rows from these answers. `packages/runtime/test/layer-list.test.ts` checks the rules without starting the editor, and the 56 editor, layers, import and setup guide end-to-end cases pass unchanged.

![The layer list and its tests](docs/screenshots/540-layer-list.png)
