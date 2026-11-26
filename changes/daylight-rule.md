---
bump: minor
issues: 498, 81
---
### Sunlight checks a daylight rule

Sunlight has a new **Daylight rule** mode that colours the ground outside buildings as pass or fail (#498, from #81). The controller and TV show how much of the open ground gets enough sun, and whether the area passes.

- **Sweden (Boverket)** is the default. At least half of the open ground needs 5 hours of sun between 9 and 17 at the spring equinox.
- **UK (BRE)** asks for 2 hours on 21 March over at least half the area.

Each rule sets its own day. The hours and the share can then be changed to match a municipality's own numbers. Tree shade counts, and the trees' own colour is turned off so it doesn't blur pass and fail.

![Chalmers under Boverket's rule (33%, fails) and the BRE result (82%, passes)](docs/screenshots/498-daylight-rule.png)
