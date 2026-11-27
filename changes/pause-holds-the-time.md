---
bump: patch
issues: 403
---
### Pause stops the time at once

On a slow table, the time on the controller kept running for seconds after Pause, and a time picked right after could be lost. Now Pause stops the time on every screen at once, at the time shown when it was pressed, and the table follows that time.

![The controller's clock after Pause, before and after](docs/screenshots/403-pause-holds.png)
