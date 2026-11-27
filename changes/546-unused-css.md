---
bump: none
issues: 546
audience: developers
---
### Unused CSS is gone, and a check keeps it that way

`scripts/unused-css.mjs` lists class names in the style sheets that no TypeScript, JavaScript, HTML, Rust or JSON file uses, counting names the code builds at run time (`is-${kind}`) as used (#546). It found 25, all left over from the old setup guide (`wz-…`), the old Display tab (`dt-…`) and the editor before #382. Their 40 rules, 262 lines, are removed. The end-to-end run passes unchanged.

CI now runs the script, so a rule for a class nothing uses fails the pull request. A name used in a way the script cannot see goes on its allow-list with the reason. The dashboard's style sheet is left to its own check (#681).

![The unused class names before, and none after](docs/screenshots/546-unused-css.png)
