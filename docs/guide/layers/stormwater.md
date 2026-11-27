# Stormwater

## What it shows

A rain storm, live: water running off roofs and down slopes, gathering into streams and pooling in low spots as the storm goes on.

![Water gathering in the streets](docs/screenshots/189-stormwater-table.jpg)

## Good for

Where a cloudburst floods, how green ground and trees soak up rain, and where water needs somewhere to go.

## Set it up

1. The table needs its ground heights and buildings. In **Add data**, choose **Ground** and fetch free elevation data, or import your own terrain (GeoTIFF).
2. Add **Stormwater** from **Insert › New layer**.
3. Set the **Rain** in millimetres per hour. Around 40 is a heavy shower; above 100 is a cloudburst.
4. **Start the storm again** clears the water and begins from dry ground.
5. Under **Show**, choose running water, pools, or both.

## Asphalt, grass, soil, rain gardens and drains

Rain soaks into the ground at different speeds. Asphalt and concrete shed almost all of it, grass over sand soaks up a cloudburst, clay barely keeps up with a shower, a rain garden holds water in its dip and lets it soak away, and a drain takes it into the pipes. Stormwater reads this from the table's own data:

- **Roads and paths** (the `roads`, `streets` and `walkways` datasets): streets are asphalt, footways asphalt or paving, paths gravel, each laid at its width. Every table that has OpenStreetMap roads gets this without doing anything.
- **Land cover**: plazas, car parks, yards, lawns and woods. Lines cannot show these, and they matter most. For Swedish tables, take Naturvårdsverket's **Nationella marktäckedata** (NMD, open data): download the base layer (basskikt) GeoTIFF for the table's area from Naturvårdsverket's geodata download page, put it in the table's `data` folder and list it under `scene.surfaces` with `"classes": "nmd"`. OpenStreetMap land use (parks, grass, parking) works too, as `osm`.
- **Soil**: SGU's soil map, **Jordarter 1:25 000–1:100 000**, layer `grundlager` (the GeoPackage `jordarter25k_100k.gpkg` from SGU or SLU GET). Bring it in with **Add data** (pick the `grundlager` layer) and list it with `"classes": "soil"`. Its soil names are read as they are.
- **Rain gardens and drains** (#625): any points or areas whose `kind` says *rain garden* or *drain*, such as a field walk's spots saved as data, listed with `"classes": "kind"`. The city's or property owner's gully map works the same way.

```json
"scene": {
  "surfaces": [
    { "data": "roads" },
    { "path": "data/nmd.tif", "classes": "nmd" },
    { "data": "soil", "classes": "soil" },
    { "data": "drains", "classes": "kind" }
  ]
}
```

Finer data wins: a road drawn through a park is asphalt, a drain point in a road is a drain. Ground no source covers soaks up at **Unmapped ground soaks up**. Turn **Each surface soaks up its own way** off to compare with one rate for all open ground.

![Lindholmen, 30 mm/h for about two hours, with surfaces: the streets carry the runoff](docs/screenshots/624-surfaces-on.jpg)

![The same storm with one rate for all open ground](docs/screenshots/624-surfaces-off.jpg)

## Tips

- **Storm speed** runs the storm faster than real time, so an hour of rain fits in a minute.
- A flat site with no ground heights shows water from the roofs only. Bring in the terrain for real flow.
