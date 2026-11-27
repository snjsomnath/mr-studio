---
bump: none
issues: 544
audience: developers
---
### The app's own pages are type-checked, down to the command names

Home, Settings, the operator window and the scripts the shell puts into windows are now checked by `pnpm typecheck` as JavaScript. The commands they call are a type written from the list in `apps/studio/src-tauri/build.rs` (`apps/studio/ui/app-commands.d.ts`), so a misspelt or removed command is a type error instead of a button that does nothing; the check also fails when `build.rs` and `main.rs` list different commands. `docs/core-developers.md` lists every file that is written from another and how to rewrite it.

![A misspelt command caught by the type check](docs/screenshots/544-app-commands.png)
