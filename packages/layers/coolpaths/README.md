# Cool paths

Two walks between the same two points: the shortest one, and the one with the least time in direct sun
that is no more than a set share longer. The table colours every path by how sunny it is at the chosen
date and time, draws both routes, and sends two walkers off together so the cost of the detour is visible.

This is the generic form of the CoolPaths study that ran on the Lindholmen table. The route search is the
same (a length-bounded least-exposure search, `src/network.ts`). What changed:

| Lindholmen | Here |
| --- | --- |
| A study prepared offline for one site and one date (Earth Engine, weather, a Python service) | Nothing prepared: shade comes live from the engine's `sunlight` kernel for the site's own scene, at any date and time |
| Heat exposure: path PET (°C) times metres | Sun exposure: metres walked in direct sun |
| The Lindholmen walking graph, bundled with the study | Any site's `walkways` dataset |

## What a site provides

```jsonc
// site.json
"data": { "walkways": "data/walkways.geojson" },
"layers": [{ "use": "coolpaths" }]
```

`walkways` is GeoJSON in WGS84 with `LineString` or `MultiLineString` features: footpaths, pavements,
streets people walk along. Lines connect where they share a vertex, which is how OpenStreetMap ways are
drawn, so an OSM extract of walkable ways works as it is. Properties are ignored.

## Inputs

- Controls: date, time of day, animate the day, longest detour, another example walk, and what to draw.
- On the table (or the editor's live table): click or tap to set the start (A), click again to set the end (B),
  and so on in turn. Press on A or B and drag to move it; the routes follow. The pick goes through the host
  with `ctx.sendTool`, so every view of the table (projector window, editor) shows the same walk.
- Tools: `from` and `to` points set the ends of the walk from a phone. A point snaps to the nearest path within 120 m.
  Until an input sets them, the layer picks an example walk that shows a clear difference.

## Next step: thermal comfort

Sun exposure is the largest part of outdoor heat stress on a clear day, but it is not PET.
The proposal is a `comfort` engine kernel (not built) that outputs mean radiant temperature and PET per cell from the scene
(shadow, sky view, canopy) plus weather params (air temperature, humidity, wind, irradiance), with a CPU
reference ported from `coolpaths/thermal.py` on the lindholmen branch. This layer would then read that
field instead of `shadow`, and its numbers would become °C·m as in the original study. Nothing else in
the layer changes: exposure per edge is already "sample a field along the path".
