# Bring in your own data and make a layer

*Show your own maps, points and areas without writing code: import the data, then style it in the layer builder.*

1. On the **Insert** tab, choose **Data file** (the **Add data** window). Drop a file (GeoJSON, a zip of shapefiles, a GeoPackage, CSV with coordinates, GeoTIFF, a picture, an SVG plan) or pick one from your Sources.
2. MR Studio places it on the table and suggests what it is. A CSV without positions is kept as a table, for place motions.
3. To make it a layer, choose **New layer** under **Make your own**. The builder has four parts: **Data**, **Look** (points, lines, zones, colours by a column), **Motion** (glow, pulses, particles, flows along streets) and **Interaction**.
4. No data yet? In the New custom layer window, under **Or try it with test data**, choose **Random points**, **Random places**, **Random lines** or **Random areas**. They are made up on the spot inside the table, with columns to colour and size by, and become datasets of the table (`test-points` and so on) that you can remove later. **Random places** come with a day of activity, flows and links, and start with a place motion, so you can switch through every place motion, cultural gravity included, straight away.
5. Colours come from the table's **Palette**, so a layer keeps matching the rest. Change the palette and every custom layer follows.
6. Save it. The custom layer is stored in the table and appears in **Insert › New layer** like any other.

![The layer builder](docs/screenshots/161-builder.png)

## What a good file looks like

Every row of Your place and Add data has a **?**. It shows what the file should hold, with a short example, and **Download an example**: a small file of that kind around your own table, to open and look at, or bring straight back in to see it on the table. The same words are below, and the MCP server has them as `mrstudio://data-formats`.

![The ? on Buildings, with Download an example](docs/screenshots/36-download-example.png)

### Buildings (GeoJSON)

GeoJSON polygons, one per building, with a height in metres (height, höjd) or a number of storeys (building:levels, våningar). WGS84 or SWEREF99 are both fine.

```
{ "type": "Feature",
  "properties": { "height": 18 },
  "geometry": { "type": "Polygon", "coordinates": [[[11.970, 57.690], …]] } }
```

### Ground (GeoTIFF)

A GeoTIFF of ground heights in metres, such as a Lantmäteriet elevation model. It may be larger than the table and on a national grid; if it does not say which, you will be asked for its EPSG code (3006 for SWEREF99 TM). If the file is a surface model with the buildings in it, Add data notices the raised footprints and offers **Take the buildings out of the ground**, which keeps only the ground under them.

### Trees (GeoJSON or CSV)

GeoJSON points, or a CSV with a row per tree: lat and lon (or x and y, or latitud and longitud), and a height if you have one.

```
lat;lon;höjd
57,7001;11,9701;9,5
```

### Water (GeoJSON or GeoTIFF)

GeoJSON areas where there is water: a river, a lake, a harbour, the sea. Thermal comfort counts it as cool, stormwater lets the rain run into it, and the base map draws it. A GeoTIFF mask works too (water cells 1, land 0) in site.json under scene.water.

```
{ "type": "Feature",
  "properties": { "natural": "water" },
  "geometry": { "type": "Polygon", "coordinates": [[[11.970, 57.690], [11.975, 57.690], [11.975, 57.688], [11.970, 57.690]]] } }
```

OpenStreetMap can fill it too: Add data, Water, From OpenStreetMap takes the rivers, lakes and basins mapped as areas.

### Buildings around (GeoJSON)

GeoJSON footprints around the table, reaching up to 500 m past its edge (scene.context.reach_m in site.json sets how far). The wind simulation puts them around the table, so wind arriving at the table has passed real buildings. Nothing is drawn. Footprints on the table itself are left to Buildings.

```
{ "type": "Feature",
  "properties": {},
  "geometry": { "type": "Polygon", "coordinates": [[[11.955, 57.700], [11.956, 57.700], [11.956, 57.7005], [11.955, 57.7005], [11.955, 57.700]]] } }
```

### 3D model (STL, OBJ or GLB)

A model of the ground and buildings, so shadows and wind follow its real heights. Media, 3D model, Choose a file shows it from above against the table and the footprints to scale, turn and move it, or **Snap to buildings**. A model exported in map coordinates (SWEREF 99 TM, a SWEREF 99 local zone or UTM metres) needs none of that: it is placed where it belongs as it comes in.

### Streets (GeoJSON)

GeoJSON lines along the middle of each street. An optional width in metres and a kind (street, primary…) help traffic look right.

```
{ "type": "Feature",
  "properties": { "width": 8 },
  "geometry": { "type": "LineString", "coordinates": [[11.970, 57.690], [11.972, 57.691]] } }
```

### Walking paths (GeoJSON)

GeoJSON lines along footpaths, pavements and squares people cross. Cool paths finds the shadiest way along them.

### GIS files (zipped shapefiles or a GeoPackage)

A zip of shapefiles, each with its `.shp`, `.dbf`, `.prj` and, if there is one, `.cpg`; or a GeoPackage (`.gpkg`). Add data lists the layers in the file with how many shapes of each lie on the table, and takes the one you choose; add the file again for another layer. Files in SWEREF99 TM, its local zones, UTM or WGS84 are placed on their own.

![Add data lists the layers of a GeoPackage](docs/screenshots/600-import-layers.png)

### Rasters of values (GeoTIFF)

A GeoTIFF that holds a value in each cell rather than ground heights: soil depth, the height of the rock surface, noise. It comes in as data. In a custom layer, its look is **Raster**: coloured by value with the palette's ramps (the **Dig away** style is a good start). **Hide what is below** cuts away what is under a value and **Edge glow** lights the cut. Give visitors the **Dig** slider on the controller and they peel the ground away, so the layers under it show through. A GeoTIFF that does not say where it is gets placed the way ground heights are.

![Dig: the raster cut at 55 m with a glowing edge](docs/screenshots/601-dig.png)

### Well and borehole logs (CSV or GIS file)

Points for the wells, and a second dataset with a row per layer of each well: which well, from what depth, to what depth, the material, and a remark if any. In the custom layer of the wells, under **Interaction**, tick **A tap on one shows it on the controller**, then under **A log of layers under each one** choose the log's dataset and its columns. A tap on a well then draws its layers on the controller from the top down, coloured by material (fill, clay, sand, rock, in Swedish or English), with the depths.

![A well's log on the controller, under the Dig slider](docs/screenshots/602-well-log.png)

### Trips (trips.json)

The Mobility layer's trips.json: journeys in groups to compare (on foot, by tram…), each a list of legs with a start and a duration in seconds and the [lon, lat] points it passes. See packages/layers/mobility/README.md.

```
{ "format": 1,
  "groups": [{ "id": "walk", "label": "On foot" }],
  "trips": [{ "group": "walk", "legs": [
    { "start": 0, "duration": 120, "coordinates": [[11.970, 57.690], [11.972, 57.691]] } ] }] }
```
