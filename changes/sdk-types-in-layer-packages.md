---
bump: minor
issues: 508
---
### A team's own layer gets the SDK's types

A layer written in a team's own repository had nothing to check it against: the editor said "Cannot find module '@mrstudio/sdk'", there was no completion, and a mistyped `ctx` call showed up only on the table (#508).

`mrstudio layer new` and `mrstudio layer build` now write the SDK's types into the package (`types/mrstudio-sdk.d.ts`), brought up to the installed app on every build. The editor completes and checks what you write, and `npm run typecheck` checks a layer without building it. Nothing is installed from npm for it.

![A mistake in a layer, caught outside the MR Studio repository](docs/screenshots/508-sdk-types-outside.png)
