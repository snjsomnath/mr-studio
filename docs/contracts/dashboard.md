# Dashboard contract

The TV's dashboard canvas: what a panel is, how layers and sites supply panels, and the API of `@mrstudio/dashboard`.
The reasoning and the full tables of rules are in [../DASHBOARD.md](../DASHBOARD.md). The numbers live in `packages/dashboard/src/rules.ts`.

## Panel

```ts
interface PanelSpec {
  id: string;                      // lower-case letters, digits, dashes; unique in its layer or page
  widget: string;                  // stat | gauge | bars | list | donut | compare | balance | control | map | media | legend | series | ramp | timeline | text | custom, or a team's <layer>/<type>
  size: PanelSize;                 // chip | tile | wide | tall | block | hero | band | strip
  title: string;                   // required, at most 28 characters
  props?: Record<string, unknown>; // per the widget's schema; literals or bindings
  visibleWhen?: Record<string, unknown>;   // as for controls, against the layer's params
  priority?: number;               // automatic layout: higher is placed first
  ribbon?: boolean;                // on the table's ribbon instead of the TV (#78): chip, tile or wide only, at most 4 panels and 10 reads; see present.md, Ribbon
  at?: { col: number; row: number };       // site pages only, 1-based
  layer?: string;                  // site pages only: whose params and shared values the bindings read
}

type Binding = { bind: string };   // params.<control> | shared.<key> | site.<field>
```

A panel is plain JSON. Unknown fields and unknown props are errors.

## Where panels come from

**Layers** list panels in `layer.json` under `panels` (see [layer.md](layer.md)). They may not set `at` or `layer`. While the layer is on, its panels are laid out automatically.
A layer that has a `panel` function but no `panels` gets one `custom` tile.

**Sites** may set `tv` in `site.json`:

```jsonc
"tv": {
  "rail": "left",                  // left | right | none. The side a layer's button sits on unless the layer says otherwise; none hides the buttons
  "rail_style": "icons",           // icons (square icon, short name under it; default) | labelled (icon and name side by side, wider rail)
  "about": {                       // optional: the controller's About button and page. Without it there is no About button
    "title": "About this table", "text": "A few lines on what the table is.",
    "logos": [ { "path": "media/logo.png", "name": "Who it stands for" } ],   // site-relative images; default branding.logo
    "credits": [ { "role": "Development lead", "name": "…", "note": "optional line" } ]
  },
  "map_controls": true,            // Reset view, Full screen and Calibrate on the controller (default); false leaves Reset alone
  "phone_switch": true,            // visitors' phones turn layers on and off (default; never while a slideshow shows); false: phones only change controls (#335)
  "two_layers": true,              // hold a layer button (or Shift-click) to add it to the open one, two at most (default); false: one at a time (#473)
  "theme": { "color.accent": "#c2410c", "shape.radius": "none" },   // style tokens only
  "theme_name": "palette",         // the theme picked in the editor; "palette" follows the table palette (#93): accent and data colours from its slots
  "rotate_s": 12,                  // seconds per page, 6 to 60
  "pages": [                       // optional: replaces the automatic layout
    { "id": "energy", "title": "Community energy", "panels": [
      { "id": "solar", "widget": "stat", "size": "tile", "title": "Solar now", "layer": "energy",
        "at": { "col": 1, "row": 1 }, "props": { "value": { "bind": "shared.solar" }, "unit": "kW" } }
    ] }
  ]
}
```

On a site page every panel needs `at`. A panel with `layer` is up only while that layer is on.
The host passes `tv` to surfaces unchanged in `SiteInfo.tv`; the TV validates it.

