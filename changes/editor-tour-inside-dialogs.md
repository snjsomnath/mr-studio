---
bump: minor
issues: 451, 453, 457, 459, 460
---
### A tour of the editor, Add inside a layer, and roomier dialogs

The first time the editor opens, a short tour points at the ribbon, the list, the map and controller, the Format pane, the status bar, Present and Help. Untick **Show this tour when the editor opens** to stop it; **Help › Tour of the editor** shows it again.

![The editor tour](docs/screenshots/451-tour.png)

**Insert › Add inside…** (also on a layer's right-click menu and under *In this layer* in its settings) puts a layer inside the selected one, so it comes on with it. The Magnifier's two modes are now called **Magnify** and **X-ray**, and the layer gallery has an **X-ray glass**: the Magnifier set to show what is put inside it.

![Add inside and the X-ray glass](docs/screenshots/453-add-inside.png)

Dialogs are larger, and Open data gets the most room. **Insert › 3D model** opens the model importer itself instead of the Media library. **New layer** is on Insert only; Home works on what is already on the table.

![Open data](docs/screenshots/457-open-data.png)

Fixed: the starter tables in the setup wizard and the editor's newest dialogs had lost their layout, because one stylesheet left a block open. A test now checks every stylesheet closes what it opens.
