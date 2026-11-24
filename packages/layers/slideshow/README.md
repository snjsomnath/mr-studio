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

## A slideshow of layers (#43)

A slideshow can instead be a sequence of layers: `steps.sequence` in site.json, built in the editor's **Slides** list. Each slide shows a layer of the table, which keeps its own button, or one of the slideshow's own items, such as a **Web map (WMS)** or **Map data** from a dataset of the site. The host shows one slide at a time and moves on with the controller's Next (`layer.step`), by hand or timed. On a slide whose map reveals its categories one by one, Next reveals the next category first, then moves on to the next slide, or stays there when the slide's Next is set to stay. With a sequence, the old `slideshow.json` slides and their controls are not used.

Slides can be pictures and video too (#197): **Picture or video** in the Slides list adds a `media` item, and its file is picked from the table's pictures and video or added there and then (kept under `data/media/`). A table that still has an old `slideshow.json` gets a **Bring in the slides of slideshow.json** button, which makes its picture, video and web map slides into steps in their order, with their titles, sources and seconds.

Each slide comes in with a transition (#43): a cross-fade (the default, 0.7 s, as in the Chalmers demo), a fade through the map, or a cut, set for the whole slideshow under **Transition** and per slide with **Comes in**. The editor's map shows the transitions when you press **Try Next**.
