# Web map (WMS)

Lays one map image from a WMS service over the table: a planning map, an aerial photo, a noise map.

**Built-in maps (#200).** Choose one under **Map** and nothing else is needed: an aerial photo (today, infrared, 1960s, 1970s), the topographic map (normal or toned down), hillshade, terrain slope, property boundaries, and lakes and streams. They are Lantmäteriet's maps from SLU's open mirror (hades.slu.se), need no key, and carry the credit "© Lantmäteriet, via SLU". They are the maps the interactive_map slideshows at Chalmers and Lindholmen use. In a slideshow, **+ Add a slide** lists them too. The list lives in `src/presets.ts` and the `map` control of `layer.json`.

**Another service.** Choose "Your own service" and give the service address and the names of its layers (comma separated), and optionally styles and a source line for the controller.

The table asks the host (`GET /api/wms`) for one GetMap image (WMS 1.1.1, EPSG:4326) of the box around the table and lays it on the table. The host fetches it because most WMS services cannot be read from a browser page, and only passes on a picture: a service error comes back as a note on the controller. For a service that needs a sign-in (Lantmäteriet, SLU, a municipality), set it up once in **Sources** and choose it as **Sign-in**: the host adds the key or login to its own request, so the table and the site folder never hold it. With a sign-in and no address, the source's own address is used.

Use it as a layer of its own or as a slide of a slideshow.
