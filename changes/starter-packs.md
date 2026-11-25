---
bump: minor
issues: 450
---
### Starter packs: draw a layer in QGIS, Illustrator, Photoshop or PowerPoint

**Insert, Starter pack…** (also **File, Export starter pack…**) makes a zip of the table's basics to draw on in another program: the table outline, tile grid, building footprints, street network, projection area and at-a-glance boxes. Tick what goes in and which programs it is for, see it on the right, then **Save…** or **Email…** it. QGIS gets GeoJSON and a picture that lands in place, Illustrator a layered SVG at the table's real size, Photoshop one PNG layer per feature and PowerPoint a slide the table's shape, with a README of steps for each and how to bring the result back. On the table canvas, a picture, a drawing or data made on it comes back exactly over the table. The command line (`mrstudio starter-pack`) and the MCP server (`export_starter_pack`) make the same pack.

![Choosing what goes in the pack](docs/screenshots/450-dialog.png)

![A pack's guides with the projection area and an at-a-glance box](docs/screenshots/450-pack-preview.png)
