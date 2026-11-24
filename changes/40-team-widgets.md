---
bump: minor
issues: 353
---
### A team's own widgets, held to the same rules as the built-in ones
A layer package can now bring its own kinds of panel. Its code makes them with `defineWidget` and lists them in `widgets`; MR Studio checks each one (sizes, a label on every setting, a cost in reads) and adds it to the one set of widgets the controller, the TV pages and the table's ribbon share, as `<layer>/<type>`. The layer's own panels name it by its short name. It counts against the density budget, binds to what layers publish and follows the theme like any built-in widget, and one that breaks only breaks its own panel. The model-runs sample shows the grid draw as a line into the community that thickens with it, on the controller and in the ribbon. Built-in widgets stay for what most tables need; a widget two teams have each written moves into the built-in set. Also: sound beds no longer fill the window's console with warnings before the first tap.

![The model-runs sample's own Grid link widget on the controller](docs/screenshots/353-controller.png)

![The same widget on the developer page and as a chip in the table's ribbon](docs/screenshots/353-dev.png)
