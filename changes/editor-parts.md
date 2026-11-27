---
bump: none
issues: 540
audience: developers
---
### The editor is split into parts that each take the one editor state

`packages/runtime/src/editor/editor.ts` was 3,700 lines in one class. It is now about 780 lines that wire the parts together around the one editor state (#540). Each part is a module of functions that take that state:

- `layer-rows.ts`: the layer list as drawn. Its rules are in `layer-list.ts`.
- `format-pane.ts`: the right-hand pane.
- `canvas.ts`: the map, controller and phone previews.
- `dialogs.ts`: the dialogs.
- `chrome.ts`: the title and status bars.
- `ribbon-commands.ts`: the ribbon and its commands.
- `file-keys.ts`: the File menu, keys and commands.
- `adding.ts`: adding data, media and layers.
- `setup-guide.ts`: the setup guide and tour.
- `ready-checks.ts`: the checks before Present.

The code moved as it was. The fields the parts share are no longer private. The whole end-to-end run passes unchanged.

![editor.ts and its parts](docs/screenshots/540-editor-parts.png)
