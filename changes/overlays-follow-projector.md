---
bump: patch
issues: 650
---
### Drawn layers line up with the model through the projector

Layers drawn on a 2D canvas (custom layers such as Campus growth and Under Chalmers, Isovist's highlight, the table grid) now go through the projector calibration, as the base map and buildings already did. Before, they stayed where the flat map would put them, about 10 px off the model.

![Before and after: a custom layer's footprints through a projector calibration](docs/screenshots/650-overlays-follow-projector.png)
