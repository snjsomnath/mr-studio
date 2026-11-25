# Layer building blocks

Principle 7 of the architecture: a layer is a short composition of shared primitives, not a port.
This document is the catalogue of those primitives, the interaction model, and the recipe for
rebuilding ECOM and Cultural Gravity from them.

Everything here is in `@mrstudio/sdk` under `packages/sdk/src/blocks/`, is plain TypeScript with no
map library and no DOM (except `canvasSurface`), and is covered by `packages/sdk/test/blocks.test.ts`.
`packages/layers/blocks-demo` on `sites/blocks` assembles two scenes from nothing but these blocks:

```
mrstudio dev --site sites/blocks      # then open /dev
```

## What the old layers are made of

A survey of `Nodal-Works/interactive_map` (`main`, `lindholmen`, `universeum`). Each old layer is
500 to 3 700 lines, and most of those lines are the same dozen ideas written again.

| Old layer | What it really is |
| --- | --- |
| ECOM energy (`ecom-energy.js`, 3 766 lines) | GeoJSON sources, hourly series, footprints coloured by a value against a shared peak with a floor, flow lines with width by value, lights travelling along lines, rings pulsing in or out by a node's balance, a footprint filling like a vessel, a staged introduction, KPI readouts |
| ECOM timeline, KPI bars | A clock over a span of hours with day and night marked; stat tiles and a stacked share bar |
| ECOM vehicles | An agent moving along a street path on a schedule |
| Cultural Gravity | Weighted points, a glow and rippling rings per point, a particle crowd pulled to a weighted-random point, a two-step staged reveal |
| EPC | Footprints coloured by a category, joined from a table; click to read a building |
| Artwork | A staged reveal of line work, and a magnifier lens that a mouse moves and a click pins |
| Ferries, transit (`trafik.js`) | Agents moving along paths from a live feed |
| Universeum mobility exhibits | Cells coloured by stepped bins with a legend, dots moving along timed legs, a story panel |
| CoolPaths (thermal comfort) | Lines coloured by a value, origin and destination markers placed by a pointer, hover readout |
| Isovist, street view | A person marker a mouse drags or that follows the mouse, driving a computation |

## Catalogue

All positions are **table metres**: x to the right and y down from the top left of the site's
extent, the frame of a field's columns and rows. `tableFrame(site)` converts to and from WGS84
with the engine's projection and rotation.

### Data

| Block | Exports | Use |
| --- | --- | --- |
| Sources | `geojsonSource`, `csvSource`, `liveSource`, `staticSource`, `mapSource` | One interface, `load()` and `watch()`, whether data is a site file, a CSV export or a polled service. A live source keeps the last good value and backs off when the service is down |
| Shapes | `readShapes` → `Area`, `Path`, `Spot` | GeoJSON to shapes in table metres, sorted by geometry type |
| Tables | `parseCsv`, `columns`, `joinRows`, `foldKey` | Attach rows to shapes by a key, tolerant of accents and case, and report what did not match |
| Series | `sampleSeries`, `seriesPeak`, `sharedPeak`, `sumSeries`, `cumulative` | One value per step, sampled at a decimal position |
| Clock | `Clock` | Play, pause, scrub and loop over a span. No timers; tick it from `ctx.onFrame` |
| Flow networks | `nodeBalance`, `nodePulse` | Which way and how hard a node is working, from its links |
| Geometry | `measurePath`, `pointAlong`, `arc`, `centroid`, `pointInPolygon`, `distanceToLine` | |

### Scales and readouts

