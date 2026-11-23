# Web map (WMS)

Lays one map image from a WMS service over the table: a planning map, an aerial photo, a noise map. Give the service address and the names of its layers (comma separated), and optionally styles and a source line for the controller.

The table asks the host (`GET /api/wms`) for one GetMap image (WMS 1.1.1, EPSG:4326) of the box around the table and lays it on the table. The host fetches it because most WMS services cannot be read from a browser page, and only passes on a picture: a service error comes back as a note on the controller. For a service that needs a sign-in (Lantmäteriet, SLU, a municipality), set it up once in **Sources** and choose it as **Sign-in**: the host adds the key or login to its own request, so the table and the site folder never hold it. With a sign-in and no address, the source's own address is used.

Use it as a layer of its own or as a slide of a slideshow.
