# Draw a layer in another program

*A starter pack is the table's outline, tiles, buildings and streets as files for QGIS, Illustrator, Photoshop or PowerPoint, with steps for each. What you make on it comes back onto the table in place.*

1. Open **Insert, Starter pack…** (or **File, Export starter pack…**).
2. Under **Include**, tick what you want to draw over: the table outline, the tile grid, building footprints, the street network, the projection area and the at-a-glance boxes. The numbers say how many of each the table has.
3. Under **Canvas**, keep **The table** for a layer on the table itself: the canvas is exactly the table's frame, so the picture or drawing lands in place when it comes back. Choose **Table and projection area** for art in the projector's margins around the model.
4. Under **Prepare files for**, tick the programs the pack is for, and pick the **Picture detail**. The drawing on the right is what the pack holds.
5. **Save…** writes the pack as one zip. **Email…** attaches it to a new email in your mail app, for a colleague or a designer. In a browser, **Download** saves it.

![Choosing what goes in the pack](docs/screenshots/450-dialog.png)

## What is in the pack

Open `README.md` in the zip first: it has the table's size and scale, and the steps for each program.

| Program | Files | How it opens |
| --- | --- | --- |
| QGIS | One GeoJSON per feature (WGS84) and `guides.png` with a world file | Drag them in: they land in place |
| Illustrator | `table.svg`: an artboard at the table's real size, the guides in a group **MR Studio guides**, and an empty layer **Your drawing** | File, Open. Inkscape and Affinity open it too |
| Photoshop | One transparent PNG per feature, the same size | File, Scripts, Load Files into Stack |
| PowerPoint | `table.pptx`: one slide the table's shape, the guides as a locked picture | Open it and draw on the slide |

![The guides of a pack, with the projection area and an at-a-glance box](docs/screenshots/450-pack-preview.png)

## Bring it back

- **A picture** (Photoshop, PowerPoint, a QGIS print layout): hide the guides and export a PNG without cropping. **Insert, Picture**, then show it with the Picture or video layer, or as a slideshow step, with Fit set to Stretch.
- **A drawing** (Illustrator, Inkscape): export SVG. **Insert, Data file** or **Media library, Add media**, then **Show on the table**: it becomes a Masterplan, and each group in Your drawing is a step. The MR Studio guides group is left out, so it can stay in the file.
- **GIS data** (QGIS): export GeoJSON in EPSG:4326 and bring it in with **Insert, Data file**.

## Tips

- Without a projector calibration on this computer the projection area is an estimate: the table with room for its at-a-glance boxes. Calibrate first for the real one.
- Keep the canvas's shape. MR Studio stretches a picture over the table, so a cropped or resized picture comes back stretched.
- The same pack comes from the command line, `mrstudio starter-pack <table folder> --out pack.zip`, and from the MCP server's `export_starter_pack`.
