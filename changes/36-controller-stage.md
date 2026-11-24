---
bump: minor
issues: 283
---
### A layer's own map app on the controller
A layer can now put its own app in the middle of the controller, such as a map of the site to choose on. What visitors do there reaches the table: a tap can draw a route, and a button can start an animation. The SDK gives layers a ready map of the site, upright as the table stands, with its streets and buildings, and it can find the shortest way along the streets. `samples/controller-map-example` has a route planner: tap a start and an end on the controller, the route lights up on the table, and **Send a traveller** sends a light along it.

![The route planner on the controller: a map of the site with a route along the streets](docs/screenshots/283-controller.png)
![The route on the table, with a traveller on its way](docs/screenshots/283-table.png)
