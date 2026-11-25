# Task audit: one way to do each task (#384)

Rule 1 of [docs/editor-ui.md](../../editor-ui.md): every setting is edited in one place. A command (Hide, Rename, Add a layer) may run from the ribbon, right-click, a key or ⌘K, as long as it is the same command with the same name; that is not a second way. A second *form* for the same setting is.

`packages/runtime/test/editor-layout.test.ts` checks the editable fields on every pull request (each `setting(id, home, field)` must sit in its home). This table is the same audit by hand, for the tasks an author actually does. Add a row when a feature adds a task.

Re-run on 2026-11-25 on main 0.32 plus #390 and #393.

| Task | Before #382 | Now | Its one home | Shortcuts to the same command |
| --- | --- | --- | --- | --- |
| Rename the table | 3 | 1 | Design › Table size and place… | File › Table size and place… (app menu, same command); the new-table wizard's first step is the same component (rule 9) |
| Move or resize the table | 2, plus 2 buttons | 1 | Design › Table size and place… | as above |
| Time zone | 1 | 1 | Design › Table size and place… | |
| Turn a piece of map life on or off | 4 | 1 | The eye on its At rest row | Home › Hide and right-click › Hide run the same toggle |
| Base map style | 2 | 1 | Format pane of the Base map row | Design › Base map style ▾ selects that row |
| Add a layer | 4 | 1 | Insert › layer gallery | Home › New layer (same gallery), Media library › Show on the table (adds a Map data layer for that file) |
| A button's name, words, icon | 4 | 1 | Format pane of the layer, Button section | F2 in the list renames (same field) |
| A button's side and order | 4 | 1 field | Format pane of the layer (Side) | Drag on the controller rails in the list, right-click › Move to the other side. See note 1 |
| Controller title and welcome line | 1, wrong home | 1 | Design › Welcome and languages… | |
| Controller theme and button style | 2 | 1 | Design ribbon | The wizard's Start from… picks a theme once, for a new table (rule 9) |
| Bring in a GeoJSON | 4, two behaviours | 1 | Insert › Data file (file first) | The wizard's Data step uses the same importer; the Readiness list's "Bring in…" opens it |
| Fetch open data (streets, trees, ground) | 2 | 1 | Insert › Open data | The wizard's Data step uses the same component |
| Try it as a visitor | 3 windows | 1 | Present › Rehearse (on the canvas) | View › Open in a window is for real displays |
| Screens, calibration, colour | 3 | 1 | File › Settings › This computer (#393); in a browser, Present › Screens and calibration… | Present › Screens and calibration… opens Settings in the app. See note 2 |
| Drawing quality | 1 | 1 | Present › Screens and calibration… | |
| Sources and keys | 2 windows | 1 | File › Settings › Sources and keys | Home's import message links there |
| App updates, command line tool | 1 (Displays and settings) | 1 | File › Settings | MR Studio › Install command line tool… on a Mac runs the same install |
| Back to the list of tables | 3 (logo, All tables, File menu) | 1 | File › Open… | The logo runs File › Open… |
| Check before presenting | 0 | 1 | Present › Ready to present? | The status bar's count opens the same list |
| Share with the studio PC | 0 | 1 | Share (title bar) | Present › Share by email, File › Share by email… |

## Notes

1. **Button side.** `docs/editor-ui.md` rule 7 asks for the side to be arranged only by dragging, with the Format pane showing it read-only. The editor today has one editable field (Format pane › Side, `button.side` in settings-list.ts) and dragging in the list as the direct way to move it. That is one setting with one field, but it differs from the letter of rule 7. Left as is until Sanjay picks one; the user test (#398) is the place to decide.
2. **Calibrate on the visitors' controller.** The Map controls group on the controller screen keeps Calibrate (with Reset view, Full screen and Sound), because the person standing at the table is the one who sees whether the map sits on the model. It opens the same calibration tool, so it is a shortcut, not a second home. It belongs to the operator (#394), who may hide Map controls with `tv.map_controls: false`.
3. **Putting things inside a layer** (Magnifier X-ray, Reveal line, items that come on with a layer) has no visible command since #382. That is a missing way, not a second one: #453.
