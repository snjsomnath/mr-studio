# Editor user test

Tests the [editor UI design logic](../editor-ui.md): can a newcomer find the one home of each task without help?

## Who and how

- **Three newcomers** who have never used MR Studio (for example a planner, a student and a museum guide). Not developers on the project.
- **One session each, 30 minutes**, on a laptop at 1440 × 900 with the sample table open. Screen and voice recorded with consent.
- **Think aloud.** The facilitator reads each task, then stays quiet. Help only after 2 minutes stuck, and note it as "helped".
- Run it **twice**: on today's editor (baseline) and after #382 and #384 are built. Same tasks, different people.

## Opening (read aloud)

> This is MR Studio. People use it to build an interactive table: a map projected onto a model, a big touch screen (the controller) where visitors pick what the map shows, and phones that can join in. We're testing the software, not you. Please say what you're thinking as you go. There are no wrong answers.

## Tasks

Read one at a time. Don't use the words on the buttons.

| # | Task (read aloud) | Its one home | Success |
| --- | --- | --- | --- |
| 1 | Change the table's name to "Harbour test". | Design › Table size and place… | Name changed, dialog closed |
| 2 | Show the wind on the map, blowing from the south. | Insert › layer gallery, then Format pane | Wind layer added, direction 180° |
| 3 | The button for wind should say "Breeze" for visitors. | Format pane › Button | Button reads Breeze |
| 4 | Move the Breeze button to the other side of the screen. | Format pane › Side | Button on the other side |
| 5 | Hide the traffic that moves on the map when nobody is using the table. | Eye on the Traffic row under At rest | Traffic off |
| 6 | Add this file of tree positions (trees.geojson on the desktop). | Insert › Data file (or drop it) | File in, used by a layer |
| 7 | Make the controller look darker. | Design › controller theme gallery | Dark theme picked |
| 8 | Try the table as a visitor would, then come back. | Present › Rehearse | Rehearse started and stopped |
| 9 | Is the table ready for an exhibition? Fix one thing it says. | Present › Ready to present? | One item fixed through its link |
| 10 | Send the table to the computer that runs the real table. | Share | Share opened |

## What we note per task

- **First look**: where the eyes and pointer go first (tab, list, canvas, Format pane, right-click).
- **Path**: every click until success, wrong turns marked.
- **Time** to success, or "gave up" / "helped".
- **Quotes**, especially "where is…", "I thought this would…", "which one is the real…".
- **Confidence** after the task, 1 to 5: "How sure are you that you did it the right way?"

## Afterwards (5 minutes)

1. What was the easiest thing to find? The hardest?
2. Was there anything you saw twice, in two places?
3. If you had to explain the screen to a colleague, how would you describe its parts?

## Reading the results

- A task where **two of three** people take a wrong turn: its home is in the wrong place, or the place is badly named. File an issue against the rulebook and link it from #49.
- A wrong turn that lands on a **mirror** (a read-only copy): check the mirror's link home is obvious (rule 2).
- Someone uses **right-click or ⌘K** first: fine, as long as it is the same command (Right-click section).
- Compare baseline and after: time per task and wrong turns per task. #382 is working if both fall.

Results go in `docs/design/user-test-results/<date>.md`, one file per round.
