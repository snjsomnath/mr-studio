# Make a new table

*From an empty folder to a table on the projector: name, place and size, then the map, the layers and the controller.*

1. On **Home**, choose **New table**.
2. **Name and place.** Give the table a name and find its place: search for an address, or drag the map. The rectangle is the area the table shows; turn it to match how the physical model sits.
3. **Size.** Enter the table's width and height in centimetres, and the tile size if the model is made of tiles. The area on the map follows the table's shape.
4. When you finish these steps, the editor opens with the guide on the left, at its second step. The guide only starts a table: after that, everything is in the editor, and **Present, Ready to present?** says what is left.
5. **Data.** Bring in the buildings, terrain and trees. **Fetch everything from open data**, at the top, gets buildings, streets, walking paths and trees from OpenStreetMap and the ground from free elevation in one go, with a line for each that says how it went and **Try again** on any that failed. Or fetch them one at a time, or import your own files (GeoJSON, GeoTIFF, a 3D model).
6. **Start from….** Pick a starter table: *Climate* (Sunlight, Wind and Cool paths, trees at rest), *Movement* (Mobility, with traffic, public transport and street life at rest), *Story* (a Slideshow, building lights at rest) or *Blank*. Each sets the layers, the map life at rest and a controller theme; pick another to swap. **Open the editor** finishes.
7. In the editor, name the buttons in your visitors' words in each layer's settings, add layers from **Insert**, and press **Present**: the map goes to the projector and the controller to the screen beside the table. The first time, a short tour shows where everything is; **Help, Tour of the editor** shows it again.

![Start from…](docs/screenshots/390-start-from.png)

## Start from a copy

Rather than start blank, start from a table that already works. Point at a card under **Your tables** on Home and choose **Duplicate**: the example that comes with MR Studio, or one of your own tables. The copy is called "… copy", gets its own name and id, and appears on Home outlined; the original is not touched. Open it, then use **Design, Table size and place…** and **Insert, Open data** or **Data file** to move it to your own place and bring in your own data.

![Duplicate on a Home card](docs/screenshots/99-duplicate.png)

## Change it later

The editor is laid out like PowerPoint: the list of what is on the map on the left, the map and the controller in the middle, and the settings of what you select on the right. The ribbon's tabs hold commands only, so opening a tab never changes what is selected or what the map shows.

- **Design, Table size and place…** opens the guide's Name and place as a dialog: rename the table, or move, resize or turn it on the map, with its time zone, where visitors stand and the ribbons below. Nothing moves until you press **Move the table**; **Put back** forgets the changes. The data you brought in and every layer stay, map pictures are fetched again for the new outline, and if the new outline goes past what your files cover you bring them in again. **Undo** puts the table back.
- **At rest** is the first row of the list, with each piece of map life under it. Its eye turns it on or off; select it to change its settings on the right. **Insert, New layer** adds more map life.
- **Design** has the controller's theme as a gallery and the button style (icons, or icons and names). Each button's name, description, icon and side are in the Button section of its layer's settings.

![Table size and place](docs/screenshots/382-table-size-and-place.png)

Tip: everything you change is saved at once, and **Undo** (Ctrl+Z, or ⌘Z on a Mac) takes it back.
