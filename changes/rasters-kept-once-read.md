---
bump: patch
issues: 534
---
### Moving through the hours of a raster no longer reads each file again

Cool paths asks for one prepared raster per hour. Going back to an hour that had already been shown loaded and checked `site.json`, opened the GeoTIFF and resampled every cell again (#534).

The host now keeps each resampled raster after the first read, up to 256 MB of them. It reads a raster again only when the file or `site.json` has changed.
