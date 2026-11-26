---
bump: minor
issues: 600, 601, 602, 606
---
### Geology on the table: GIS files, Dig, well logs and two-stack X-rays

Building blocks for an underground layer, made in the editor without code (#599). All pictures here use made-up sample data.

**Zipped shapefiles and GeoPackages** (#600). Add data reads a zip of shapefiles (with their `.prj`, `.dbf` and `.cpg`) or a GeoPackage, lists its layers with how many shapes of each lie on the table, and takes the one you choose. Files in SWEREF99 TM, its local zones, UTM or WGS84 are placed on their own.

![Add data lists the layers of a GeoPackage](docs/screenshots/600-import-layers.png)

**Rasters of values, with Dig** (#601). A GeoTIFF such as soil depth or rock surface height comes in as data, and a custom layer colours it by value with the palette's ramps. Hide what is below a value, give the cut a glow, and let visitors move it: the Dig slider peels the ground away and the layers under it show through. A GeoTIFF that does not name its coordinate system is placed the way terrain already was.

![Dig: the raster cut at 55 m with a glowing edge](docs/screenshots/601-dig.png)

![The raster look in the layer builder](docs/screenshots/601-raster-look.png)

**A well's log on the controller** (#602). Tap a well or a borehole and the controller draws its layers from the top down, coloured by material (fill, clay, sand, rock…, Swedish or English), with depths and remarks. The log comes from another dataset, matched by a shared column, chosen under Interaction. A layer's own sliders now come before a tap-to-read card, so Dig stays in view.

![A well's log beside its facts, under the Dig slider](docs/screenshots/602-well-log.png)

![Choosing the log under Interaction](docs/screenshots/602-log-builder.png)

**Two stacks in an X-ray glass and a Reveal line** (#606). Layers inside a glass or a reveal line go in Stack 1, the surface, shown around the glass or on the far side of the line, or Stack 2, underneath, shown through it. Each stack holds any number of styled layers.

![X-ray: the surface around the glass, what is underneath inside it](docs/screenshots/606-xray-stacks.png)

![Reveal line: the surface on one side, underneath on the other](docs/screenshots/606-line-stacks.png)

![The glass's stacks in the editor](docs/screenshots/606-editor-stacks.png)
