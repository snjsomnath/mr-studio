---
bump: patch
issues: 551, 552, 553
---
### Slides that show a layer keep the map and its controls

Three gaps found while building the Chalmers feature showcase:

- A slide that shows a layer of the table, such as a Magnifier X-ray, Sunlight or a custom layer, keeps the base map under it (#551). It used to draw on black. Pictures, videos and web maps still fill the table on their own.
- The controller shows that layer's own controls during its slide (#552), as when it is opened from its button: the Magnifier's navigator, Sunlight's sky and time slider, and a custom layer's settings.
- The Magnifier no longer fills the log with "negative radius" errors once its slide ends (#553).

![Before and after: the X-ray slide on black and over the map, and the controller with the glass's navigator](docs/screenshots/551-slide-scene-layers.png)
