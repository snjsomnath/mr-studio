---
bump: minor
issues: 68
---
### The editor says what it is doing, and when it lost the table

If the table stops answering, the editor says "Lost connection to the table. Reconnecting…", greys out what cannot be changed until it is back, and comes back by itself where you were. "Saved" waits for the table to confirm and shows "Saving…" until it has. While a simulation settles or shadows are worked out, the status bar shows the engine at work, with a progress bar, and it names the engine plainly ("CPU, slower" when there is no graphics card). A layer button in the ribbon stays busy until its layer is in, so a second click does not add a second one.

![Lost connection: the banner and the greyed-out panels](docs/screenshots/68-offline.png)
![The engine at work in the status bar](docs/screenshots/68-status.png)
