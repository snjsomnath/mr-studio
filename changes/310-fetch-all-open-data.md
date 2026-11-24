---
bump: minor
issues: 310
---
### Fetch everything from open data in one go

A new table's **Your place** step starts with **Fetch everything from open data**: buildings, streets, walking paths and trees from OpenStreetMap and the ground from free elevation, ticked and fetched together. OpenStreetMap is asked once for all of them, which is quicker and kinder to its shared servers than one request per dataset. One list shows how each one is doing, the editor reloads once at the end, and anything that failed has its own **Try again**. Datasets already on the table start unticked, so nothing is replaced unless you ask.

![Fetching everything: one line per dataset](docs/screenshots/310-fetch-all-fetching.png)
![Done: four in from OpenStreetMap, the ground left to try again](docs/screenshots/310-fetch-all-done.png)
