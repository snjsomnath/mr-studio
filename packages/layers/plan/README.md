# Masterplan

A plan drawing over the table, revealed one phase at a time (#193), as the Chalmers demo's "Campus Vision" did.

Bring an SVG in from the editor (Add data, a dataset of your own, such as `masterplan`). The host reads it in Rust (`crates/mrs-site/src/plan.rs`):

- Its top-level groups are its phases: one Inkscape or Illustrator layer each. A single group around everything is looked inside. A phase is named by its layer name (`inkscape:label` or `data-name`), else its id ("primary_routes" reads "Primary routes").
- It is made safe: scripts, embedded pages, event handlers and links to other files are taken out, so a drawing can only draw.
- It covers the whole table, its top along the table's top. A drawing of another shape is stretched, and the import says so, unless it is placed by its corners (below).
- A top-level group named `Base` (or Background, Underlay, Basis, Bakgrund, Underlag) is not a phase: it is the line work everything else sits on, always shown.

On the table, what is outside every phase is always drawn first. Turned on, the layer shows the whole plan. The first Next dims it to a faint outline and brings in the first phase with a reveal that grows from the middle of the table; each Next after that brings in the next phase, and the newest one glows briefly. Previous takes phases back out. With "Next reveals one phase at a time" off, the whole plan shows and Next moves on. The controller's legend lists the phases in their colours and follows the reveal; the phase names can be translated in the site's `branding.translations`.

## As an artwork (#286, #289)

The Lindholmen artwork's three parts are settings of this layer, so another artwork needs a drawing and the table's corners, no code:

- **Opening** (`opening`, `opening_s`): `trace` draws the lines outside the phases in, spreading from the middle of the drawing with a bright pen; `fade` fades it in.
- **Turn to colour** (`colour`, `colour_after_s`, `colour_s`): a colour version (an SVG or a picture of the same frame) the drawing turns into after its lines are in. `look` switches between lines and colour from the controller or a phone at any time.
- **Viewpoints** (`start: base`, `grow: phase`, `earlier`, `later`, `finale`): the overview shows only the base; each Next grows the next phase from its own middle, those before it stay at `earlier`, those to come at `later`, and with `finale` a last step shows them all.
- **Pointing** (`hover`): in the overview and the finale, a pointer resting on a phase lights it on the table, its row in the controller's legend and the controller's picture. It uses the SDK's `HoverRegions`, so the camera's hands can do the same later.
- **Placement** (`corners`): `lon,lat; lon,lat; lon,lat` of the drawing's top left, top right and bottom left puts it where it belongs on the map, rotated and of any shape; empty stretches it over the table.

## Placing it by hand (#301)

With the Masterplan open in the editor, its frame is drawn over the map: drag inside it to move the drawing, a corner to scale it about its middle, the round handle to turn it (it snaps square to the table within 1.5°, and Shift turns in steps of 15°). Letting go writes `corners`. **Fill the table again** empties them.

`turn` (`0`, `90`, `180`, `270`, clockwise) shows a drawing that was drawn on its side the right way round. `corners` are then those of the drawing as shown, so they stay simple to type; changing `turn` in the editor swaps the frame's sides about its middle, so the drawing keeps its shape.

## Drawn the standard way: parts that move by what they are (#300)

Name the parts of a phase by what they are and the layer animates each the way the Chalmers demo's Campus Vision did, with no code:

| Name a group or shape | It |
|---|---|
| Boundary, Project boundary, Projektgräns | traces once, then its dashes march with a slow glow |
| Main axis, Axel | grows from its middle out to both ends, then glows |
| Route, Path, Street, Stråk (Primary path, Secondary routes...) | is drawn along its length, one after another, then pulses |
| Arrow, Pil | appears as its routes end |
| Points, Markers, Punkter | pop in one after another, then pulse |
| Node, Asterix, Star, Nod | its rays grow out from its middle |
| Area, Green spaces, Blob, Park, Yta | grows from its own middle, then breathes |
| Label, Text | fades in |

- A name can be an Inkscape or Illustrator layer name, a `<title>` inside the group (as Boxy SVG writes) or its id. `data-role="route"` says it outright. A part takes the role of the group it is in; a node gathers the shapes inside it.
- Phases named with numbers (`01_Project boundary`, `02 Main axis`) are revealed in that order, and the numbers are left out of their names.
- A phase comes to life over `role_s` seconds. Earlier phases dim to `earlier`, as the demo did.
- `motion: none` shows the parts as they are, grown in by the circle as before. Drawings without role names (the Lindholmen artwork) are not affected.

`samples/kit/drawing/masterplan-roles.svg` is a template drawing in this structure.

The controller's hero shows the drawing as the table does: its phases, the one pointed at, and the turn to colour. Add a Magnifier for the glass.

Params: `dataset` (the drawing's dataset name; empty takes the table's first SVG), `reveal`, `look`, `opening`, `opening_s`, `colour`, `colour_after_s`, `colour_s`, `start`, `grow`, `earlier`, `later`, `finale`, `hover`, `turn`, `corners`, `motion`, `role_s`, `opacity`.
