---
bump: patch
issues: 483
---
### Big tables draw without stopping

The base map now draws a city's buildings and streets a few milliseconds per frame, and Building lights draws its glow around the buildings once and reuses it. A table with tens of thousands of buildings no longer stops for seconds while the map is drawn, and the lights don't hold up every frame. On a test file with 64,397 buildings, the base map's longest pause fell from 2.4 s to under 0.1 s, and a Building lights frame from 2.3 s to about 0.1 s. When a building briefly goes dark, its windows go out but its soft outline glow now stays.

![Pauses before and after](docs/screenshots/483-sliced-drawing.png)
