---
bump: minor
issues: 87, 397, 405, 426
---
### One authoring page, numbers in the visitors' language, and a drawing that follows its frame

The old scene composer is retired: `/compose` now opens the editor, the one place to author a table.

Visitors' screens write numbers in their language: **5,0 m/s** in Swedish, 5.0 m/s in English, with 270° and the 24-hour clock in both. Typed numbers read with a point or a comma. One formatter in the SDK does it for the controls, the controller tiles, Sunlight and Cool paths.

![A phone in Swedish](docs/screenshots/397-swedish-phone.png)

Moving a Masterplan drawing by its frame, the drawing itself follows the hand before the table redraws it. Arrow keys nudge it (Shift for larger steps), **[** and **]** turn it, **+** and **−** scale it, and the frame's buttons sit below the table so they never cover its handles.

![The drawing follows its frame](docs/screenshots/405-drawing-drag.png)

The editor's end-to-end check now runs on every pull request.
