---
bump: minor
issues: 320
---
### The MCP server brings data in with the editor's own import code

An LLM can now put a team's data on the table without anyone opening the editor. `import_data` checks a file (GeoJSON, CSV, zipped Shapefile, GeoTIFF) or fetches OpenStreetMap or free elevation for the table's area, exactly as Add data does: it detects and reprojects the coordinate system, says how much lands on the table, and refuses what would not work, such as latitude and longitude swapped, with the fix to try. With `write` it saves the file and points `site.json` at it. `add_media` and `add_sound` copy pictures, video and sounds in, and `list_site_files` shows every dataset with its columns, bounds and which settings use it. Behind them is a new `mrstudio data` command (`add`, `media`, `sound`), which the installer now puts beside the app so the MCP finds it.

![import_data, add_media and list_site_files on the sample kit](docs/screenshots/320-import-data.png)
