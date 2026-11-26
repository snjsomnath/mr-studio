---
bump: minor
issues: 594, 595
---
### Calibration's panel is on the controller, and its corners are real building corners

While the projector is calibrated, the table now shows only the cross of light and the corners already placed, so nothing covers the map and the model (#594). The corner to find, its plan, Back, Skip, Next, Save and a nudge pad for touch screens are in the controller's centre, and in the editor's calibration guide. With no controller screen, K on the table shows the panel there.

![The calibration panel in the controller's centre](docs/screenshots/594-controller-calibration.png)

With building footprints, the corners to find are real corners of the buildings, at their roof height, with the building outlined on the plan (#595). They used to be steps of the height raster, which often matched no corner of the physical model. Without footprints the tool picks corners as before.
