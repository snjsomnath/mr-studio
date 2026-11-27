---
bump: patch
issues: 623
---
### Trees inside Wind fade as a whole

Wind's faint tree crowns now fade with Wind's opacity, and they step aside while a Trees layer inside Wind is on, so that layer's opacity fades the whole tree, outline included (#623). The trees still slow the wind. A custom layer's lines no longer keep a faint glow when their opacity is turned down.

Layer authors can read `ctx.items`: the layers inside theirs, with the layer each uses and whether it is on.

![Before and after: Wind at 30%, and Trees inside Wind at 100% and 10%](docs/screenshots/623-before-after.png)
