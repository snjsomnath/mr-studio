---
bump: none
issues: 544
---
### The release script has tests

`scripts/release.mjs` decides every version number and writes the notes every installed app shows. It now has tests that run in CI on a small repository of their own: no notes gives no version, the biggest bump decides, a picture that is not in the repository fails, the changelog is written in order, and a pull request without a note fails the check.
