---
bump: minor
issues: 303
---

### Opening a layer quiets the map at rest

When a layer is opened from the controller, the life on the map at rest steps aside: traffic, street life, public transport, building lights and trees pause, and the base map stays underneath for context. Close the layer and everything at rest comes back, as Street Life did in the Chalmers demo. The slideshow and picture layers still hide the base map too. Sketch and other tools kept alongside don't count as an open layer.

![Wind open over the base map, with traffic, transit and trees paused](docs/screenshots/303-wind-open.png)
