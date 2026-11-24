---
bump: minor
issues: 277
---
### Your own layers, with code, in the installed app
A table can now carry layers its team wrote, with their own drawing on the table and their own panels on the controller, without changing MR Studio. `mrstudio layer new` makes a working layer in the site's `layers/` folder, `mrstudio layer build` gets it ready, and the app loads it next to the built-in layers. Developers write against the same SDK as the core layers. The table's computer runs the built layer and needs no extra tools.

![A site layer drawing rings on the table where it was clicked](docs/screenshots/277-site-layer-table.png)
![The same layer on the controller: its button, primary action, counter and its own panel](docs/screenshots/277-site-layer-controller.png)
