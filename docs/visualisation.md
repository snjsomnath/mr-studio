# Visualisation: philosophy and framework

Status: living document, v0.1 (2026-11-23). Update it as we learn from the physical table: add an entry to
[Learnings from the table](#12-learnings-from-the-table) and change the rule it affects in the same PR.

Rules carry ids (`S1`, `E3`, `C2`, `M4`…) so issues, PRs and learnings can point at them. Values marked
*start* are starting points that nobody has checked on a real table yet.

The sections build on each other: what the medium is, why use it at all, what data it can show and how to
classify that data, then where each thing goes and how to draw it.

Related: [contracts/present.md](contracts/present.md) (button, stage, steps, ribbon),
[DASHBOARD.md](DASHBOARD.md) (TV grid and density budget), [blocks.md](blocks.md) (visual building blocks),
issues #38 (layer editor), #93 (palette), #94 (colour by data), #95 (GIS styler), #96 (motion styles).
The four data dimensions in §3.2 come from the Urban Data Communication Decision Model (UDCDM) in Sanjay's
research notes (`interactive_map/theory`), updated here for 2.0.

---

## 1. The medium

MR Studio is a **physical 3D model of a place with a 2D projection from straight above**, plus three screens
around it: a **controller** beside the table, sometimes a **TV** across the room, and visitors' **phones**.

- **The 3D comes from the model, the data is 2D.** Buildings, terrain and streets are physically there, so
  height, massing and enclosure need no drawing. Data is designed in plan, from straight above. There is no
  virtual camera, tilt, extrusion or perspective for viewers. (Sanjay, 2026-11-23: the table is 2D top-down
  only.)
- **The projector knows the model.** The core holds a digital twin of the physical model and renders through
  the calibrated projector's real position (`ctx.model`, [contracts/model.md](contracts/model.md)), so plan
  data lands on the right roof and patch of ground, and layers can relight the model, colour buildings and
  spotlight a region. That is projection mapping onto the real 3D object, not a 3D view of it.
- **Light is the only ink.** A projector adds light and cannot make anything darker than the room makes the
  model. Black means "no light", which shows the bare model. Every colour mixes with the surface it lands on.
- **Data lands on the place.** Shadows fall on the real plaza, wind wraps the real block, a route runs along
  the real street. A visualisation is something that happens *to* the place, not a chart drawn over a map.
- **People stand around it.** A group at 0.6 to 1.5 m, standing, talking and pointing, from every side. They
  glance, follow movement and compare brightness. They do not read the table; they read the screens.

## 2. Why MR Studio and not a PowerPoint

A slide deck shows a *picture* of a place, and the audience rebuilds the place in their heads: which way is
north, how tall that block is, where the plaza is relative to the station, what the shadow on slide 4 means for
the street on slide 7. That rebuilding is effort, and everyone does it differently, so a group discussing a
deck is often discussing slightly different places.

The table removes the rebuilding. The place is in the room, at one scale, with one north, shared by everyone
around it. On top of that it does four things a deck cannot:

1. **Reveals the invisible in place.** Wind, sun hours, heat, sightlines, catchments and flows have no picture
   in reality. On the table they appear on the actual buildings that cause them.
2. **Shows change in place.** Time of day, a timetable, a scenario: the place stays put and the phenomenon
   moves over it, so cause and effect stay aligned. A deck shows before and after on two slides.
3. **Answers "what if" live.** A slider on the controller or phone changes the table at once (a detour limit, a
   threshold, a date). A deck can only show the cases someone prepared.
4. **Lets a group point.** People gather round, point at the same corner and argue about it. That shared,
   face-to-face spatial discussion is the main reason the table exists.

The other side of the same argument (the UDCDM "modality mismatch"): the table costs effort too (walking
round, orienting, learning conventions). When the content is a list, a table of numbers, text, a single chart
or a simple lookup that one person does alone, a deck, a web map or the TV is cheaper and better.

- **W1** **The PowerPoint test.** If a story loses nothing when turned into slides, it does not belong on the
  table. Put it on the controller, the TV, the phone, or in a deck.
- **W2** **Space must carry the meaning.** A table layer earns its place when the insight is *where*: what is
  next to what, what causes what nearby, how something moves through the place.
- **W3** **The slideshow is not a deck.** Slideshow steps (#43) are spatial: images, rasters and GeoJSON aligned
  to the model. Slides of text and charts go to the TV.

## 3. What data can be shown

Two questions classify any dataset. **What form is it?** (§3.1) decides which visual types are possible.
**What kind of phenomenon is it?** (§3.2, the four dimensions) decides how to animate it, how people interact
with it and how much it must be explained. Two more dimensions (§3.3) are new for the table.

### 3.1 Data forms and the visualisation types each supports

| Form | Examples | Visualisation types on the table | Blocks / layers today |
|---|---|---|---|
| **Point** | Stops, sensors, places, events | Spot with halo, glow, pulse or ripple rings, radiate lines to other points, attractor that draws a crowd, icon, appear on a step | `drawSpots`, `drawRings`, `drawGlow`, `pullTowards`; Cultural Gravity |
| **Line / route** | A walk, a transit line, a planned path | Bright line with dark casing, width or colour by value, dashes, draw-in reveal, travelling lights, particles flowing along it | `drawPaths`, `pathHeads`; CoolPaths routes |
| **Network** | Streets, footpaths, cycle lanes | Hierarchy by width and brightness, glow, flow particles that stay on the network, routing between places | `drawPaths`, `StreetNetwork` router (#96); CoolPaths sun exposure per edge |
| **Area** | Zones, plots, parks, catchments | Flat fill by category or value, outline, edge glow, hatch, fill like a vessel, pulse the outline | `drawAreas`; #94, #95 |
| **Field / raster** | Sun hours, wind speed, heat, noise, delay | Colour wash on the ground with a ramp, soft edges, threshold flag, contours, time scrub, lens | `ctx.map.addField`, `heatField`, `contours`, `Lens`; Sunlight, Wind, Mobility cells |
| **Buildings** (the model itself) | Energy use, age, solar potential | Light the roof by value or category, highlight, glow, fill like a vessel, x-ray lens, radiate lines | `drawAreas` on footprints; #38 "click a building" |
| **Moving things** | Trips, vehicles, agents, a crowd | Dots along their routes, coloured by group, ring while waiting, trails, particles | `Swarm`, `pathHeads`; Mobility, cars, transit |
| **Flow field** | Wind, water, pull of attractors | Particles that follow the field, speed by value | `followField`, `gravityField`; Wind |
| **Time series** (attached to any form above) | Hourly values, a timetable, phases | The same form changing with a clock; staged reveal by phase | `Sequence`, `glide`; Sunlight, Mobility |
| **Non-spatial** | KPIs, rankings, totals, text | **Not on the table.** Ribbon (a glance), controller, TV panel or phone | Dashboard widgets |

- **D1** **Height is never extruded.** A building's height is already in the model. A value that behaves like
  height (depth, density, demand) is lightness, a ramp or a soft drop shadow (#95).
- **D2** **A single file can be a layer** (#38). Dropping in any form above gives a default look from this table;
  the styler and motion panel refine it.

### 3.2 The four dimensions of a phenomenon

Each dimension answers one question and decides one part of the design. They hold for 2.0 with the updates
noted.

| Dimension | Values | Question | What it decides in MR Studio |
|---|---|---|---|
| **Visibility** | visible, invisible | Could you see it if you stood there? | **The visual language.** Visible things (shadow, traffic, trees) get iconic, realistic looks. Invisible things (wind, heat, sightlines, catchment) need an invented language, and are where the table is most valuable. |
| **Dynamism** | static, parametric, dynamic | Does it change, and on what timescale? | **The animation.** Static: context, no motion, toggled. Parametric: a control (time, threshold) and eased change (`glide`). Dynamic: continuous motion is the message (particles, agents). |
| **Agency** | observe, explore, manipulate | What can this person do, in this task? | **The interaction and its surface.** Observe: plays by itself, steps, attract loop. Explore: point or pick on the table, phone map. Manipulate: sliders and actions on the controller or phone. |
| **Abstraction** | concrete, processed, derived | How far is it from what you could observe? | **The explanation and where it lives.** Concrete needs a title. Processed needs a legend and a line of method. Derived (an index, a score) needs the method and its limits, on the controller info strip, the TV or the phone. Never on the table. |

Updates for 2.0:

- **Agency is per surface now.** Opening a layer is shared (the table changes for everyone); controls on a
  phone are personal until applied. Hand tracking is out of 2.0; table touch and tangibles are future inputs.
- **Explanation has a home.** The presentation contract gives each layer a legend and an info strip
  (present.md §2), so the abstraction level maps directly to how much goes there.
- **Sound is a channel we do not use yet.** The UDCDM finding stands: sound is most valuable for invisible,
  dynamic phenomena (wind, water), and ecological sounds (wind sounds like wind) need no learning. 2.0 has no
  audio; it is a candidate for later, not a default.

### 3.3 Two dimensions the table adds

| Dimension | Values | Question | What it decides |
|---|---|---|---|
| **Form** | point, line, network, area, field, buildings, moving things, non-spatial | What geometry is the data? | Which visualisation types are possible (§3.1), and the first step of the layer editor (#38). |
| **Placement** | ground, roofs, network, margin (ribbon), off-table | Where does it land on the physical model? | Whether it competes with the model (roofs vs ground, E4), whether it is on the map or in a ribbon, and whether it belongs on the table at all (W1). |

### 3.4 Recipes

How common profiles turn into a design, with the 2.0 layer that shows it.

| Profile | Table | Interaction | Explanation | Example |
|---|---|---|---|---|
| Visible · parametric · manipulate · processed | Realistic light and shade, eased with time | Date and time on controller or phone | Low: legend | Sunlight |
| Invisible · dynamic · observe · processed | Particles in a field, colour by speed | Toggle, a few presets | Medium: what was simulated | Wind |
| Invisible · parametric · explore · processed | Two routes compared, walkers set off together | Pick ends of the walk, detour limit | Medium: what "cool" means | CoolPaths |
| Visible · dynamic · observe · concrete | Dots along routes by group, waits as rings | Play, scrub | Low: groups in the legend | Mobility |
| Invisible · parametric · explore · derived | Crowd drawn to places along streets | Weights, places on the phone | High: what pulls, and why | Cultural Gravity (#96) |
| Visible · static · observe · concrete | Quiet base: buildings, trees, streets, ambient traffic | None | None | Home screen, basemap |
| Any · stepped story | One reveal per step, legend highlights it | ◀ ▶ on any surface | Info strip per step | Slideshow (#43) |

## 4. The surfaces: what goes where

| Surface | For | What goes there | What never goes there |
|---|---|---|---|
| **Table map** | Seeing the place change | Fields, routes, flows, particles, rings, highlights; very short place labels pinned to the place | Paragraphs, legends, step counters, controls, numbers with units |
| **Ribbon** (blank projector margin, on the flat table top) | A glance without leaving the table | One stat, one small chart, a time bar, the join QR (present.md §4), on the front edge (S5) | Paragraphs, more than about 3 reads, anything important on the far edge |
| **Controller** | Choosing and explaining | Layer rails, the stage (hero, controls, legend, info strip), ◀ ▶, the attract loop | Anything that only makes sense without looking at the table |
| **TV** | The room's shared summary | Panels on the 12 × 6 grid under the density budget (DASHBOARD.md) | Tables, pie charts, documents, anything over budget |
| **Phone** | Personal depth and input | Controls, votes, longer text, a visitor's own place or route | Things everyone needs to see at once |

- **S1** If it is a word, it goes on a screen. The table may carry a label only when the label *is* a place (a
  destination, a stop), at most about three words, and only a handful at once.
- **S2** Every colour on the table has its swatch in the controller legend, from the same palette slot.
  `ctx.legend.highlight` marks the item just revealed.
- **S3** Keep live feedback on the table, next to its cause. Moving a walker's end point changes the route on the
  table, not a chart on the TV. The TV summarises once a scenario is set.
- **S4** The home screen (no layer open) is ambient: slow, dim, wordless. Opening a layer dims ambient layers
  so the open one owns the light.
- **S5** **At-a-glance information goes on the front edge.** Ribbons are projected onto the flat table top
  around the model, by design, not onto the model. A viewer standing at one end of a table-height model cannot
  see a ribbon at the far end: the model hides it. Headline numbers (for example ECOM KPIs) go in the ribbon
  nearest the viewers' usual side, the front, usually the controller side. Side and far ribbons only repeat
  or add to it. (Learned 2026-11-23.)

## 5. Drawing on a projected model

- **E1** **2D only.** No extrusion, tilt or perspective (D1).
- **E2** **Fields under, vectors over.** Rasters sit on the ground under building outlines; lines, points and
  particles sit above on the layer's decoration.
- **E3** **Leave the model visible.** Fields are slightly translucent (Sunlight uses alpha 236/255) so the
  physical texture reads through the light.
- **E4** **Decide what the roofs do.** Light lands on roofs as well as the ground. Each layer decides whether
  roofs carry data (sun on roofs, building energy) or stay dark so ground data reads. With a calibrated
  projector this is explicit: `ctx.model.addField(…, { on: ['ground'] })` or `['ground', 'roof']`. Walls are
  only reached by an off-axis or second projector, so wall data is a bonus, never the only carrier.
- **E7** **Use the model as a display.** Relighting (`addLight`), colouring buildings (`setMaterial`) and
  spotlighting a region (`focus`) use the physical object itself and are often stronger than drawing over it.
  Everything must still read on a flat table (model.md rule 3).
- **E5** **Minimum sizes, in table cm** (*start*; sizes are in cm and the calibration turns them into px):
  line 2 mm, an important route 4 mm, casing 1.5 mm each side; point radius 4 mm, a point that must be found
  8 mm with a halo; label cap height 8 mm, never under 5 mm; smallest field feature worth showing about 1 cm.
- **E6** **One focus per step.** If the field is the story, lines are quiet; if the route is the story, the field
  dims.

## 6. Colour

- **C1** **Dark ground.** The base is dark so data is the light. Light basemaps (#37) are for the TV, editor
  previews and bright rooms.
- **C2** **Lightness carries value.** Sequential ramps rise in lightness from dark to bright (`colormaps.sun`,
  `sunHoursColormap`). Projector and material shift hue but keep lightness order. Never rely on telling two
  dark hues apart.
- **C3** **Brightness is attention.** The brightest thing on the table is the thing being discussed. White
  (`#f8fafc`) is kept for the focus: the walker, the chosen route, the item just revealed.
- **C4** **Reserved meanings**, shared by every layer: warm (amber to cream) is sun, heat and energy; cool (blue
  to violet) is shade, cold and night; green (`rgb(45 205 140)`) is vegetation and its shade; red
  (`rgb(226 54 76)`) is a failed threshold or warning, used sparingly; white is focus.
- **C5** **At most six categories at once.** More are grouped as "others" or revealed in steps.
- **C6** **Diverging ramps need a real midpoint** (zero, a target, today), and its colour must still be lit, or
  the middle of the data vanishes into the model.
- **C7** **Casing, not saturation.** A bright line over a busy field gets a dark casing (`#0b0e14`, as CoolPaths
  and Mobility do).
- **C8** **One palette** (#93). Layers and the styler refer to palette slots (accent, warm, cool, neutral,
  categorical 1–8, named ramps), not raw hex. The same palette drives the table, the controller legend and
  `tv.theme`, so changing it recolours everything. The picker warns when a colour is too dark to project.
- **C9** **Colour by data on import** (#94): categorical (a slot per value, "others" grouped) or numeric
  (sequential or diverging; equal, quantile, natural breaks or custom classes). It becomes the dataset's
  default style and legend.

## 7. Motion

Motion is the strongest channel on the table: people see it from across the room, so it is the easiest to
abuse. It is how Dynamism (§3.2) is drawn.

- **M1** **Motion means something**: flow, time, change, or attention to something new. Only the ambient home
  screen moves to feel alive, and it is slow and dim.
- **M2** **One kind of motion in focus.** Particles *or* pulsing points *or* a playing clock at full strength. A
  second motion is quieter (lower alpha, slower).
- **M3** **Speed has a meaning.** If particles show flow, speed follows the value. If it is constant, the legend
  says so.
- **M4** **Every change eases.** Results glide in, reveals draw in or fade, layers cross-fade. Timings (*start*):
  reveal 0.6–1.2 s, cross-fade 0.8 s, auto sub-step 1.4 s (Chalmers demo), pulse period 1.5–2.5 s.
- **M5** **No flashing.** Nothing blinks faster than once a second; large areas never strobe.
- **M6** **Time shows as a clock.** When the table plays through time, the controller and ribbon show the time
  and the span played, and the table never jumps back without a visible reset.
- **M7** **Reveal order tells the story.** Sub-steps reveal in the order of the explanation, and each lights its
  legend item (present.md §3).
- **M8** **Motion follows the place.** People and vehicles move on the network, not across buildings (#96
  routed gravity). Free particles are for air, water, attention and abstract forces.
- **M9** **Cue a remote change at its place.** When an action on the controller, TV or a phone changes what is
  on the table (add a building, add an EV charger), people are looking at the screen and do not know where to
  look next. Mark the change on the table with one bright, very visible burst at the spot (a flare and rings
  travelling out, about 1–1.5 s, *start*) that settles into the item's normal style. For its duration it is the
  brightest thing on the table (C3). It is one burst, not a blink (M5). Changes made by a pointer on the table
  need no cue, because people are already looking there. The block is #105. (Learned from ECOM, 2026-11-23.)

## 8. The layer model and its building blocks

A layer is **data + animation + interaction** (#38); a slideshow is a sequence of layers (#43). Every look is
assembled from shared blocks and palette slots, so a no-code author can make it and a table looks like one
piece.

| Part | What it is | Authored in |
|---|---|---|
| Data | One file or dataset, of a form in §3.1 | Import (#71), colour by data (#94) |
| Look | Fill, stroke, width, glow, dashes, halo, radius, ramp | GIS styler (#95) |
| Motion | Reveal and transition; pulse, flow, particles, attractors, gravity | Motion panel (#96) |
| Interaction | Table pick, controller or phone controls, steps | Controls, steps (present.md) |
| Presentation | Button, legend, hero, ribbon | Controller page (#54) |

- **L1** **Verbs fit the form.** The editor offers the visualisation types from §3.1 for the chosen form.
- **L2** **Every style property is fixed, by a column, or by time.** That one rule is the whole styler.
- **L3** **Presets are starting points**: "glowing points", "flow lines", "calm zones", "crowd to places",
  "commuter flows", "pulse from a hub".
- **L4** **Code layers obey the same rules.** Sunlight, Wind, CoolPaths and Mobility compute their data with a
  kernel but use the same palette, legend, steps and motion rules, so they can be slideshow steps too.

## 9. Theory in the code

Where each idea above lives in the core today, and what is missing. Gaps marked **proposal** are not filed yet.

| Idea | In the code now | Gap |
|---|---|---|
| **Form** (§3.1) | Readers `geojsonPoints/Lines/Polygons`, `siteRaster`, `readSiteData`; draw blocks per form (`drawSpots`, `drawPaths`, `drawAreas`, fields); tools are `point`, `line`, `polygon` | Site `data` entries are bare paths, so nothing knows a dataset's form until a layer reads it. Format 3 data objects with a `kind` (#70, #71) fix this and let the editor offer verbs by form (L1). |
| **Placement** (§3.3) | `ctx.map` fields under outlines, canvases and drawings above; `ctx.model.addField` with `on: ground/roof/wall`; `setMaterial`, `focus`, `pick` on buildings | Ribbons are not built (#78). `ctx.map.addElement` is drawn flat and does not follow the model (model.md rule 5), so anything placed on a surface must use `ctx.model` or a field. |
| **Visibility** | Implicit: Sunlight relights the model (iconic); Wind invents particles | Nothing records it. **Proposal:** an optional manifest `profile: { visibility, dynamism, agency, abstraction }` so the editor can pick default looks, motion and explanation, and the checklist can be run automatically. |
| **Dynamism** | `glide` and `soften` on fields; `onFrame`; `Sequence`/`stagger` for staged builds; flow overlay (`ribbons`, `particles`); `timeline` and `series` widgets | `layer.step` and the steps model are proposed, not built (present.md §3). No shared transition between layers yet (M4 cross-fade). |
| **Agency** | Controls (`range`, `select`, `toggle`, `date`, `color`, `text`, `action`) with a `phone` flag; spatial `tools`; `TablePointer` from mouse, touch, pen, phone or token; `Agent`, `Lens`, `Probe`, `Dwell` | Phone edits go straight to shared params, so "personal focus, then apply" from the theory is only partly there. No table touch hardware yet. |
| **Abstraction** | `description` on the manifest and button; legend and info strip (with `source`) proposed in present.md | No place for method and limits. **Proposal:** an `explain: { method, source, limits }` block in the manifest, shown on the info strip, TV `text` panel or phone, with the amount required by the abstraction level. |
| **Layer roles** | `category`: `base`, `ambient`, `analysis`, `media`; `alongside`; per-layer `intensity` 0–2 (`layer.intensity`) | S4 (ambient dims when a layer opens) is manual: intensity exists, but nothing lowers ambient layers automatically. |
| **Colour** (§6) | Named ramps in `colormaps` (`daylight`, `sun`, `speed`); Sunlight's own ramps in `look.ts`; `color` control. Site `palette` with slots and ramps (`palette.ts`), used by custom layers and the builder's picker, which warns below lightness 45 | Core layers still hard-code hex (CoolPaths `#34d399`, Mobility groups) and do not follow the palette yet (#93). `daylight`, `sun` and `sunHoursColormap` overlap and should become one palette's named ramps. |
| **Sizes** (E5) | `CanvasOverlay.pixelsPerMetre`, `DrawingOverlay.scale`, table `width_cm` in `SiteInfo`; `metresPerTableMm(site)`, which custom layers use for every size | Core layers still size in px or metres. |
| **Density on the TV** | `@mrstudio/dashboard` validators: grid, sizes, read budget | None; this is the one part where the rules are already code. The table has no equivalent check yet (S1 text, C5 category count). |

## 10. The bar: the sun study

The sun study must be glorious, and other layers should feel at home next to it. What it does:

- **Physically motivated colour.** Lit ground takes the colour of the sun at its altitude (pale at noon, amber
  when low); shade takes the colour of the sky (blue at noon, violet at dusk, night below the horizon).
- **A warm rim.** The penumbra leans warm, like light bouncing into a shadow's edge, and `soften` blurs it.
- **Its own colour for trees**, so tree shade reads apart from building shade.
- **Smooth time.** `glide` eases each frame in, so scrubbing the day feels like the sun moving.
- **Rules as flags.** A threshold turns the failing area one flat red and keeps the ramp above it.
- **Words elsewhere.** Sky hero, time, date and legend sit on the controller and TV.

## 11. Checklist and open questions

Before a layer or look ships:

1. Does it pass the PowerPoint test (W1)? Is the insight about *where* (W2)?
2. With no one explaining, can a visitor tell what is happening on the table in five seconds?
3. Is there any text on the table that is not a place name (S1)?
4. Does every table colour have a legend swatch from a palette slot (S2, C8)?
5. Is the brightest thing the thing being discussed (C3)? Does value read by lightness alone (C2)?
6. Does each motion mean something, with one in focus (M1, M2)? Does every change ease (M4)?
7. Does everything read from straight above (E1)? Are sizes at least E5?
8. Does the explanation match its abstraction level, on the right surface (§3.2)?
9. Has it been seen on a real table? Log what was learned below.

To test on the table: E5 sizes and M4 timings; how much the model's material tints projected colour and
whether ramps need a per-site correction; whether roofs should carry data by default (E4); how dark the base can
go before the model disappears in a lit room; how many moving things a group can follow; whether pinned labels
are read at all, and from which side.

## 12. Learnings from the table

Newest first. Each entry says where and what was shown, what we saw, and which rule it changed or confirmed.
Change the rule in the same PR.

```
### YYYY-MM-DD · Site, table size, projector
- Seen: …
- Rule: E5 changed from … to … (or: confirms C2)
```

### 2026-11-23 · Attention cue for remote changes (from the ECOM layer)

- Seen: when an action on the dashboard or controller places something on the table (add a building, add an
  EV), attention is split between the screen and the table, and people do not know what will change or where.
  ECOM's bright, very visible animation at the change brings their attention back to the table.
- Rule: new M9. Follow-up: a reusable attention-cue block, played automatically on remote actions (#105).

### 2026-11-23 · Ribbon placement on a table-height model

- Seen: with the table at table height and a viewer standing at one end, panels and bars in the far margin are
  projected onto the flat table top (as designed), but the model stands between them and the viewer, so they
  are hidden.
- Rule: new S5. At-a-glance information, such as ECOM KPIs, goes in the front ribbon, nearest the viewer.
  Follow-up for present.md §4 (#78): a table setting for which edge is the front, so a layer's ribbon lands
  there by default.

### 2026-11-23 · Document started

- No table sessions logged yet; every *start* value is untested. First to check: E5 sizes, M4 timings, C2 ramps
  under projector light, and the sun study's colours on the real model.
- Carried over from the Chalmers demo and the UDCDM notes, not yet re-tested in 2.0: live feedback belongs on
  the table next to its cause (S3); a TV is most useful after a scenario is set, not during exploration;
  separating personal phone controls from the shared table lets people work in parallel.