The editor makes pages in **Design › Controller pages…** (#155) and saves them with
`site.tv { tv: { pages, rotate_s } }`. The host keeps the shape in bounds (12 pages, 8 panels each,
an id, widget, size and `at` on every panel, 64 KB); the grid, the sizes and the budget are checked
by the editor and again by the controller, with `validatePage`. A controller starts again when its
pages or their time change.

## Rules

| Rule | Check |
| --- | --- |
| `size` | The size exists and the widget comes in it |
| `schema` | Props match the widget's schema; no unknown fields |
| `binding` | Only bindable props are bound or worked out by an expression (`{ "expr": … }`, [expressions.md](expressions.md), #669), to `params.`, `shared.` or `site.` paths. A `list` prop may always be bound as a whole: its items are held to the item schema and the list limit as they arrive (#373) |
| `text` | Titles, labels, captions, units and values within their character limits; theme contrast |
| `budget` | The panel's reads fit its size; lists within their limits. A bound list is charged in full |
| `grid` | Site pages: inside 12 by 6, no overlap, a position for every panel. Layers: no position |
| `screen` | Site pages: at most 24 reads and 8 panels |
| `overflow` | Measured on screen (#681): nothing in a panel reaches past its edge, and no box inside it clips its content, except text cut short with an ellipsis or a line clamp |

A panel that fails is not mounted. The automatic layout never fails on `screen`: it adds pages.

**Short canvases.** The unit is 1% of the canvas height, but a host may set `--mrs-u-floor` on the canvas so text never gets smaller than that (the controller sets 0.8% of the screen height). A canvas too short for six rows then gets fewer rows (#137). They are as tall as a full screen's (at least 14 units; a full screen's are 14.4), so every panel gets the room it was designed for (#715), unless that would split the panels that are up over pages: then the fewest rows that keep them on one page, down to 8 units (so a tile still holds its title, number and caption). The automatic layout packs into the rows there are, turns pages for the rest, and leaves out a panel taller than the canvas. A site's hand-made page keeps the rows down to its lowest panel; on a canvas too short for them its rows are shorter, and the overflow check says which panels no longer fit. The canvas's margin is `--mrs-margin` (3 units; the controller sets 1.5, the same as the gap between panels, so a 1080p controller has four full rows under a layer's hero). Set `font-size` on what the canvas holds, never on the canvas itself: there, the unit's container units measure the screen, not the canvas.
A `custom` panel's drawing starts under its title and is cut at the bottom when it does not fit, which the `overflow` check reports.
Live values are cut to the same limits at run time.

**Nothing scrolls or spills (#681).** `DashboardView` measures the panels on show 250 ms after a change
(`checkOverflow()`, `panelOverflow(el)`) and reports each one whose content spills: in `issues` with the
rule `overflow`, through the `onOverflow` option, and in dev mode with a dashed outline. Before it measures,
it calls the widget handle's optional `fit()`, where a widget whose content depends on its width fits it
(the stat and gauge step their number down to the small number size; the series widens its scale's gutter;
the donut keeps its key at least half the width). The controller tells the editor which panels spill
(`{ type: 'mrs-panel-fit', from, panels }`), and the editor's status bar says so.
`worstCasePanel(widget, size)` is the widget's panel with the worst props the rules allow; every core widget
fits it at every size in CI (`pnpm --filter @mrstudio/dashboard fit [webkit|msedge]`).

## API

```ts
import { coreWidgets, DashboardView, validateLayerPanels, validatePage, validatePanel, validateTheme,
         panelReads, pack, themeVariables, defineWidget, GRID, SIZES, SCREEN, TEXT } from '@mrstudio/dashboard';

const registry = coreWidgets();                    // WidgetRegistry with the core widgets
registry.describe();                               // JSON: type, name, description, sizes, props schema
validateLayerPanels(manifest.panels, registry);    // Issue[]: { path, rule, message }
validatePage(page, registry);
validateTheme(site.tv.theme);

const view = new DashboardView(element, { dev: true });
view.setTheme(site.tv?.theme);
view.setPanels(inputs);        // PanelInput: { key, spec, source(), active?(), custom?, onRemove?, page? }
view.sync();                   // after any state change
```

`validate*`, `panelReads`, `pack` and `themeVariables` use no DOM, so they run in Node.

### Controls on panels (#354)

A `control` panel puts one of its layer's controls (or a named action) on the dashboard, a TV page or a
custom controller view, so a view can be built from panels alone. It reads the control's label,
range, unit and choices from layer.json, so they are written once:

```jsonc
{ "id": "share", "widget": "control", "size": "wide", "title": "Try a share", "layer": "model-runs",
  "props": { "control": "share" } }          // a range: a slider; a toggle; a select: choices; an action: a button
```

It changes the layer exactly as the controller's own control does (`layer.set`, `layer.action`), and the
host checks it the same way. On the table's ribbon it only shows the value. A panel that names a
control the layer doesn't have draws the name and is reported in the window's console. Widgets get
the layer's controls in `env.controls` (`find`, `value`, `set`, `press`, and `touch`, false where the
panel can't be touched), so a team widget (below) can be an input too.

A bound value arrives as the layer published it, then is read for the prop's kind (#373): a
`boolean` takes `true`/`false` (or the text `"true"`/`"false"`, `1`/`0`), and a `number` takes a
number or a number written as text. A widget says its own words in the visitors' language with
`env.say(text, vars?)`: the layer's `locales`, then the site's, then the runtime's.

### A map on a panel (#355)

A `map` panel is the site's map with no code: the same map a layer's own stage gets from
`controllerMap` (layer.md, The controller stage).

```jsonc
{ "id": "pick", "widget": "map", "size": "block", "title": "Pick a building", "layer": "model-runs",
  "props": {
    "data": [ { "name": "roads", "slot": 2 } ],   // up to 4 site datasets, in the data colours
    "entities": "buildings",                      // a tap picks one of the layer's entities (#279), drawn picked
    "tool": "start",                              // or: a tap sends a point to one of the layer's tools
    "shapes": { "bind": "shared.route" },         // GeoJSON the layer publishes, drawn on top in the accent
    "tap_action": "travel",                       // or: a tap presses one of the layer's named actions
    "zoom": true,                                 // drag and pinch zoom; Reset frames the table again
    "fill_by": { "entity": "use", "categories": { "housing": 1, "offices": 2 } },   // colour by data (#374)
    "stroke_by": { "shared": "load", "ramp": "magma" },
    "labels": "name",                             // a feature property written on each feature (at most 60)
    "hint": "Tap a building to change it" } }
```

**Colouring by data (#374).** `fill_by` and `stroke_by` colour every feature of the entity set's
dataset (else `dataset`, else the first of `data`) by one value:

- exactly one of `property` (the feature's own property), `entity` (an entity control's value,
  as visitors change it) or `shared` (a map of feature id to value the layer publishes, such as
  `{ "b12": 0.4 }`). A feature's id is the entity set's key, else its `id`.
- numbers follow `ramp`: a colour ramp's name or a list of two or more CSS colours, from `min`
  to `max` (default: the values' own range).
- anything else uses `categories`, value to a data slot 1 to 6 or a CSS colour; values not
  listed get no colour. Without `categories` each new value takes the next data slot.

The table's outline is always drawn. A tap reaches the table the way the controller's own does
(`layer.select`, `tool.input`), so the table marks a picked entity and the controller shows its
controls. On the table's ribbon it is not offered (no ribbon size).

### Adding a widget

```ts
export const gauge = defineWidget({
  type: 'gauge', name: 'Gauge', description: '...',
  sizes: ['tile'],
  props: { value: { kind: 'number', label: 'Value', required: true, bindable: true } },
  reads: () => 1,
  mount(el, env) { /* build DOM once */ return { update(props) { /* draw resolved props */ } }; },
});
```

A widget uses only the type and colour tokens in `dashboard.css`, states an honest cost, and is added to `coreWidgets`.
It fits its sizes with its example props and with `worstCasePanel` (#681): `fit.mjs` checks core widgets, and the
Developer window's **Longest text** checks a team's.
Every prop needs a `label`, because an editor will draw a form from the schema.

**Core or a team's own (#353).** Widgets that most tables need are core: they live here, work without
code and are added to `coreWidgets`. A team that needs something else writes it in its layer package
with the same `defineWidget` (exported from `@mrstudio/sdk`) and lists it in the module's `widgets`.
The runtime registers it as `<layer id>/<type>` in the one registry the controller, the TV pages and the
table's ribbon share, after checking it (`checkWidget`: a lower-case type, a name and description,
known sizes, `reads`, `mount`, and a label on every prop). The layer's own panels may name it by
`type` alone; core widgets win a clash. It is styled with the `--mrs-*` tokens, so it follows the theme.
When two teams have each written the same widget, it moves into core.

A widget may carry `example`: made-up props, plain values with no bindings, that the Developer window's widget gallery shows it with at every size (#358). Every core widget has one.

## Style tokens

`color.background`, `color.panel`, `color.line`, `color.text`, `color.muted`, `color.accent`, `color.accent-ink`, `color.good`, `color.warn`, `color.bad`, `data.1` to `data.6`, `font.text`, `font.number`, `shape.radius` (`none`, `small`, `medium`, `large`), `panel.style` (`filled`, `outlined`, `glass`, `plain`), `rail.look` (`tiles`, `bare`: how the controller draws layer buttons) and `density` (`comfortable`, `minimal`: minimal drops surfaces, dividers and group labels).

The built-in themes in `THEMES` are looks, not only colours: Midnight (default), Light, Minimal dark, Minimal light and Glass, then the colour variants Ocean, Forest, Warm sand, High contrast and Paper. The controller copies `panel.style`, `rail.look` and `density` to `data-surface`, `data-rail-look` and `data-density` on its body.

Colours are `#rrggbb`. Fonts are family names. Anything else is refused. Contrast floors: text 7:1, secondary text 4.5:1, accent, status and data colours 3:1, against both the background and the panel; `color.accent-ink` 4.5:1 against the accent.
