---
bump: patch
issues: 535
---
### Analysis frames are never larger than a screen can show

When an analysis such as Sunlight or Wind changes, the host sends its whole grid to every window. On a city-sized table at 1 m cells that was 16 MB per frame, per window, up to 30 times a second. Now a field of more than 2048 by 2048 cells is sent shrunk: each side divided by the same whole number, each cell the mean of the cells it covers (#535). That is still about twice what a 4K screen shows, so the picture looks the same, and tables up to about 2 km at 1 m cells are not touched.

A layer can ask for fewer cells, or for every cell, with `maxCells` when it opens a stream.

![Frame sizes before and after on a normal and a city-sized table](docs/screenshots/535-frame-size.png)
