# Chalmers campus Johanneberg

The flagship site: the 1250 × 750 m around the Chalmers Johanneberg campus that the ACE MR Studio table shows at 1:1250.
Its data comes from `Nodal-Works/interactive_map` (branch `main`), copied by `tools/import.py`.

```bash
cargo run -p mrs-cli -- validate sites/chalmers
pnpm dev -- --site sites/chalmers
```

## Geometry

The table area is a rectangle on the Swedish national grid, SWEREF99 TM (EPSG:3006): east 319 470 to 320 220, north 6 397 410 to 6 398 660.
Everything in `site.json` follows from that rectangle.

| Value | Where it comes from |
| --- | --- |
| `origin` | The rectangle's centre, converted to WGS84 |
| `extent` 1250 × 750 m | The rectangle. The table's long side runs south to north |
| `rotation_deg` -92.555 | The table's "up" edge faces grid west. Grid north is 2.555° west of true north here, so west on the grid is a bearing of 270 - 2.555 |
| `mesh.anchor` | The rectangle's south-west corner, where the mesh has its origin |
| `mesh.unit_m` 1250 | The mesh is in table metres (1.0 × 0.6 units), and the table is 1:1250 |
| `mesh.bearing_deg` -2.555 | The mesh's Y axis is grid north |

The four corners this gives are the ones in the old app's `APP_CONFIG.area.corners`, to within a millimetre.

## Data

| File | What | From `interactive_map` | Original source |
| --- | --- | --- | --- |
| `data/mesh.stl` | Ground and buildings as one surface. This is where building heights come from | `media/mesh.stl` | Not recorded upstream; the old sun study uses it |
| `data/terrain.tif` | Ground elevation, 2 m cells, SWEREF99 TM | `media/clipped_dem.geotiff.tif` | Not recorded upstream |
| `data/buildings.geojson` | 788 footprints without heights, drawn on the table as context | `media/building-footprints.geojson` | Lantmäteriet |
| `data/trees.geojson` | 8120 trees with species and height | `media/trees.geojson` | Primärkartan, Park och Naturförvaltningen, City of Gothenburg |

The mesh and the terrain agree on the ground to a few centimetres (median), so the bake separates buildings from ground by comparing them.

## Calibration

`calibration.json` is the projector view from the old app's `map-calibration.json`, unchanged.
The projector overshoots the table (the image is 111.93 × 62.96 cm on a 100 × 60 cm table), which is why its zoom shows more than the extent.
`window` (2560 × 1440) is the window size that zoom belongs to. The old app did not record it; it follows from the zoom and the image size, and matches the old `table-aligned-2560x1440` wallpaper.
