---
bump: patch
issues: 622, 637
---

### Custom layers show their legend, one heading per colour scale

A custom layer written by hand, by the MCP or from the command line had no legend on the
controller, because only the editor saved one. The table now works the legend out from the
layer's looks, rasters included, whenever the layer has none of its own. When a layer has more
than one colour scale, such as Dig's soil depth and rock surface, each scale gets its own
heading. A look's `legend` prop names its heading.

![Two raster scales and a soil scale, each under its heading](docs/screenshots/622-legend-groups.png)

An X-ray glass or a Reveal line has no legend of its own, so it now shows its items' legends,
each under the item's name: the surface stack and the stack underneath.

![A Reveal line's two stacks, each with its legend](docs/screenshots/637-reveal-line-legend.png)
