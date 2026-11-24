# Bring in your own data and make a layer

*Show your own maps, points and areas without writing code: import the data, then style it in the layer builder.*

1. On the **Edit** tab, choose **Add data**. Drop a file (GeoJSON, CSV with coordinates, GeoTIFF, a picture, an SVG plan) or pick one from your Sources.
2. MR Studio places it on the table and suggests what it is. A CSV without positions is kept as a table, for place motions.
3. To make it a layer, choose **New layer** under **Make your own**. The builder has four parts: **Data**, **Look** (points, lines, zones, colours by a column), **Motion** (glow, pulses, particles, flows along streets) and **Interaction**.
4. No data yet? In the New custom layer window, under **Or try it with test data**, choose **Random points**, **Random places**, **Random lines** or **Random areas**. They are made up on the spot inside the table, with columns to colour and size by, and become datasets of the table (`test-points` and so on) that you can remove later. **Random places** come with a day of activity, flows and links, and start with a place motion, so you can switch through every place motion, cultural gravity included, straight away.
5. Colours come from the table's **Palette**, so a layer keeps matching the rest. Change the palette and every custom layer follows.
6. Save it. The custom layer is stored in the table and appears under **Add a layer** like any other.

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

A GeoTIFF of ground heights in metres, such as a Lantmäteriet elevation model. It may be larger than the table and on a national grid; if it does not say which, you will be asked for its EPSG code (3006 for SWEREF99 TM).

### Trees (GeoJSON or CSV)

GeoJSON points, or a CSV with a row per tree: lat and lon (or x and y, or latitud and longitud), and a height if you have one.

```
lat;lon;höjd
57,7001;11,9701;9,5
```

### Streets (GeoJSON)

GeoJSON lines along the middle of each street. An optional width in metres and a kind (street, primary…) help traffic look right.

```
{ "type": "Feature",
  "properties": { "width": 8 },
  "geometry": { "type": "LineString", "coordinates": [[11.970, 57.690], [11.972, 57.691]] } }
```

### Walking paths (GeoJSON)

GeoJSON lines along footpaths, pavements and squares people cross. Cool paths finds the shadiest way along them.

### Trips (trips.json)

The Mobility layer's trips.json: journeys in groups to compare (on foot, by tram…), each a list of legs with a start and a duration in seconds and the [lon, lat] points it passes. See packages/layers/mobility/README.md.

```
{ "format": 1,
  "groups": [{ "id": "walk", "label": "On foot" }],
  "trips": [{ "group": "walk", "legs": [
    { "start": 0, "duration": 120, "coordinates": [[11.970, 57.690], [11.972, 57.691]] } ] }] }
```
