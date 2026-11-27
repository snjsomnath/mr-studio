---
bump: patch
issues: 536
---
### A slow disk no longer holds up the controller while the editor saves

Until now every change the editor saved held up every other screen until `site.json` was written, read back for the history and its revision file written. On a busy disk, such as a table folder on OneDrive or a network drive, a slider dragged in the editor made the controller and the phones wait (#536).

Now the host takes the change at once, checks that `site.json` would still load with it, and writes it after it lets go of the table's state. Saves still happen in the order the changes were made, and the editor hears "saved" only once its change is on disk. Layer settings, controller settings, display quality and the palette save this way. Rarer changes that need what was written first (custom layers, removing a dataset, the table's own settings) save as before.

![A controller press answered at once while two slow saves wait their turn](docs/screenshots/536-slow-saves.png)
