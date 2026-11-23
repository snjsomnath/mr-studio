# Cool paths

Two walks between the same two points: the shortest one, and the one with the least heat exposure that is no
more than a set share longer. Heat exposure is the measure of the CoolPaths study behind the Chalmers demo's
"Outdoor Thermal Comfort" button: the path's PET (Physiological Equivalent Temperature, °C) times the metres
walked, °C·m. The table colours every path and the ground by PET at the chosen date and time, draws both routes,
and sends two walkers off together so the cost of the detour is visible. The controller compares the walks as the
demo does: distance, mean PET, heat exposure and PET along each walk.

| Chalmers demo (interactive_map `coolpaths/`) | Here |
| --- | --- |
| PET prepared offline for one date, 08:00 to 20:00 (Earth Engine, NASA POWER, a Python service) | The same rasters, read from the site (`pet` dataset) when it has them; otherwise PET worked out live from the `sunlight` kernel's shade, at any date and time |
| The demo's own walking graph | Any site's `walkways` dataset |
| Heat exposure: PET × metres, 50% longest detour | The same, with the detour on a control |

## What a site provides

```jsonc
// site.json
"data": { "walkways": "data/walkways.geojson" },
"layers": [{ "use": "coolpaths" }]
```

`walkways` is GeoJSON in WGS84 with `LineString` or `MultiLineString` features: footpaths, pavements,
streets people walk along. Lines connect where they share a vertex, which is how OpenStreetMap ways are
drawn, so an OSM extract of walkable ways works as it is. Properties are ignored.

Optional: `pet`, the demo's prepared thermal comfort. Copy the study folder the demo's `python -m coolpaths.prepare`
writes (`coolpaths/data/2026-07-15/`, with `pet_08.tif` .. `pet_20.tif` in EPSG:3006) into the site and name it:

```jsonc
"data": { "walkways": "data/walkways.geojson", "pet": "data/pet" }
```

Any GeoTIFF the host can read works (EPSG:4326, UTM, SWEREF99): a folder of one raster per hour (the file name ends in
the two-digit hour), or one file for every hour. UTCI in °C works the same way. The host lays the hour on the table grid
(`GET /api/data/field?name=pet&hour=14`, `loadSiteField` in the SDK). For hours the folder does not cover, and cells where
the raster has no data, the layer falls back to the live estimate.

## How PET is worked out without prepared data

`@mrstudio/sdk` has the demo's thermal model as a building block (`comfort.ts`):

1. Clear-sky sunlight for the sun's height (Ineichen with a Linke turbidity of 3, as pvlib).
2. A standing walker's mean radiant temperature in full sun and in full shade (the demo's `radiant_temperature`,
   with an assumed sky view of 0.85 in the open and 0.6 in shade).
3. PET from the MEMI model (a port of pythermalcomfort's `pet_steady`, which the demo calls; it agrees to 0.02 °C),
   for walking (2.3 met) in light summer clothes (0.9 clo).

The air temperature follows a clear summer day up to the "afternoon air temperature" control (8 °C cooler at dawn);
humidity and wind are controls too. Each place's PET is the sun and shade values mixed by its share of sun from the
`sunlight` kernel, which is exact where the sky view is the same. What it leaves out compared with the prepared study:
sky view per place, ground reflectivity per place (albedo 0.15) and the real weather of the day.

## Inputs

- Controls: date, time of day, animate the day, longest detour, another example walk, what to draw, and the weather
  for the live estimate (afternoon air temperature, humidity, wind).
- On the table (or the editor's live table): click or tap to set the start (A), click again to set the end (B),
  and so on in turn. Press on A or B and drag to move it; the routes follow. The pick goes through the host
  with `ctx.sendTool`, so every view of the table (projector window, editor) shows the same walk.
- Tools: `from` and `to` points set the ends of the walk from a phone. A point snaps to the nearest path within 120 m.
  Until an input sets them, the layer picks an example walk that shows a clear difference.
