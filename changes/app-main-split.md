---
bump: none
issues: 541
audience: developers
---
### The desktop app's main.rs is split into modules

`apps/studio/src-tauri/src/main.rs` was 3,045 lines. It is now 370 lines that hold the shell's state, setup, the plugins and the command list (#541). The rest moved as it was:

- `table.rs`: opening, starting, stopping and updating a table.
- `screens.rs`: the shell's windows, displays, placing views, presenting and full screen.
- `startup.rs`: logging and what opens first.
- `commands/`: the Tauri commands, grouped as `launcher`, `settings`, `files`, `calibration` and `update_commands`.

Nothing behaves differently. The app's tests and clippy pass, and `build.rs` and `main.rs` still agree on every command.

![main.rs and its modules](docs/screenshots/541-main-split.png)
