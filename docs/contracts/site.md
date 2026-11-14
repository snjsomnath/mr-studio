# Site package contract

A site is a folder. It is never a branch and never a fork of the app.

```
sites/<id>/
  site.json          the manifest below
  data/              source data: GeoJSON in WGS84, rasters, media
  scene/             baked rasters written by `mrstudio prepare`, for inspection (generated, git-ignored)
  layers/            site-only layer packages (optional)
  calibration.json   table calibration, written by the app (optional)
```

## site.json

```jsonc
{
  "format": 1,
  "id": "sample",
  "name": "Sample district",
  "origin": { "lon": 11.9778, "lat": 57.6884 },   // centre of the table area, WGS84
  "extent": {
    "width_m": 1000,        // size of the area shown on the table
    "height_m": 600,
    "rotation_deg": 0       // bearing of the table's "up" edge, clockwise from north
  },
  "timezone": "Europe/Stockholm",
  "table": { "width_cm": 100, "height_cm": 60, "tile_cm": 20 },
  "scene": {
    "cell_m": 2,
    "buildings": { "path": "data/buildings.geojson", "height_property": "height", "default_height_m": 12 },
    "terrain":   { "path": "data/terrain.f32", "width": 100, "height": 60 },   // optional, flat if absent
    "trees":     { "path": "data/trees.geojson", "height_property": "height", "crown_radius_m": 3 }  // optional, points
  },
  "data": {                                        // optional, named datasets for layers
    "roads": "data/roads.geojson",
    "transit": "data/transit.geojson"
  },
  "basemap": { "background": "#0b0e14", "style": null },
  "data": {                                           // named datasets for layers (optional)
    "walkways": "data/walkways.geojson",
    "trips": "data/trips.json"
  },
  "layers": [                                      // the scene, bottom first
    { "use": "basemap", "active": true },
    { "use": "sunlight", "active": true, "params": { "hour": 15 } },
    { "use": "cars", "active": true },
    { "use": "cars", "id": "rush-hour", "params": { "density": 30 } },
    { "use": "./layers/artwork" }
  ],
  "tv": { "layout": "default" },
  "branding": { "title": "MR Studio", "logo": null }
}
```

Rules:

- `format` is the contract version. The app refuses a newer major format and migrates older ones.
- `extent` is the table area: a `width_m` by `height_m` rectangle centred on `origin`, rotated by `rotation_deg`. Its aspect ratio should match the table's.
- The scene grid covers exactly the extent with `cell_m` cells, so `width = round(width_m / cell_m)`.
- Paths are relative to the site folder and may not leave it.
- `layers[].use` is a core layer id, or a relative path to a site-only layer package. `params` override the layer's defaults and `active` turns it on at start.
- `layers[].id` names an entry: lowercase letters, digits and dashes. It defaults to the layer's id, so it is only needed when the same layer is listed more than once. All of an entry's state in the session is keyed by it.
- `data` maps a dataset name to a file in the site. Layers ask for datasets by name (`requires.data` in `layer.json`), never by path. The scene's `buildings` and `trees` are always available under those names. Names the core layers read: `roads` (LineStrings; optional `width` in metres and `kind`), `transit` (see `packages/layers/transit/README.md`), `slideshow` (see `packages/layers/slideshow/README.md`).
- `terrain` is raw little-endian f32 elevations covering the extent, row-major with row 0 at the top, at any resolution.
- `tv` holds the TV's settings: where the control rail sits, the site's theme, and optional hand-made dashboard pages. Its shape and rules are in [dashboard.md](dashboard.md). The host passes it to surfaces as written.
- Unknown keys are an error, so a typo is caught by `mrstudio validate` rather than silently ignored.
- Vector data is GeoJSON in WGS84 (CRS84). Site prep reprojects from national grids.
- Nothing in `site.json` is a secret. Credentials for services live in the app's own config.

## Composing a scene

A table scene is the ordered `layers` list and nothing else: the first entry is drawn at the bottom, the last on top.
Everything a person sees on the table, from the dark base map to moving cars, building lights, public transport, trees and analysis layers such as sunlight or isovist, is a layer package added to that list with its params.
This is what the composer at `/compose` edits. It reads each layer's `layer.json` to offer it in a palette and to generate its settings form, and the host writes `site.json` after every change, so a scene made by drag and drop and one written by hand are the same file.
The host replaces only the `layers` list and leaves every other key as written. The file is reformatted (two-space indent) the first time it is saved.

What the composer needs, and where it stands:

| Need | Status |
| --- | --- |
| Ordered list of layers with params and initial on/off | In format 1 |
| Layers self-describe their controls, tools and data needs | In `layer.json` (`controls`, `tools`, `requires`) |
| A site says which of its files a layer should use | In format 1: `data` |
| A blank starting point | `mrstudio new-site`, and `sites/sample` as the dummy scene |
| The same layer twice with different settings | Done: an optional `id` per entry; state is keyed by that id instead of the layer id |
| Palette grouping | Done: `category` in `layer.json` (`base`, `ambient`, `analysis`, `media`) |
| Add, remove and reorder while running | Done: `scene.add`, `scene.remove`, `scene.move` and `scene.set` requests (session.md); the host rewrites `site.json` |
| Draw order follows the list | Done: everything a layer draws sits at its place in the list |
| TV dashboards built from widgets | Done: `tv` (theme, pages) and layer `panels`; see [dashboard.md](dashboard.md) |

Ambient layers (`cars`, `building-lights`, `transit`, `trees`) animate on the table surface from site data or generated paths. They need no kernel; the layer rule "no solver code" still holds.
`basemap` is the dark base map and `slideshow` shows a site's media. `sites/sample` has the data for all of them and is the dummy scene to start from.
A layer whose data a site lacks still runs where it can: traffic and transit fall back to a generated street grid, and the palette says which data is missing.

## Baking the scene

The host turns the sources into the rasters the engine loads, in memory at startup:

1. `dtm`: the terrain raster resampled to the grid, or 0 everywhere.
2. `dsm`: `dtm` plus each building polygon filled with a flat roof at its height above the lowest ground it covers. Courtyards (polygon holes) stay open.
3. `canopy`: each tree as a disc of `crown_radius_m` with the tree's height.

Baking a 1000 × 600 grid takes well under a second. `mrstudio validate <site>` checks the manifest and reports what the bake produced; `mrstudio prepare <site>` also writes the rasters to `scene/` so they can be inspected.

Planned source types, all producing the same rasters: 3D meshes (STL, GLB) rasterised to the `dsm`, and GeoTIFF terrain. When a bake becomes slow, `scene/` becomes a cache.

## Calibration

`calibration.json` maps the site to a physical table and is written by the app's calibration tool, never by hand:

```jsonc
{ "table": { "center": { "lon": 11.9778, "lat": 57.6884 }, "zoom": 16.2, "bearing": 0 } }
```

Without it, the table surface fits `extent` to the window.
