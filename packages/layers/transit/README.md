# Public transport layer

The layer knows nothing about any one city. A site supplies its network, and optionally a live feed.

## Routes and stops: the `transit` dataset

Declare it in `site.json`:

```json
"data": { "transit": "data/transit.geojson" }
```

A GeoJSON FeatureCollection in WGS84:

- `LineString` features are routes. Properties: `line` (the number or name shown on vehicles), `mode` (`tram`, `bus`, `train` or `ferry`), and optionally `colour` and `textColour` as `#rrggbb`.
- `Point` features are stops. Properties: `name` (optional). A stop belongs to every route that passes within 15 m of it.

Without the dataset the layer runs a few made-up lines along the site's streets, so a new scene is never empty.

## Live vehicles: the feed

Set **Vehicles** to *Live feed* and **Feed address** to a URL that returns:

```json
{
  "vehicles": [
    { "id": "abc", "lon": 11.97, "lat": 57.70, "mode": "tram", "line": "6", "colour": "#ffd700", "textColour": "#000000" }
  ]
}
```

`id`, `lon` and `lat` are required. The layer polls the address every three seconds, glides each vehicle to its newest position and drops vehicles that stop being reported.

For Västtrafik, set it up once in **Sources** (its key stays in the computer's keychain) and choose it as **Live data from**: the host asks Västtrafik for the vehicles around the table (`/api/transit/<source>/vehicles`) and turns them into this shape. Other providers get an adapter in `crates/mrs-host/src/transit.rs`. Any other city's API can still be turned into this shape by a small adapter service. The address can be relative, so a site can point at an adapter behind the host (`/services/...`) or at a file in the site package (`/site/data/...`) for testing.
