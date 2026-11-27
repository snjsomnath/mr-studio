# Presentation contract

Status: **mostly built** (proposed 2026-11-23, reviewed 2026-11-27). The site.json fields are in site format 3 (#70): `button.group`, `button.order`, `steps` (with `sequence`) and `table.ribbons` are stored, validated and sent to surfaces. Each part marked built is in the app; anything not marked is still a proposal.

MR Studio has three surfaces for visitors: the **controller** beside the table, the **table** (the projected map) and the **phones**. The map is clean and mostly visual. Words and controls live on the controller and the phones. This contract is the one vocabulary they all read, so that each new feature is something every layer fills in, not a screen built by hand for one site. It comes from the Chalmers campus demo controller (`Nodal-Works/interactive_map`), reviewed in #74–#78 and #43.

There are four parts: **button**, **stage**, **steps** and **ribbon**. A layer package gives the defaults in `layer.json`. A table can override them per layer instance in `site.json` (`layers[]`). The editor's Controller page (#54) previews and edits the overrides.

## 1. Button: where and how a layer is offered

```jsonc
// layer.json (defaults)                          // site.json layers[] (per table)
"icon": "sun",                                    "button": {
"attract": { "effect": "sun" },                     "name": "Sun study", "description": "…",
                                                    "icon": "sun", "side": "left",
                                                    "group": "Simulations",       // new
                                                    "order": 2                    // new
                                                  }
```

- **Rails** (#75): buttons run down the left and right of the controller, grouped by `group` (a gap and an optional small label between groups) and ordered by `order`. If no side is set, the left fills first, then the right, a group at a time. An empty rail collapses.
- **Rail style** (`tv.rail_style`, built): `icons` (square icon buttons with a short name under them, the default) or `labelled` (icon and name side by side, in a wider rail).
- **Attract** (#74): with no layer open, the controller loops through the scene's buttons. It shows the big title and the layer's name and description, over the layer's `attract.effect`: one of `wind`, `rain`, `sun`, `sightlines`, `grid`, `waves`, `particles` or `default`. When `attract` is missing, the effect defaults by category. **Built (2026-11-23):** a stop every `tv.attract_s` seconds (default 4), in rail order, with `tv.about` credits along the foot; nothing on the rails lights up. The core layers name their effects in layer.json. **Idle reset (built):** after `tv.idle_reset_s` seconds with nobody doing anything on any surface (default 180, 0 for never) the table goes home as Reset does. The host keeps one timer for the whole table, and only while a controller is connected (#604): any change from a controller, the editor, a phone or the guide counts, and so does a touch, click, key or wheel on any screen, including the table (each screen sends `session.input`, at most every 5 s). `/tv?idle=N` gives one screen a spell of its own, counting only its own touches (Rehearse's quick try).
- Action buttons (dashed, built), at the foot of the rail the buttons start on, in the Chalmers demo's groups (#198). They come from core, not from layers.
  - **Map controls:** **Reset view** puts the table back the way site.json starts it (host request `layers.reset`): opened layers go off, the map at rest comes back on, every layer gets its saved params again, and the About page closes, so the controller shows its welcome. The table then plays its opening zoom again (host event `table.intro`, #446). **Full screen** puts the table's window in or out of full screen in the app (shell action `/__shell/fullscreen`); in a browser it toggles the controller's own page, as the demo did. **Calibrate** opens the projector calibration on the table (`calibration.mode`) and closes it again; it shows pressed while the tool is open, and closing the tool on the table releases it. While it is open the centre is the calibration panel (#594): the corner to find on a plan, a nudge pad, Back, Skip, Next and Save; the table shows only the cross. `tv.map_controls: false` leaves only a **Reset** button, for a table visitors run alone.
  - **About:** **Credits** opens a page in the centre from `tv.about`: logos (`logos`, else `branding.logo`), title, text and credits. It is only there when the site sets `tv.about`.
  - The idle reset (#74) does what Reset view does after a quiet spell.
- One layer is open at a time. `alongside` layers (built) may join it, and only then do order badges show.

## 2. Stage: the controller centre for the open layer

A fixed template with five zones (#76, #283). The layer fills them as data:

| Zone | From | Notes |
|---|---|---|
| **Hero** | the one entry in `panels` with `"hero": true` | Large, at the top, optional. Sunlight's is the new `sky` widget. |
| **Stage** | the module's `stage(ctx, el)`, with `"stage": "custom"` in layer.json | Optional: a layer's own app in the centre, such as a map to choose on (#283). Takes most of the centre's height; the generated controls follow. Or `"stage": { "panels": [...] }`, a layout of dashboard panels with no code (#357). |
| **Controls** | `controls` (built) | Bigger and fewer per row. `action` controls marked `"primary": true` become large buttons. |
| **Legend** | `legend` in layer.json, or `ctx.legend` at run time | Swatch, label and optional value id. It follows the table (see Steps). |
| **Info strip** | the current step | Step counter, title, one line of description, source. |

```ts
// SDK, new
ctx.legend.set(items: { id: string; label: string; color?: string; shape?: 'line' | 'fill' | 'point' }[]);
ctx.legend.highlight(id: string | null);   // the one just revealed on the table
ctx.legend.show(ids: string[] | 'all');    // cumulative reveals show only what is on the table
```

The remaining `panels` (built) are laid out under the zones, as today.

**Built (legend and controls, 2026-11-23):** the legend zone shows `ctx.legend` rows (sent with the layer's published values as `shared.legend`, with `legend_highlight` and `legend_shown`), else `legend` from layer.json. A slideshow shows the legend of the layer on show. Rows named like the layer's sub-step titles follow the reveal on their own: rows still to come are faint, the one just revealed is marked, and the strip's row of names steps aside. An `action` control with `"tier": "primary"` (this is the contract's `"primary": true`) is one large accent button at the top of the stage. Every core layer's controls are tiered: the one thing a visitor does is primary, a few direct settings stay in the row, and the author's settings (datasets, service addresses, colours, opacity) wait behind More settings. `"tier": "state"` is never shown anywhere: a value the layer keeps in its params so every surface shares it, such as where a video is and whether it plays (#194).

**Built (heroes):** Sunlight's sky (#137), Wind's compass (#76), and Cool paths' and Mobility's timelines (#76, the SDK's `timelineHero`: a backdrop, a big readout, up to three facts and a band with ▶; Home and End jump to the ends): a dial turned as the table is, its knob on the side the wind comes from, over streaks that blow the way the wind does; the band at its foot is the speed. Both are dragged, tapped or worked with the keys (← → and Page Up/Down).

## 3. Steps: one model for "Next"

**Built (#43, 2026-11-23):** `layer.step`, `layer.play` and `layer.substeps` on the host, `state.step` and `state.shown_by`, `ctx.steps` in the SDK, and the editor's Slides list. The live position is `state.step`, because `state.steps` holds the site.json settings. Details are in [session.md](session.md), Steps. The controller's ◀ ▶ and counter come with the stage (#76).

**Built (controller, 2026-11-23):** a layer with `state.step` gets a step strip in the centre: ◀, play or pause and ▶ (`layer.step`, `layer.play`), the counter, the step's title (or the shown layer's name), its line and its source, and the sub-steps as a row of names with the current one marked. ← and → (and Page Up and Page Down, for a clicker) move the open layer's steps, and Shift+→ skips. A layer a slideshow shows (`shown_by`) is part of the slideshow: its button gets a dashed ring instead of being pressed, it is not a second open layer, Reset and opening another layer close the slideshow and the host takes the shown layer off with it, and pressing its own button takes it out of the slideshow, which closes. A slideshow made of layers hides its old slide controls and its panel.

Slideshow slides, category reveals and staged builds (the Campus Vision phases) are all **steps**. Every advance input sends the same host request, so all of them behave the same: the controller's ◀ ▶, phone buttons, keyboard arrows, a presentation clicker and an optional tap on the table.

```
layer.step { layer, to: "next" | "previous" | "first" | "skip" | "all" | number }   // host request
layer.play { layer, playing }
state.step = { index, count, sub?: { index, count }, playing, title?, description?, source?, titles? }
```

A layer that has steps declares how it moves through them:

```jsonc
"steps": {
  "mode": "manual",            // manual | timed. The Chalmers slideshow is manual.
  "loop": true,                // after the last step, back to the first
  "reveal": "then-next"        // after a step's last sub-step, Next "stop"s or moves on ("then-next", the default)
}
```

- **Sub-steps** reveal parts of one step: the categories of an attribute, or the elements of a staged build. Next moves to the next sub-step, and its legend item is highlighted. When the sub-steps are done, `reveal` decides whether Next stops or moves on to the next step. Shift+→ or a long press always skips to the next step.
- **Auto** plays the sub-steps at a set interval (1.4 s in the demo), or each one when its animation ends (staged builds), and stops at the end.
- **Timed** mode moves on after each step's `duration_s`, but never while sub-steps are still to come.
- The slideshow template (#43) stores its steps as references to other layer instances (format 3 sequences, #70), each with its transition, duration and "Next behaviour".
- The step counter, legend and Retry go on the controller, never on the table.

## 4. Ribbon: the projector's blank space

**Built (#78).** Most projectors light more than the model. The table surface works out the free band on each side from where the model lands (through the projector calibration when there is one, otherwise where the flat map draws the extent) and `table.width_cm/height_cm`, which turn cm into pixels.

```jsonc
// site.json, table settings (#73)
"table": { "width_cm": 100, "height_cm": 60, "front": "bottom",
  "ribbons": { "bottom": { "cm": 9 }, "top": "auto", "left": "off", "right": "off" } }
```

- `table.front` (default `"bottom"`) is the edge where visitors stand. Without `table.ribbons`, the front edge is on `"auto"` and the other sides are off.
- `"auto"` takes 9 cm (the Chalmers demo's default) or less, and only if at least 4 cm is free. `{ "cm": n }` takes n cm, cut to the free space. 0.5 cm is kept clear between the model's edge and the ribbon. Sides are filled in the order front, the two beside it, the far side.
- A ribbon runs along the model's edge and is turned to read from its own edge, so the front one faces the front viewer and a side one faces whoever stands at that side. Every ribbon shows the same content.
- What a ribbon shows comes from the layer: `panels` entries marked `"ribbon": true` (`chip`, `tile` or `wide`; at most 4 panels and 10 reads), drawn with the dashboard widgets and the site's theme in a strip. A ribbon panel is on the table only, never on the TV. Sunlight's are the example: time, sun height or daylight, and the colour key.
- One ribbon is shown at a time: that of the layer turned on last that has ribbon panels (Auto). When more than one open layer has ribbon panels, the controller shows a **Ribbon** button under Map controls; each press moves on from Auto to each of those layers and back (#231). The choice is the session's `ribbon` (host request `session.ribbon {layer}`, null for Auto, from the controller, the dev page or the guide's phone) and goes back to Auto when that layer closes. While the controller is at home (no layer open but the map at rest and tools kept alongside, as for the home screen, #74), the core **join QR** ribbon shows if phones can join: the QR and the session code.
- The editor and `/dev` keep room beside the map for the ribbons and preview them there at their size, with the front edge marked in amber.
- **The front edge comes first** (learned on the table, 2026-11-23, [visualisation.md](../visualisation.md) S5). A viewer at one end of a table-height model cannot see a ribbon on the far edge, because the model hides it.
- Ribbons are outside the model, so they don't break the "clean map" rule. Keep them glanceable (numbers, small charts, a QR), never paragraphs.
- `front` and the ribbons are edited in Table size and place, "where visitors stand" (host request `site.table`, session.md; #62, #78).

## Ambient glow

**Built (#476).** The projector's blank space around the model can glow softly in the model's own colours, as the lights behind some televisions do.

```jsonc
"table": { "width_cm": 100, "height_cm": 60, "glow": { "on": true, "strength": 0.5, "colours": "edges" } }
```

- `table.glow` is off when it is missing or `on` is false. `strength` (0 to 1, default 0.5) is how bright it is at the model's edge. `colours` is `"edges"` (each edge glows in the colours along it, the default) or `"one"` (the whole margin in the model's dominant colour). It is set in the editor under Design › Table size and place, beside the ribbons.
- Four times a second the table copies its own picture at 96 pixels across and reads the colours just inside each edge, in 10 steps. Vivid and bright colours count most, so a yellow layer over a dark base map gives a yellow glow; a dim colour is lifted towards full brightness, keeping its hue, while a nearly black edge stays dim.
- The glow is painted on a canvas a tenth of the surface's size, which the browser stretches smooth: each pixel outside the model takes the colour of the nearest point on its edge and fades with distance, to about a tenth 14 cm out. There is no blur filter (WebKit draws those slowly, #181). Colours ease to new ones over about a second, and the glow fades in and out the same way.
- It fills the whole blank space; the ribbons stay on top of it. Over the model nothing is painted.
- A layer can change it while it is on with `ctx.map.setGlow('off' | '#rrggbb' | null)`: off, a fixed colour, or back to the model's own. The layer turned on most recently that asked wins.
- The editor previews it in the room it keeps beside the map for the ribbons.

## Settings (per #73)

- **Table settings** (`site.json`): rail style, groups, welcome title, logos, credits, idle reset (the time with no input before the controller goes home, default 3 minutes), the attract order and step length, and ribbons.
- **App settings** (this computer): Controller size per display. It sets `--mrs-ui-scale`. The controller already scales with the screen (built, #77).

## Build order

1. Scale `/tv` with the screen (#77, built). Remove the Home button and the operator text (#50, #74).
2. This contract goes into the format 3 design (#70): `button.group/order`, `attract`, `legend`, `hero`/`ribbon` on panels, `steps`, `table.ribbons`.
3. Rails with groups (#75).
4. `layer.step`, `ctx.legend` and the stage template (#76), then the slideshow and its Next behaviour on top (#43).
5. The attract loop on the home screen (#74).
6. Ribbons (#78, built).
7. The editor's Controller page previews and edits all of it (#54).