| Block | Exports | Use |
| --- | --- | --- |
| Levels | `levelScale` (linear, sqrt, log, with a `floor`) | A value to 0..1. The floor keeps small members visible beside one very large one |
| Colours | `rampScale`, `twoColourScale`, `binScale`, `categoryScale`, `colour`, `mix`, `css` | Continuous, stepped and named classes |
| Legends | `binLegend`, `categoryLegend` | Built from the same definition that colours the table |
| Readouts | `stat`, `bars`, `timeline`, `trend`, `shares`, `formatNumber` | Plain JSON in the shapes the dashboard widgets bind to. A layer passes them to `ctx.publish`; the TV widgets belong to `packages/dashboard` |
| Numbers and units | `formatDecimal`, `formatUnit`, `formatDistance`, `formatClock`, `formatDate`, `formatCompact`, `parseNumber`, `setNumberLanguage`, `numberLanguage` | One formatter (#397) for every screen: a decimal comma in Swedish and a point in English, following the visitors' language; 270° but 5 m/s; metres to kilometres; the 24-hour clock. Typed numbers read with either mark |

### Visuals

Visual blocks are functions that draw shapes through a `View` with a style. A style value is a
constant or a function of the shape, which is how data drives the picture. Blocks hold no state.

| Block | Exports | Use |
| --- | --- | --- |
| Areas | `drawAreas` | Choropleth (fill by attribute), outlines, courtyards, and a `level` that fills a footprint like a vessel |
| Paths | `drawPaths` | Networks, routes, flow maps (width by value), glow, dashes, and `reveal` to draw a line in |
| Spots | `drawSpots`, `drawLabel`, `clusterPoints` | Markers with halo, core and label; clustering for dense data |
| Rings | `drawRings`, `drawGlow` | Rings travelling outward or inward, or rippling in place; a soft catchment disc |
| Travelling lights | `pathHeads`, `drawDots` | Lights along lines as a pure function of time, by period or by speed, any number per line |
| Place motions | `PLACE_MOTIONS`, `placeData` | 22 motions for places (place-motions.ts) on the place data standard (places.ts): weight, activity over time, flows, links. Each has knobs, a ? help setup and draws in design units of 1.25 table mm |
| Test data | `TEST_DATA`, `makeTestData` | Random points, places (with activity, flows and links tables), lines or areas inside a table's extent, with columns to style by (test-data.ts). The New custom layer dialog offers them (#308) |
| Street network | `StreetNetwork` | Lines snapped into a graph; shortest routes (`route`), a tree of routes to one place (`treeTo`, `follow`) and the nodes that reach it. Crowds walk the streets, not across buildings (M8) |
| Particles | `Swarm`, `pullTowards`, `gravity`, `followField`, `pickWeighted`, `aroundRing`, `particleAlpha` | A crowd that is spawned, steered and retired. Steering is pluggable: to a target, by the pull of all attractors, or along any field |
| Data fields | `heatField`, `gravityField`, `siteRaster` | Rasters made from data, returned as a `FieldFrame` and drawn with `ctx.map.addField` like a kernel's |
| Field readers | `sampleField`, `fieldGradient`, `contours` | Work on kernel frames and data fields alike |
| Staging | `Sequence`, `stagger`, `revealedCount` | Named stages that run for a time or wait for "next". `sequence.level('stage')` feeds any style value |

### How blocks draw

A block never touches MapLibre or the DOM. It draws with a `Pen` (the subset of a 2D canvas
context it needs) through a `View`, and `view.toPx` is the single place table metres become pixels.
The same block therefore draws on the table, inside a lens at another scale, and in a test.

```ts
const frame = tableFrame(ctx.site);
const surface = canvasSurface(ctx.map.addElement(), frame);   // a canvas in a table decoration
ctx.onFrame((dt) => {
  const view = surface.begin((time += dt));
  drawAreas(view, buildings, { fill: (b) => demandColour(demandLevel(demandAt(b))) });
});
```

Rasters go through `ctx.map.addField`, so they are coloured on the GPU, sit under the building
outlines, and get `soften` and `glide` for free. Vector blocks sit above the map on the layer's
decoration. When calibration lands, `fitTable` in `view.ts` is the only function that changes.

## Interactions

Every way of pointing at the table becomes the same thing, a stream of `PointerSample`s in table
metres. Behaviours consume samples and never know the source.

```
input sources                 normalised stream            routing              behaviours
─────────────                 ─────────────────            ───────              ──────────
mouse, touch, pen  ─ ctx.pointer.on ─┐                                          Agent   (a marker moves)
phone tools        ─ fromToolInput ──┼─► PointerSample ─► pointerRouter ─────►  Lens    (a region shows something else)
tokens, dials      ─ (future) ───────┤   id, source, phase,  PerPointer         Probe   (read what is under it)
scripts, replay    ─ (future) ───────┘   point, lonLat,                         Dwell   (staying still means something)
                                         pressed, rotation,                     ...
                                         owner, time
```

- **Table pointer** is a first-class input: `ctx.pointer.on(cb)` on the table surface delivers
  mouse, touch and pen. It is local to the table and never passes through the host. A layer sends
  on what other surfaces need with `setParams` (authoritative state, such as a person's position
  that drives a kernel) or `publish` (derived values, such as a readout).
- **Phone tools** stay the session protocol's `tool.input`. `fromToolInput` turns a point input
  into the same sample, so a layer routes both through one function.
- **`id`** names one pointer for as long as it exists (`mouse:1`, `touch:7`, `phone:3`, later
  `token:12`), which is what makes many simultaneous pointers work.
- **`pointerRouter`** offers a sample to behaviours in order and lets the one that took a press
  keep that pointer until release. **`PerPointer`** gives every pointer its own behaviour.

Behaviours hold state the layer reads when it draws, and call back for what must be sent on:

| Behaviour | Does | Old app |
| --- | --- | --- |
| `Agent` | A marker that is dragged, placed by a press, or follows the pointer; keeps a heading; `constrain` keeps it on the table or on a street | Isovist viewer, street view camera, CoolPaths origin and destination |
| `Lens` + `drawLens` | A circle that follows, pins on a press, and shows whatever `inside(view)` draws: the same scene at `zoom` 3 is a magnifier, another scene at `zoom` 1 is an X-ray | Artwork magnifier |
| `Probe` + `hitTest` | Hover and select the spot, path or area under the pointer | EPC and ECOM building selection, CoolPaths hover |
| `Dwell` | Fires when a pointer rests in place | new |
| `HoverRegions` + `areaRegion`, `circleRegion`, `maskRegion` | Large regions of the map that start something when a pointer settles over them (`settle_s`) and fade out when it leaves; `level(id)` eases 0 to 1 for the drawing. Any number of pointers at once; `sources` limits which kinds count. `maskRegion` makes a region from a picture's painted pixels, such as a phase of a drawing (#289) | Artwork phases lit by pointing |

Hover regions take samples with `source: 'hand'` already, so the camera's hand tracking can feed
them later without the layers changing: placing a hand over a region will trigger it as the mouse
does now.

### Reveals, table pads and drawings (#286-#289)

- **`reveal.ts`**: the shapes a revealing layer shows its items through (`RevealShape`: a circle, one
  side of a line, nowhere) and `revealPath`, `revealPolygon`, `revealContains`, `revealUniform` to draw,
  clip and test with them, and `otherSide` for the second map of a then-and-now line (#349). The
  runtime does the clipping (docs/contracts/layer.md, Reveals).
- **`table-pad.ts`**: `tablePad(ctx, el, { draw, onDrag })` puts the table's shape with its buildings
  on the controller, for a hero that moves something on the table (the glass, the line) by dragging.
- **`drawing-reveal.ts`**: what the Lindholmen artwork's opening is made of, for any drawing.
  `traceDrawing` and `drawTrace` trace an SVG's lines in from the middle with a glint at the pen;
  `openingAt` times the trace and the turn to colour; `placement` and `parseCorners` put a drawing on
  the map by three corners; `stagedWeight` says how strongly each phase shows (earlier ones dimmed,
  later ones faint, a finale with all). The Masterplan layer (`packages/layers/plan`) uses all of them.
- **`drawing-roles.ts`** (#300): drawings that animate by role. `roleOfName` reads what a part is from
  its name (boundary, axis, route, arrow, point, node, area, label; English and Swedish, numbers and
  punctuation ignored), `rolePieces` turns a phase group into vector pieces with their roles, `roleFrame`
  says how a piece looks at a moment of its motion (traced, grown from its middle, popped in, breathing,
  marching dashes) and `drawRolePiece` draws it. `phaseNumber` and `phaseTitle` read numbered phase names
  ("01_PROJECT BOUNDARY"). The motions are the Chalmers demo's Campus Vision ones, for any drawing.

### What this unlocks

Built now as proofs in `blocks-demo`: many pointers each owning a person (`PerPointer` of `Agent`),
the magnifier, the X-ray lens that shows the other scene inside its circle, and dwell to read.

Designed for, not built. Each needs only a new source or a new behaviour, not a change to layers:

| Interaction | What it needs | With |
| --- | --- | --- |
| Tracked tokens and rotary dials | A source that emits samples with `source: 'token'`, a stable `id` and `rotation`. `Agent` already takes its heading from `rotation`, `Lens` its zoom | Camera tracking, a future input thread |
| Paint and propose | Line and polygon tools already exist in `tool.input`. Needs a `Draw` behaviour that collects samples into a geometry, and kernels that accept edits to the scene | Wind and engine threads |
| Scenario lenses (today against 2050) | `drawLens` with a second scene. For fields, a second `addField` clipped to the lens circle, which needs a clip option on `FieldOverlayStyle` | Core thread |
| Walk-through | `Agent` with `onMove` calling `ctx.setParams({ viewer })`; the TV shows the street-level view for that position | Core thread (street view) |
| Guided story presets | `Sequence` per layer, driven by a host-level story that sets active layers, params and stage ids. Needs a `story` section in `site.json` | Composer and dashboard threads |
| Phone voting with a live tally | A `vote` tool type or control in the session protocol; the tally is a `bars` readout | Sessions and dashboard threads |
| Dwell and hover reveals | `Dwell` and `Probe`, built | |
| Shared selection across table, TV and phone | Selection ids in layer params, so the host owns them | Sessions thread |
| Session record and replay | Samples are plain data with a `time`; a recorder and a `source: 'script'` player | |

## ECOM, reassembled

The 2.0 ECOM layer keeps its Python dispatch service and its export. The table side becomes a
composition. Old line counts are from `main`.

| ECOM today | Blocks |
| --- | --- |
| `ecom-buildings/nodes/flows.geojson`, fetched with `no-store` | `geojsonSource` + `readShapes`. When the controller pushes a new community, `liveSource` on the service replaces the file |
| The dispatch and optimiser backend (`Dashboard/backend`, its venv, `scripts/services.py`, the allow-list in `host_server.py`) | A site `services` entry the host starts and keeps running; the layer calls it with `ctx.service('ecom').post` and `.job`, and publishes `busy` while it waits (#278, `samples/service-example`) |
| Live EHUB battery, peaks endpoint | `liveSource(url, { every: 30 })`, last good value kept |
| Battery host by folded name ("Kårhus" = "karhus") | `joinRows` / `foldKey` |
| Footprints shaded by demand against the busiest building-hour, `MEMBER_FLOOR` 0.35 | `drawAreas` with `fill: twoColourScale('#2a0b23', pink)(levelScale({ domain: [0, sharedPeak], curve: 'sqrt', floor: 0.35 })(demandNow))` |
| Nonmember footprints as quiet context | `drawAreas` with a faint `stroke` and no fill |
| Solar halo scaled to the brightest roof-hour, `SOLAR_FLOOR` | `drawGlow` with a `levelScale` and floor |
| Battery host fills as charge rises | `drawAreas` with `levelFill` and `level` from a `cumulative` series |
| Flow lines, width by share, colour by source kind | `drawPaths` with `width` and `categoryScale` |
| One travelling light per line, flaring where it lands (`paintHeads`) | `pathHeads` + `drawDots`, sized by `head.landing` |
| Grid and battery rings, outward when giving, inward when taking, each against its own busiest hour | `nodePulse` + `drawRings` |
| Node icons with gauge fill steps | `drawSpots`; pictograms from `ICONS`/`fillIcon` (marks.ts) |
| The table's clock, an hour every few seconds, scrubbed from the controller | `Clock`, ticked in `ctx.onFrame`, seeked from the `hour` control |
| All of the above without code: buildings and nodes, flows by hour, rings, the battery gauge, the clock | A custom layer's `network` motion (#280, networks.ts): nodes from the look's points, `links` and `series` CSVs (or a list of flows held on each link, such as `flow_hourly`, #373), links routed along `roads`, Play and Time on the controller |
| Introduction: lines arrive one at a time, captions, held hours | `Sequence` + `stagger` feeding `reveal` on `drawPaths` |
| Timeline strip with day and night | `timeline(clock)` published; drawn by the dashboard's timeline widget |
| Bottom ribbon: demand, solar, battery, grid, share bar | `stat`, `bars`, `shares` published; drawn by dashboard widgets |
| Click a building for its numbers | `Probe` + `ctx.publish` |
| `controller/ecom-controls.js`: choose a building, then change what it has (in or out of the community, PV coverage), with a debounce before the model runs again | `entities` in layer.json (#279): the runtime picks on the table and shows the picked building's controls on the controller; the layer reads `ctx.entity` and asks the service in its `entities` handler after `debounce_ms` |
| Vehicles arriving and leaving at chargers | `Agent`-like motion along a `Path` by schedule: `pointAlong` and a timed leg. Street routes come from `StreetNetwork` |
| Sound | `audio` group (#150): `analyseSound` (loudness and brightness envelopes), `PeakFinder` (calls), `SoundSchedule` (chorus or loop), `SoundStage` (plays a layer's sounds on the table, silent elsewhere; `cue` plays one now); the `sound` motion draws rings from it and lists its sounds (`CompiledLook.sounds`, `soundLabel`) for the controller's sound cards |
| Isovist, green view and soundscape (#190) | `isovist` block (isovist.ts): `viewScene` indexes footprints and tree crowns, `isovist` casts the demo's 180 rays (cone or all round) and counts open sky, trees and buildings by type, `outsideBuildings`, `follow`, `compassBearing`, `viewMoved`. Audio: `Soundscape` mixes a nature and a city bed by green view (`soundscapeMix`, `easeVolume`), with built-in beds from `synthBed` until a site adds recordings |

What remains ECOM-specific is small: the palette, the wording, the mapping from the dispatch
result to series, and the roof panel geometry. The `energy` scene in `blocks-demo` is about
70 lines and already shows demand, solar, flows, lights, rings, the battery level and readouts.

## Cultural Gravity, reassembled

| Cultural Gravity today | Blocks |
| --- | --- |
| Twelve places with category and weight, written into the code | A site dataset: `geojsonSource` + `readShapes(...).spots`. Nothing site-specific stays in the layer |
| Category colours | `categoryScale` |
| Faded gradient disc per place, sized by weight | `drawGlow` |
| Three rippling rings per place | `drawRings` with `direction: 0`, `count: 3`, `wobble` |
| Centre dot, white core, label | `drawSpots` with `core` and `label` |
| 600 particles spawned on a ring around a weighted-random place, pulled in with a wobble, retired on arrival | `Swarm` with `pickWeighted`, `aroundRing` and `pullTowards` |
| Stage 0 to 4: wait, reveal places one by one, wait, ramp the crowd up, full | `Sequence([idle, reveal 4 s, revealed, ramp 3 s, full])`, `stagger` for one by one, `sequence.level('ramp')` as the swarm's intensity |
| Right arrow and a controller button advance the stage | An `action` control: `action(id) { sequence.advance() }`. It works from the TV and phones for free |
| Pixels and frames as units | Metres and seconds, so it looks the same on every table |

New things that fall out of the blocks: the combined pull of all places as a field under the
crowd (`gravityField` through `addField`), particles that follow that field instead of one target
(`gravity` or `followField`), a probe on each place, and an X-ray lens onto another layer.
The `gravity` scene in `blocks-demo` is about 45 lines.

## Contract changes in this work

Additive only, no version bump:

- `TableContext.pointer` (`TablePointer.on(cb)`), documented in `contracts/layer.md`.
- New SDK exports under `blocks/`. No existing export changed.

Not changed: `layer.json`, `site.json`, the wire protocol, `hub.rs`.

Open points for other threads:

- `blocks-demo` reads `/site/data/<file>` directly. It should move to named site datasets
  (`loadSiteData`) when the CoolPaths thread's PR lands.
- `blocks/geo.ts` `tableFrame` and that PR's `siteProjection` implement the same projection.
  Whichever merges second should call the other.
- The table pointer assumes the extent is fitted and centred in the surface (`fitTable`), which is
  what the runtime does until calibration exists.

## Backlog

Recorded from a brainstorm with Sanjay. Items marked "block" fit this package; the rest belong to
the thread named.

| Group | Item | Where |
| --- | --- | --- |
| Engine | Raycaster, grid diffusion, shallow water, agent simulation (the network router is built as the `StreetNetwork` block; a threaded kernel only if networks outgrow the frame) | Kernels (engine threads) |
| Data | Scenario store, time cube (series per cell), geo-join (points in areas) | block |
| Data | Live stream adapter (MQTT, WebSocket) behind the `Source` interface | block, with the host gateway |
| Data | Offline cache for live sources | Host |
| Visuals | Contours | built (`contours`) |
| Visuals | Pictogram icons with fill gauges, extruded bars, vector-field arrows, trails and ghosting, non-overlapping labels | block |
| Visuals | Split and swipe compare, bloom night style | Runtime (needs a compositor) |
| Interaction | Gesture recogniser (pinch, rotate, flick) over the sample stream | block |
| Interaction | `Draw` behaviour for lines and polygons | block |
| Interaction | Shared selection set, undo and history | Sessions (host state) |
| Interaction | Story hotspots, idle attract mode | block on `Sequence` and `Dwell` |
| Story | Narrative steps, captions | block on `Sequence` |
| Story | Camera moves, QR snapshot handouts | Runtime and host |
| System | Auto quality under a performance budget, session record and replay, headless snapshot export | Runtime and host |
