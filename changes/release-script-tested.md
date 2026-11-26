---
bump: none
issues: 544
---
### The release script has tests, and the plain JavaScript is linted

`scripts/release.mjs` decides every version number and writes the notes every installed app shows. It now has tests that run in CI on a small repository of their own: no notes gives no version, the biggest bump decides, a picture that is not in the repository fails, the changelog is written in order, and a pull request without a note fails the check.

`pnpm lint` now also reads the app's own pages (Home, Displays and settings, Sources), the scripts the shell puts into windows and the build and release scripts, for names that do not exist or are never used. It found one: the end-to-end run called a `sleep` that was never defined, which failed the run whenever a save took a moment longer than usual.
