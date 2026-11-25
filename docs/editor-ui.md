# Editor UI design logic

The rulebook for the MR Studio editor: the window where an author builds a table (map, controller and phones) and presents it. It decides where any new button, panel or setting goes. A design or pull request that breaks a rule here changes the rule first (with Sanjay's yes) or gets changed.

Agreed with Sanjay on 2026-11-24. Living copy with comments: [UI design logic](https://claude.ai/artifact/5J5nYAajHJxsu6KKKwUVf2). Background and screenshots: [docs/design/journey](design/journey/).

**In one line:** a PowerPoint shell around a GIS-style layers list, with a Unity-style Rehearse. Every setting has exactly one place where it is edited.

The first test is the user flow: an author should never wonder which of two places is the real one.

## The three parallels

| Borrowed from | What we take | Where it stops |
| --- | --- | --- |
| PowerPoint (the shell) | Ribbon of commands, a canvas that never moves, a Format pane for the selection, dialogs for whole-file settings (Slide Size, Set Up Slide Show), Present and Share at the top right | No running order. A table is a menu of buttons visitors pick in any order. Only the Slideshow layer has slides. |
| QGIS / kepler.gl (the list) | A layers list: things stacked on one map, top draws over bottom, each with its own style and an eye to hide it | No GIS jargon, projections or attribute tables in the main flow. |
| Unity (the preview) | Layers are live simulations with settings; Rehearse runs the table inside the editor and stops back where you were | No scripting or scene graph for authors. Code layers stay in the SDK. |

## The layout

Six regions. Their places never change, whatever tab is open or whatever is selected.

| Region | Holds | Never holds |
| --- | --- | --- |
| Title bar | File, Undo/Redo, the table's name and saved state, Help (?), Share, Present | Settings, tool buttons |
| Ribbon | Commands, grouped by tab. Galleries (themes, layers). Buttons that open dialogs, with a trailing … | Fields you type into, toggles that duplicate a list row, panels |
| Left list | The map's stack: At rest (the base map and map life) above the layers, in drawing order. Below it, its own group: Controller and Phones | Button order or sides, files, settings |
| Canvas | What the visitor sees: the map, the controller, or both (View tab), live. In Both, Shrink controller on the controller's header docks it as a small live thumbnail (#388). Rehearse runs here. | Forms, galleries, file lists, hints |
| Format pane (right) | The settings of what is selected, and the only place they are edited | Anything about something not selected |
| Status bar | Saved, connection, engine, "N things to check before presenting" | Actions that change the table |

## The rules

1. **One home per setting.** Every setting is edited in exactly one place. Two editable copies of one setting is a bug.
2. **Mirrors are read-only and link home.** A setting may be shown elsewhere ("Button: Wind, left side"), only as text with a link to its home.
3. **Tabs hold commands, not places.** Opening a tab changes the ribbon only. It never changes the canvas, the left list, the selection or what the map shows.
4. **Select, then format.** Select something (in the list or on the canvas) and edit it in the Format pane. The ribbon acts on the selection; it never carries its own copy of the selection's settings.
5. **Table-wide settings are dialogs.** Settings of the whole table open as a dialog from the ribbon (like Slide Size): Table size and place, Welcome and languages, Screens and calibration. A dialog closes back to where you were.
6. **This computer is not the table.** Screens, calibration, colour and phones joining on this network belong to the computer (#73): they live in File › Settings › This computer (#393), never in the table's settings.
7. **Two orders, two homes.** The left list is the map's drawing order. The controller's button order and sides are arranged only on the controller preview, by dragging (right-click › Move to the other side is the shortcut). The layer's Format pane shows its side read-only.
8. **Rehearse in place.** Trying the table as a visitor happens on the canvas, one key away, and stops back where you were. Windows are for real displays (Present).
9. **The wizard only starts a table.** Like PowerPoint's start screen. Once the table exists, it is edited in the editor.
10. **Add things from Insert.** Layers, data, pictures, video, sound and models enter through Insert, file first: pick or drop a file and MR Studio works out what it is.
11. **Greyed, not gone.** A command that doesn't apply right now stays in place, greyed out, with the reason in its tooltip (#182).
12. **Nothing off screen.** The ribbon folds to fit the window (small buttons, then a More menu) and never scrolls sideways (#383).

## The ribbon

| Tab | Groups and commands | PowerPoint's |
| --- | --- | --- |
| Home | Layer: Duplicate, Remove · Selection: Hide, Move up/down, Rename, Reset settings · Find a command (⌘K, #65) | Home |
| Insert | Layers: layer gallery ▾ (#59), Add inside… (#453), Custom layer · Your data: Data file, Open data (OpenStreetMap, elevation) · Media: Picture, Video, Sound, 3D model · Draw elsewhere: Starter pack… (#450, the table's basics for QGIS, Illustrator, Photoshop, PowerPoint; also File › Export starter pack) | Insert |
| Design | Controller theme gallery · Buttons: Icons / Icons and names · Map: Base map style ▾, Palette · Table: Table size and place…, Welcome and languages… | Design |
| Present | Check: Ready to present? (#63) · Start: Rehearse, Present · Set up: Screens and calibration… · Send: Share by email (#372), Export | Slide Show |
| View | Map / Controller / Both, Phone (#389), zoom, table outline · Media library… (a dialog) · Open in a window | View |
| Help | Guides, features, Copy diagnostics (#88, #260) | Help |

In no tab: button names and words (Format pane of the button's layer), button sides and order (drag on the controller preview), map life switches (the eye on each At rest row), table name and place (the dialog). The controller theme lives only on the Design ribbon; the Controller row's Format pane shows the welcome screen and links there.

## Where every setting lives

| Task | Home | Ways before #382 |
| --- | --- | --- |
| Rename the table, move or resize it | Design › Table size and place… | 3 |
| Time zone | Design › Table size and place… | 1 |
| Controller title, welcome line, logo, languages | Design › Welcome and languages… | 1 (in Table settings) |
| Controller theme and button style | Design ribbon | 2 |
| Turn a piece of map life on or off | Eye on its At rest row | 4 |
| Base map style | Format pane of the Base map row | 2 |
| A layer's settings (wind speed, hour…) | Format pane of the layer | 1 |
| A button's name, words, icon | Format pane of the layer, Button section | 4 |
| A button's side and order | Drag on the controller preview | 4 |
| Drawing order on the map | Drag in the left list | 2 |
| Add a layer | Insert › layer gallery | 4 |
| Bring in a file | Insert (file first) | 4, two behaviours |
| Check before presenting | Present › Ready to present? | 0 (#63) |
| Try it as a visitor | Present › Rehearse (on the canvas) | 3 windows |
| Screens, calibration, colour | File › Settings › This computer (#393); Present › Screens and calibration… opens it, and holds them itself in a browser | 3 |
| Drawing quality | Present › Screens and calibration… | 1 |
| Sources and keys, updates, command line | File › Settings | 2 windows |
| Back to the list of tables | File › Open… (the logo runs it) | 3 |
| Share with the studio PC | Share (title bar) | 0 (#372) |

The same audit, task by task with the shortcuts to each command, is kept in [docs/design/journey/task-audit.md](design/journey/task-audit.md) (#384). Add a row there when a feature adds a task.

## Right-click

Right-click is a shortcut, never a home. A command may run from several places (ribbon, right-click, keyboard, ⌘K) as long as it is the same command with the same name. The menu shows the commands for what is under the pointer, most common first, and ends with **Settings…**, which selects the thing and opens its Format pane. Nothing in it exists only there.

| Right-click on | Menu |
| --- | --- |
| A layer row in the list | Open, Rename, Duplicate, Hide, Reset settings, Remove, Settings… |
| An At rest row | Show/Hide, Move up/down, Remove, Settings… |
| A button on the controller preview | Rename, Move to the other side, Hide from the controller, Settings… |
| Something drawn on the map | Select the layer that drew it, then that layer's menu (needs layers to report what they drew, #60) |
| Empty map | Add a layer…, Base map style, Settings… for At rest |
| A file in the media library | Show on the table, Used by…, Replace, Remove |
| The place map in Table size and place | Turn the table (right-drag), as today |

## Help and hints

Three depths, each in one place, like Office's ScreenTips, the info button and the Help pane. Each help text is written once (layer manifest or help.json) and read from there by the tooltip, the ? popover, the guide and the MCP server.

| Depth | Answers | Where | Shows |
| --- | --- | --- | --- |
| Tooltip (hover, ~0.5 s, and keyboard focus) | What is this? | Everything clickable: ribbon commands, list rows, eyes, Format pane fields, controller preview buttons | **Name** and shortcut, one line on what it does, why it's greyed out (rule 11), "Learn more" when a guide page exists |
| ? popover (click) | How do I fill this in? | Only beside a Format pane section or dialog field that needs a format or concept: data files, scale, time zone, base map keys | Two or three lines, an example, **Download a sample** from the sample kit (#36), a link to the guide |
| Guide (Help tab, ? in the title bar) | Walk me through it | Its own window, opened at the page a tooltip or popover links to | Step-by-step guides and every feature (#88, #271) |

- Tooltips on everything; ? marks are rare. A ribbon command never needs a ?.
- A ribbon label may shorten; its tooltip gives the full name.
- No help text in panel code. A tooltip with no text in the manifest or help.json fails `scripts/check-docs.mjs` (#269).
- No hints on the canvas: the map and the controller preview show what visitors see, nothing more.

## File and Settings

Like Office's File screen and Options (#393). **File** holds the table's file actions: New, Open…, Save As, Export, Share, Show in folder, Close, then **Settings…**. Open… is the list of tables; the MR Studio logo runs it. **Settings** is one window for the app, in two groups: *This computer* (Screens, Calibration, Colour, Phones and startup) and *MR Studio* (Updates, Command line, Sources and keys). Present › Screens and calibration… opens its This computer pages in the app; in a browser, where there is no Settings window, it lines up the projector itself.

## The wizard

PowerPoint's new-presentation screen: three steps to a working table, then the editor (#390).

1. **Name and place**: the same component as Design › Table size and place…
2. **Data**: fetch open data in one go, or bring in files (the Insert › Data file component).
3. **Start from…** a starter table: Climate (sunlight, wind, cool paths), Movement (traffic, mobility, transit), Story (slideshow), or Blank. Each sets the layers, the map life and a controller theme.

After that, **Present › Ready to present?** (#63) is the guide: each missing item links to its one home. There is no Setup guide button; New table on Home starts the wizard.

## Settled in #388, #389, #399

- **Empty table**: the map shows one card, "No layers yet" with **Insert a layer**. The map and controller carry no other hints.
- **Several layers**: Ctrl-click (⌘-click on a Mac) or Shift-click adds a row to the selection. Show, Hide and Remove act on all of them; the Format pane says how many are selected and shows the settings of the first.
- **Mac and Windows**: shortcuts use ⌘ on a Mac and Ctrl elsewhere; dialogs put the confirming button last on a Mac and first on Windows (`editor/platform.ts`).
- **Room for the map**: *Shrink controller* on the controller's caption docks it as a small live picture in the corner; click it to enlarge. **View › Phone** shows a visitor's phone beside the map, live. Both are remembered on this computer, not in the table.

## Still to design

- **Custom layer builder**: becomes sections of the Format pane (Data, Look, Motion, Interaction); its button is handled like any layer's.
- **Slides and layer items**: children under their layer in the list; select one, format it in the pane.
- **Controller panels and widgets** (#155, #357): select a panel on the controller preview, edit it in the Format pane.
- **The operator**: running a table at an exhibition (Present controls, a lock so visitors can't reach the editor, idle reset) is a different person from the author, and not designed yet.
- **One place for messages**: saved state, live data sources, performance warnings (#262) and readiness report in the status bar; a change that can be undone shows one notice with Undo.
- **Version history** (#72): File › Version history… lists saved versions of the table (from the host's revision history) and restores one. Undo stays for this session's changes; Version history is for going back further.
- **Two authors at once**: the MCP server, a second editor window or a colleague can change the same table. A setting changed elsewhere updates in place with a short notice in the status bar; it never silently overwrites what the author is typing.
- **Units and formats**: metres and kilometres, the 24-hour clock, and dates and decimals in the editor's language (decimal comma in Swedish). One formatter, used by the Format pane, the dialogs, the table and the phones.

## The user test

The rulebook is a hypothesis until people use it. Before #382 is built, and again after, three newcomers who have never seen MR Studio do the tasks below on the sample table, thinking aloud. We note where they look first, wrong turns, and time per task. A task that takes a wrong turn for two of three people means its home is in the wrong place. Script and notes: [docs/design/user-test.md](design/user-test.md).

## Built to change

The layout is data, so a future change of philosophy is a layout change, not a rebuild (#392). Commands and settings are each declared once (name, icon, help, when greyed out, owner, home). The ribbon, right-click, ⌘K, the Format pane, dialogs, the wizard and the MCP all read those declarations. Which tab and group a command sits in is a layout file. A test checks that each setting has exactly one editable placement, and end-to-end tests address command and setting ids, not screen text.

Where it lives in the code (`packages/runtime/src/editor/`):

| File | Holds | Change it to |
| --- | --- | --- |
| `layout.ts` | The tabs, their groups and which command sits in each | Move a command, add a tab, try another layout |
| `commands-list.ts` | Every command once: name, icon, tooltip, search words | Add a command (then give it a handler in `editor.ts`; TypeScript says if one is missing) |
| `settings-list.ts` | Every setting once: owner and its one home | Add a setting. Fields are tagged `setting(id, home, field)`; the type only accepts the setting's own home |
| `ribbon-layout.ts` | Draws a command wherever it appears: ribbon, right-click, ⌘K | Change how commands look or behave everywhere |

`packages/runtime/test/editor-layout.test.ts` checks the layout against the declarations and that no setting is edited outside its home. Ribbon buttons carry `data-command`, fields `data-setting`, so tests address them by id.

## How to check a change

Every editor pull request answers these in its description:

1. Which tab and group does the new command go in, and is it a command (not a setting)?
2. Where is the new setting's one home? If it shows anywhere else, is that copy read-only with a link?
3. Does opening any tab still leave the canvas, the list, the selection and the map as they were?
4. Does it fit at 1280 × 800 with nothing scrolling off the ribbon?
5. Does "Where every setting lives" still show one home per task? Add a row for any new task.

## What changes from today

| Today | Becomes | Issue |
| --- | --- | --- |
| Edit tab | Home (selection) and Insert (adding) | #382, #383 |
| Name and place tab | Design › Table size and place… dialog | #382 (was #313) |
| At rest tab | At rest rows in the list, each with an eye; Base map style in its Format pane | #382 (was #312) |
| Design tab | Design (themes, button style); button words only in the Format pane | #382 (was #311), #384 |
| Display tab | Present › Screens and calibration…, which opens File › Settings › This computer in the app | #382, #73, #393 |
| Media tab | View › Media library… dialog; adding through Insert | #382, #52, #306 |
| Help tab | Help tab, and the ? button | #88 |
| Table settings (gear) | The two Design dialogs | #382, #62 |
| Preview, Open in a window | Present › Rehearse on the canvas; windows under View | #97 |
| Setup guide (6 steps) | Wizard of 3 steps for new tables only | #390 |
| Tabs change selection and map | Fixed by rule 3 | #385 |
