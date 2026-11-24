---
bump: minor
issues: 70, 69
breaking: Tables saved by this version use site format 3 and do not open in older versions of the app; older tables are upgraded when opened and the original is kept beside them as site.format-2.json. Update the app on every computer that opens a table.
---
### Layers with their own ids, items and sequences

Every layer in a table has its own id, a layer can hold items that show only while it is open, a slideshow can be a sequence of layers, and custom layers are saved in the table. The editor can also hide some of a layer's controls from visitors.

![Layers with their own ids, items and sequences](docs/screenshots/70-format-3-editor.png)
