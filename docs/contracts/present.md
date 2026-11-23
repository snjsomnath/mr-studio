# Presentation contract

Status: **proposed** (2026-11-23). The site.json fields are in site format 3 (#70): `button.group`, `button.order`, `steps` (with `sequence`) and `table.ribbons` are stored, validated and sent to surfaces. Nothing else here is built yet except where marked.

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
- **Attract** (#74): with no layer open, the controller loops through the scene's buttons. It shows the big title and the layer's name and description, over the layer's `attract.effect`: one of `wind`, `rain`, `sun`, `sightlines`, `grid`, `waves`, `particles` or `default`. When `attract` is missing, the effect defaults by category.
- Action buttons (dashed, built): **Reset** and **About**, at the foot of the rail the buttons start on. They come from core, not from layers. Reset closes the open layer and the About page, so the controller shows its welcome; tools kept `alongside` (the phones' sketch) stay on. About opens a page in the centre from `tv.about` (title, text, credits) and is only there when the site sets it. The demo's "reset view" moved the map back; the table's map does not move, so Reset is the visitor's way home. The idle reset (#74) will do the same after a quiet spell.
- One layer is open at a time. `alongside` layers (built) may join it, and only then do order badges show.

## 2. Stage: the controller centre for the open layer

A fixed template with four zones (#76). The layer fills them as data:

| Zone | From | Notes |
|---|---|---|
| **Hero** | the one entry in `panels` with `"hero": true` | Large, at the top, optional. Sunlight's is the new `sky` widget. |
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

**Built (legend and controls, 2026-11-23):** the legend zone shows `ctx.legend` rows (sent with the layer's published values as `shared.legend`, with `legend_highlight` and `legend_shown`), else `legend` from layer.json. A slideshow shows the legend of the layer on show. Rows named like the layer's sub-step titles follow the reveal on their own: rows still to come are faint, the one just revealed is marked, and the strip's row of names steps aside. An `action` control with `"tier": "primary"` (this is the contract's `"primary": true`) is one large accent button at the top of the stage. Every core layer's controls are tiered: the one thing a visitor does is primary, a few direct settings stay in the row, and the author's settings (datasets, service addresses, colours, opacity) wait behind More settings.

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

Most projectors light more than the model. The table surface works out the free band on each side from the calibration and `table.width_cm/height_cm` (#78).

```jsonc
// site.json, table settings (#73)
"table": { "width_cm": 100, "height_cm": 60,
  "ribbons": { "bottom": { "cm": 9 }, "top": "auto", "left": "off", "right": "off" } }
```

- `table.front` (site format 3; default `"bottom"`) is the edge where visitors stand. `"auto"` prefers the front, then the two sides next to it, and uses the far side last, because the model hides the far side from a viewer at the front.
- A side is used only if it has at least about 4 cm free. Sizes are in cm and turned into px through the calibration.
- What a ribbon shows comes from the layer: `panels` entries marked `"ribbon": true`, drawn with the dashboard widgets in a strip layout. With no layer open, the core **join QR** ribbon shows if phones can join.
- One ribbon is shown at a time: the open layer's, otherwise the home ribbon. If more than one is available, the operator can pick on the controller.
- **The front edge comes first** (learned on the table, 2026-11-23, [visualisation.md](../visualisation.md) S5). A viewer at one end of a table-height model cannot see a ribbon on the far edge, because the model hides it. A table setting names the front edge (proposed: `table.front`, default `bottom`), and a layer's at-a-glance ribbon goes there.
- Ribbons are outside the model, so they don't break the "clean map" rule. Keep them glanceable (numbers, small charts, a QR), never paragraphs.

## Settings (per #73)

- **Table settings** (`site.json`): rail style, groups, welcome title, logos, credits, idle reset (the time with no input before the controller goes home, default 3 minutes), the attract order and step length, and ribbons.
- **App settings** (this computer): Controller size per display. It sets `--mrs-ui-scale`. The controller already scales with the screen (built, #77).

## Build order

1. Scale `/tv` with the screen (#77, built). Remove the Home button and the operator text (#50, #74).
2. This contract goes into the format 3 design (#70): `button.group/order`, `attract`, `legend`, `hero`/`ribbon` on panels, `steps`, `table.ribbons`.
3. Rails with groups (#75).
4. `layer.step`, `ctx.legend` and the stage template (#76), then the slideshow and its Next behaviour on top (#43).
5. The attract loop on the home screen (#74).
6. Ribbons (#78).
7. The editor's Controller page previews and edits all of it (#54).
