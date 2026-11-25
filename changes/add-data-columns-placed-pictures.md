---
bump: minor
issues: 52
---
### Add data says what each column holds, and pictures can be placed on the map

Bringing in a dataset of your own now shows what MR Studio reads each column as: the column that names each row, values, kinds, when and where. A picture brought in with its side file (such as `overlay.png` with `overlay.json`, which gives its west, south, east and north edges) becomes a Picture layer placed on the map by those edges. Any Picture layer can be placed this way under More settings › Place on the map by its edges. Layers added from the media library or Add data now keep the file they were given after a reload.

![What the columns hold](docs/screenshots/52-columns.png)
