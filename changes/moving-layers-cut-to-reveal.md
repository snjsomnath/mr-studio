---
bump: patch
issues: 619, 620
---
### Moving layers stay inside an X-ray glass and a Reveal line again

Trees, traffic, lit windows, street life, street glow and public transport placed inside a Magnifier's X-ray or a Reveal line showed over the whole table again since 0.53.0 (#619), because their moving parts are now drawn by the graphics card and were not cut to the glass or the line. They are cut again, in both stacks, and a click on the map finds them only where they show.

![Before: the X-ray's trees and traffic spill over the whole table](docs/screenshots/619-xray-before.png)

![After: they show only inside the glass](docs/screenshots/619-xray-after.png)

![A Reveal line with trees and traffic in the surface stack (right) and lights and transit underneath (left)](docs/screenshots/619-line-stacks.png)

**Add media** in the media library and in every file list now takes zipped shapefiles and GeoPackages too, and asks which of their layers to bring in, as Add data does (#620).
