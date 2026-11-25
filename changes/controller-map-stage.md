---
bump: minor
issues: 374, 412, 420
---
### A full map in the controller's centre, coloured by data, with no code

A layer's `stage` can now be a map: `"stage": { "map": { ... }, "panels": [...] }` fills the centre under the layer's name with the site's map, and up to four small panels sit along its bottom edge. Map panels and map stages can colour every feature by data with `fill_by` and `stroke_by` (a feature's property, an entity's value as visitors change it, or a value the layer publishes), along a colour ramp or by category, and write a property on each feature with `labels`. Drag and pinch zoom the map, and Reset frames the table again. A tap can also press one of the layer's named actions. `samples/map-stage-example` plans what each building becomes.

![A map stage: buildings filled by the use visitors give them, a legend and a goal beside the map](docs/screenshots/374-map-stage.png)

![Zoomed in, with Reset](docs/screenshots/374-map-zoomed.png)

### The controller says when the table isn't open

With no table window open, nothing runs, so a layer's live values and legend stay empty. An open layer now says "Open the table to see live values here." until a table opens.

![Sunlight on the controller with no table open](docs/screenshots/412-no-table.png)

### Full screen in the Mac app

The Full screen button in the controller's map controls now works in the desktop app on a Mac, where the app's web view has no full screen of its own: the app makes the window full screen. A browser that can't go full screen no longer shows the button.
