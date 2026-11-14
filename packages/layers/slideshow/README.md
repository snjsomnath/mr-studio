# Slideshow layer

Shows a site's media on the table: images, video and GeoJSON, with a fade between slides.
The TV panel shows each slide's title, description, legend and source.

Declare the slideshow in `site.json`:

```json
"data": { "slideshow": "data/slideshow/slideshow.json" }
```

`slideshow.json` keeps the format of the earlier MR Studio app, so an existing `slideshow-config.json` works as it is:

```jsonc
{
  "slides": [
    {
      "type": "image",                // image, video or geojson
      "media": "terrain.png",         // relative to this file
      "duration": 6000,               // milliseconds
      "fitMode": "stretch",           // stretch, contain or cover (images and video)
      "rotation": 0,                  // 0, 90, 180 or 270 (images and video)
      "enabled": true,
      "metadata": {
        "title": "Terrain",
        "description": "Elevation of the study area",
        "source": "Who made it",
        "legend": { "items": [{ "color": "#ff6600", "label": "Housing" }] },
        "style": {                    // geojson only
          "colorProperty": "kind",
          "colorMap": { "housing": "#ff6600" },
          "fillOpacity": 0.5, "strokeWidth": 1, "strokeOpacity": 0.8
        }
      }
    }
  ]
}
```

GeoJSON slides are drawn in place on the table, so they line up with the site. Images and video fill the table.
Slides of type `wms` and `arcgis` from the earlier app are skipped for now: they need map tiles, which layers cannot draw yet.
