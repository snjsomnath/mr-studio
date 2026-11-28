---
bump: none
issues: 741
audience: developers
---
### The two big stylesheets are split into parts

`style.css` (4,600 lines) and `editor.css` (5,600 lines) are now lists of imports. The parts are 12 files in `packages/runtime/src/styles/` and 15 in `packages/runtime/src/editor/styles/`, each under 1,200 lines. The built CSS is byte for byte the same as before, so nothing looks different.
