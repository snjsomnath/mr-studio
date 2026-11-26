---
bump: none
issues: 517
---
### The architecture page and contracts match what is built

`docs/ARCHITECTURE.md` no longer promises signed installers, channels or a `services/` folder; the contracts describe `field.remove` and `field.clear` and where the front edge and ribbons are edited. The docs check now fails when the host answers a request no contract describes, or when the architecture page lists a folder that is not there.
