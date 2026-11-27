---
bump: patch
issues: 594
---
### Calibrating no longer redraws the table every frame

While the calibration tool is open on a projected table, moving map life (cars, people, windows) no longer makes the table redraw the 3D model 60 times a second underneath the tool. The tool hides the map while it runs, so those redraws were wasted and made the tool slow on a weaker computer. When the tool closes, the map comes back at once. This also fixes the calibration end-to-end test, which failed on main when the page was too busy.

![Before and after](docs/screenshots/calibration-quiet.png)
