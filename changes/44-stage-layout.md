---
bump: minor
issues: 357
---
### A layer's controller view made of panels, with no code
A layer can now lay out its own controller view in layer.json: `"stage": { "panels": [...] }` puts dashboard panels in the controller's centre, with the same widgets, sizes, bindings and density budget as the TV. With the map, control and gauge widgets and a layer's own team widgets, a custom controller view (a map to pick buildings on, the grid link, the share slider, the optimiser button) needs no module code. The generated control rows step aside unless `"controls": true`. The TV strip under a tall stage now stays blank instead of saying "Turn a layer on" while one is on.

![The model-runs layer's controller view, made of seven panels in layer.json](docs/screenshots/357-stage.png)
