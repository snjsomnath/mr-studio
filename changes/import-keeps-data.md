---
bump: patch
issues: 512
---
### Undo after an import brings your data back

Bringing in new buildings, terrain or any other data used to write over the file that was there, so Undo put the settings back but not the data (#512). One click on "Fetch from OpenStreetMap" could cost hand-cleaned buildings for good.

Now new data is saved beside the earlier file (`buildings.v2.geojson`), and Undo, Redo and the version history show the data of that moment. The last three earlier versions of each file are kept, and table files you share carry only the one in use. A picture or sound added under a name that is taken no longer replaces the one a slide shows.

![What the table uses after an import, Undo and Redo](docs/screenshots/512-import-keeps-data.png)
