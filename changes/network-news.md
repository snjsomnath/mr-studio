---
bump: minor
issues: 338
---
### Networks announce changes, and cars arrive on schedule

A network of flows can now announce a change at a step of its series (#338). With **Announce changes** on in the layer builder, a `note` column in the series dims the table round the row's point for a few seconds. The words, such as "The car chargers open", go to a **What changed** panel on the controller and never onto the table.

An `arrivals` column sends that many movers along the streets to a point during its step, like cars coming to a charger. The builder's Energy network test data now has a charger with both.

![The charger spotlighted at 08:00, cars driving to it at 18:00, and the controller's What changed panel](docs/screenshots/338-network-news.png)
