---
bump: patch
issues: 507
---
### One failed request no longer stops the table

If the host tripped over one request while it held the table's state, every request after it failed too, and the table stayed dead until the nightly restart or a person (#507). Now such a failure costs that request only: the screen that asked is told, the operator log gets a line, and the table answers the next request as before.

The watchdog has one more step for an unattended table. When a window still does not answer after it was reloaded and the windows were opened again, the table itself is started again.

![The diagnostics report with the incident, from a table that kept answering](docs/screenshots/507-fault-contained.png)
