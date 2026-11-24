---
bump: minor
issues: 259, 260
---
### Layers say when they are in trouble, and heal themselves

A layer that cannot start, or cannot read its data, is never silently missing any more. It tries again by itself (after 1 s, 2 s, 5 s, 15 s, then every minute), so putting a missing file back or waiting out a restart is enough. Meanwhile the editor shows a red dot on its row, with why ("couldn't read walkways.geojson") and a **Retry** button, and the controller dims its button with "Not available right now". The start and end of the trouble go to the operator log.

![The editor shows why Cool paths is not running, with Retry](docs/screenshots/259-editor.png)

![On the controller, the button of a layer in trouble is dimmed](docs/screenshots/259-controller.png)

### Diagnostics you can send

Errors in the table, controller, editor and phone windows now reach the app's log, so a problem at a site can be seen without the developer tools. **Help › Copy diagnostics** (also on the editor's Help tab) gathers one report to paste into an issue: the version and build, the table, how each layer is doing, the windows' frame rates, errors, incidents, the displays and the end of the app's log. Keys are never in it. **Save diagnostics…** writes it to a file and **Open log folder** shows the logs.

![Copy diagnostics shows the report it copied](docs/screenshots/260-diagnostics.png)
