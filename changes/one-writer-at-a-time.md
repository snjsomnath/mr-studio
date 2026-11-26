---
bump: patch
issues: 515
---
### The app and the assistant no longer trip over each other's saves

The app and the MCP server both save `site.json`. A save by one could be read half-written by the other, which left a broken entry in the version history and a "site.json does not load" notice, and a change saved in between could be silently undone (#515).

Every save now replaces the file in one step. The app waits a moment before it believes a file that looks cut off, and the MCP server no longer writes over a change the app made since it read the table: it reads again and makes its change again. The calibration is saved the same way, so a power cut cannot leave half a file.
