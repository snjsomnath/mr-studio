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
  "format": 2,
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
    "terrain":   { "path": "data/terrain.f32", "width": 100, "height": 60 },   // optional, flat if absent; or a GeoTIFF
    "mesh":      { "path": "data/mesh.stl", "anchor": { "lon": 11.972, "lat": 57.6826 }, "unit_m": 1 },   // optional
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

- `format` is the contract version, a whole number. A site with an older format is upgraded when it is opened: the app and `mrstudio migrate` rewrite `site.json` and keep the original as `site.format-<n>.json`; anything else that reads a site (`Site::load`) upgrades it in memory. A site with a newer format than the app knows is refused with a message that says to update the app. Every format change adds one step to `mrs-site`'s `migrate` module, which is the only place that knows about older formats.
  - Format 2: the base map is a layer. Format 1 drew ground, streets and footprints under every layer by itself; the upgrade puts `{ "use": "basemap", "active": true }` first in `layers` unless the site already lists it.
- `extent` is the table area: a `width_m` by `height_m` rectangle centred on `origin`, rotated by `rotation_deg`. Its aspect ratio should match the table's.
- The scene grid covers exactly the extent with `cell_m` cells, so `width = round(width_m / cell_m)`.
- Paths are relative to the site folder and may not leave it.
- `layers[].use` is a core layer id, or a relative path to a site-only layer package. `params` override the layer's defaults and `active` turns it on at start.
- `layers[].button` is how the layer is offered on the controller: `{ "name", "description", "icon", "side" }`, all optional. `name` (up to 40 characters) and `description` (up to 200) replace the layer package's own words, `icon` is an icon name in lowercase letters, digits and dashes, and `side` is `"left"` or `"right"`. The map never shows these; they are for the controller and phones.
- `layers[].id` names an entry: lowercase letters, digits and dashes. It defaults to the layer's id, so it is only needed when the same layer is listed more than once. All of an entry's state in the session is keyed by it.
- `data` maps a dataset name to a file in the site. Layers ask for datasets by name (`requires.data` in `layer.json`), never by path. The scene's `buildings` and `trees` are always available under those names. Names the core layers read: `roads` (LineStrings; optional `width` in metres and `kind`), `transit` (see `packages/layers/transit/README.md`), `slideshow` (see `packages/layers/slideshow/README.md`).
- `terrain` is one of two things, told apart by the file extension:
  - Raw little-endian f32 elevations covering the extent, row-major with row 0 at the top, at any resolution. Needs `width` and `height`.
  - A GeoTIFF (`.tif`, `.tiff`): `{ "path": "data/terrain.tif" }`. It is placed by its own georeference, so it may be larger than the extent and on a national grid. Add `"crs": "EPSG:3006"` when the file does not name its coordinate system. See [Terrain from a GeoTIFF](#terrain-from-a-geotiff).
- `mesh` is a 3D model of the top surface, for sites whose footprints have no heights. See [Buildings from a mesh](#buildings-from-a-mesh).
- `buildings.extrude` (default `true`) says whether the footprints are raised into the scene. Set it to `false` when a mesh gives the buildings their shape; the footprints are then only drawn on the table.
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
2. `dsm`: `dtm`, raised by the mesh where it stands clear of the ground, then by each extruded building polygon, filled with a flat roof at its height above the lowest ground it covers. Courtyards (polygon holes) stay open.
3. `canopy`: each tree as a disc of `crown_radius_m` with the tree's height.

Baking a 1000 × 600 grid takes well under a second, and the Chalmers campus (1250 × 750 cells from a GeoTIFF and a 79 000 triangle mesh) about a second. `mrstudio validate <site>` checks the manifest and reports what the bake produced; `mrstudio prepare <site>` also writes the rasters to `scene/` so they can be inspected.

Planned: GLB meshes. When a bake becomes slow, `scene/` becomes a cache.

### Terrain from a GeoTIFF

The first band is read as elevation in metres. The file must be north-up (`ModelPixelScale` and `ModelTiepoint` tags, which is what GDAL and QGIS write), uncompressed or compressed with LZW or Deflate. Supported coordinate systems: WGS84 and ETRS89 degrees (EPSG:4326, 4258), UTM (EPSG:326xx, 327xx, 258xx), SWEREF99 TM (EPSG:3006) and the SWEREF99 local zones (EPSG:3007 to 3018). Each grid cell samples the raster bilinearly at its own position, so the raster needs no clipping or rotating first. Cells the raster does not cover, or where it has no data, take its lowest elevation, and `mrstudio validate` reports how many there are.

### Buildings from a mesh

```jsonc
"mesh": {
  "path": "data/mesh.stl",                        // STL, binary or ASCII, Z up
  "anchor": { "lon": 11.971958, "lat": 57.682628 }, // where the mesh's own origin (0, 0) is
  "unit_m": 1250,                                 // metres per mesh unit, default 1
  "bearing_deg": -2.555,                          // compass bearing of the mesh's +Y axis, default 0 (Y north, X east)
  "base_m": 0,                                    // elevation of the mesh's z = 0, default 0
  "ground_tolerance_m": 1                         // default 1
}
```

A mesh has no georeference of its own, so these five numbers place it: a point, a scale, a turn and a height. `bearing_deg` is what makes a model drawn on a national grid line up, because grid north is not true north (2.6 degrees off at Chalmers).

The mesh is rasterised from above and the highest surface in each cell wins, so undersides and base plates do not matter. A mesh of ground and buildings together needs a `terrain` in the same height datum: that is how the bake tells a roof from a hillside. Where the mesh is less than `ground_tolerance_m` above the terrain the cell stays ground, since two models of the same ground never agree to the centimetre.

## Calibration

`calibration.json` maps the site to a physical table and is written by the app's calibration tool, never by hand:

```jsonc
{
  "table": {
    "center": { "lon": 11.9778, "lat": 57.6884 },
    "zoom": 16.2,          // web map zoom (512 px tiles) at the window size below
    "bearing": 0,          // compass bearing of the window's "up"
    "window": { "width_px": 2560, "height_px": 1440 }   // optional: the window the zoom was found at
  }
}
```

The table surface (`/table`) shows exactly this view, which may be larger than `extent` when the projector overshoots the table. With `window`, the zoom is rescaled when the window has another width, so the same ground stays in view. Without a calibration, and always in dev mode, the surface fits `extent` to the window.
