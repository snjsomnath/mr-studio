# Make a new table

*From an empty folder to a table on the projector: name, place and size, then the map, the layers and the controller.*

1. On **Home**, choose **New table**.
2. **Name and place.** Give the table a name and find its place: search for an address, or drag the map. The rectangle is the area the table shows; turn it to match how the physical model sits.
3. **Size.** Enter the table's width and height in centimetres, and the tile size if the model is made of tiles. The area on the map follows the table's shape.
4. When you finish these steps, the editor opens with the **Setup guide** on the left. It walks through the rest; you can leave it at any time and come back with **Setup guide** in the title bar.
5. **Your place.** Bring in the buildings, terrain and trees. **Fetch everything from open data**, at the top, gets buildings, streets, walking paths and trees from OpenStreetMap and the ground from free elevation in one go, with a line for each that says how it went and **Try again** on any that failed. Or fetch them one at a time, or import your own files (GeoJSON, GeoTIFF, a 3D model).
6. **At rest.** Choose what the table shows when nobody has pressed anything: a base map and some life on the streets (traffic, public transport, street life, building lights).
7. **Layers.** Add the layers that tell your story: sunlight, wind, stormwater, cool paths and the rest. Each layer gets a button on the controller.
8. **Buttons.** Name the buttons in your visitors' words, give them icons and put them on the left or right of the controller.
9. **Ready.** Press **Present**: the map goes to the projector and the controller to the screen beside the table.

![The setup guide in the editor](docs/screenshots/110-114-name-and-place.png)

## Start from a copy

Rather than start blank, start from a table that already works. Point at a card under **Your tables** on Home and choose **Duplicate**: the example that comes with MR Studio, or one of your own tables. The copy is called "… copy", gets its own name and id, and appears on Home outlined; the original is not touched. Open it, then use **Name and place** and **Your place** to move it to your own place and bring in your own data.

![Duplicate on a Home card](docs/screenshots/99-duplicate.png)

## Change it later

Three of the guide's steps are also tabs on the editor's ribbon, so you never have to walk back through the guide:

- **Name and place** opens the guide's Name and place beside the map: rename the table, or move, resize or turn it on the map. Nothing moves until you press **Move the table** (on the ribbon or under the form); **Put back** forgets the changes. The panel says what a move does: the data you brought in and every layer stay, map pictures are fetched again for the new outline, and if the new outline goes past what your files cover you bring them in again under Your place. **Undo** puts the table back.
- **At rest** switches each piece of map life on or off from the ribbon, with the descriptions, the base map's style and **Bring in** for missing data in the panel.
- **Design** has the controller's theme as a gallery and the button style (icons, or icons and names) on the ribbon, and each button's name, description and side in the panel. The controller beside the map is live.

Choosing something in the list on the left goes back to the Edit tab and its settings.

![The Design tab](docs/screenshots/311-design.png)

![The Name and place tab, with a change waiting](docs/screenshots/313-name-and-place.png)

Tip: everything you change is saved at once, and **Undo** (Ctrl+Z, or ⌘Z on a Mac) takes it back.
