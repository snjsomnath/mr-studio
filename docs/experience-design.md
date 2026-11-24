# Designing an MR Studio experience

An MR Studio experience is a group standing around a real place, exploring it together. It is not a website, a dashboard or a GIS map. Design the experience first (who is there, what they should leave understanding or having said), then pick the layers that serve it.

This page is what the MCP server gives an LLM as `mrstudio://concepts` and `mrstudio://patterns/<id>`. Every capability id it names (`layer:sunlight`, `block:phone-tools`) is checked against the code by the MCP tests, so a pattern never promises something that does not exist. Status, data needs and evidence for each id come from `find_capabilities` and `describe_capability`, never from this page.

## The three surfaces

| Surface | What it is | What goes there | What never goes there |
| --- | --- | --- | --- |
| Table | The physical model or map, lit from above by a projector, seen top-down | Light, colour, motion and a few place labels. Shadows, wind, water, people moving, plans revealed | Paragraphs, buttons, charts, a 3D camera, extrusion |
| Controller | The screen beside the table (a TV or touch screen), `/tv` | Layer buttons down the sides, the open layer's controls in the centre, its legend, step titles, panels and charts, Street View | Anything people must read from across the room |
| Phones | Visitors join by QR code, `/phone`; the guide's phone is `/guide` | Every layer's switch (unless the table, the layer or a running slideshow holds it back), its `primary` controls and those it marks `phone: true`, phone tools (place a point, draw a route or area), the guide's presenter notes | Controls only the operator should touch |

At rest, when nobody touches the controller, the table plays its ambient layers and the controller loops through the layers by itself (the attract loop).

## Words

- **Site** (a table): a folder with `site.json`, its data and media. One place, one table.
- **Layer**: what the table shows when its button is pressed: data plus motion plus interaction. Core layers ship with the app; a custom layer is a recipe saved in the site; a site layer is code in the site's `layers/` folder.
- **Item**: a layer inside another layer, shown only while that layer is open (trams inside a sun study).
- **Steps**: what Next does. A slideshow's sequence shows other layers one after another, each with a title for the controller and notes for the guide's phone.
- **Ambient** and **base** layers: the map at rest; no button.
- **Recipe**: a custom layer made of look, motion and interaction blocks, without code.

## Constraints

- The table is 2D, seen from straight above. Height and value become colour, glow, outline or soft shadow, never extrusion or a tilted camera.
- The table carries almost no text. Words live on the controller and phones.
- One layer is open at a time (plus `alongside` tools such as Sketch). A comparison is built with a reveal line, a magnifier or a sequence, not two layers fighting for the same ground.
- Hand tracking is not part of MR Studio 2.0. People act through the controller, phones, and the mouse or pointer on the table.
- Keys for live data and map services live in the app's Sources and keys, never in `site.json`.

## Patterns

Each pattern is a shape of experience that works at a table. Combine two or three into a sequence; most workshops are 4 to 8 steps.

### compare-existing-proposed: Compare today and the proposal

Let people see what changes. Start with today, introduce the proposal, then let people move between the two themselves.

- **Table:** today's place; the plan revealed phase by phase; a reveal line or magnifier showing the proposal inside it while the rest stays today.
- **Controller:** the phase names, Next, the line's position.
- **Phones:** move the reveal line or the glass.
- **Capabilities:** `layer:basemap`, `layer:plan`, `layer:swipe`, `layer:lens`, `layer:media`, `layer:wms`

### reveal-hidden: Reveal what you cannot see

Show what lies under, behind or before: pipes, old maps, soil, a historic photo.

- **Table:** an X-ray glass or a reveal line showing the hidden layer inside it.
- **Controller:** what is being revealed, a legend.
- **Phones:** move the glass.
- **Capabilities:** `layer:lens`, `layer:swipe`, `layer:media`, `layer:wms`, `layer:mapdata`

### climate-at-the-table: Feel sun, wind and water

Simulations people can steer: drag the hour, change the wind, start a cloudburst. Pair each with the proposal to ask "what changes?".

- **Table:** shadows or sun hours, wind particles, water running and pooling.
- **Controller:** date and hour, wind speed and direction, rain, panels with numbers.
- **Phones:** move the hour or the wind; tap to ask how much sun a spot gets.
- **Capabilities:** `layer:sunlight`, `layer:wind`, `layer:stormwater`, `layer:coolpaths`, `kernel:sunlight`, `kernel:wind`, `kernel:stormwater`, `block:time-control`, `block:engine-probe`

### stand-in-their-shoes: Stand in someone's place

Pick a spot and see the place from there: what a person sees, how green and enclosed it feels, how it sounds, the walk there in summer heat.

- **Table:** the view shed from a point, the coolest walk between two points.
- **Controller:** Street View from the spot, green-view share, the comfort of the walk.
- **Phones:** place the viewer, the start and the end of a walk.
- **Capabilities:** `layer:isovist`, `layer:coolpaths`, `layer:walkthrough`, `block:table-pointer`, `block:view-analysis`, `block:thermal-comfort`

### map-it-together: Map it together

Everyone contributes: places they love, routes they take, areas that need change. The table fills up with the group's knowledge.

- **Table:** points, routes and areas appearing as people add them.
- **Controller:** the open question ("Where do you cross the street?").
- **Phones:** place a point, draw a route or an area.
- **Capabilities:** `layer:sketch`, `block:phone-tools`

### living-place: Bring the place to life

Ambient life that makes the model a place: traffic, trams, walkers, lit windows, swaying trees. Good at rest and as the backdrop of a story.

- **Table:** cars, public transport, people, lights, trees.
- **Controller:** density and pace, live or simulated transport.
- **Phones:** none needed.
- **Capabilities:** `layer:cars`, `layer:transit`, `layer:street-life`, `layer:street-glow`, `layer:building-lights`, `layer:trees`, `layer:mobility`, `block:animated-paths`

### guided-story: A guided story

A sequence the guide steps through from the controller, with notes only the guide sees. Each step shows a layer with its own settings.

- **Table:** one layer per step, with transitions.
- **Controller:** step titles and descriptions, Next.
- **Phones:** the guide's phone with presenter notes; visitors may follow along.
- **Capabilities:** `layer:slideshow`, `layer:media`, `block:guided-tour`, `block:step-transitions`

### data-story: Tell a story from your data

A dataset drawn so it reads: zones coloured by a column, places pulsing by weight, flows along streets, things appearing over time. A custom layer needs no code.

- **Table:** the dataset as points, lines or areas, with motion.
- **Controller:** a legend; a control bound to the recipe.
- **Phones:** optional controls.
- **Capabilities:** `layer:mapdata`, `block:custom-layer`, `block:choropleth`, `block:place-motions`, `block:marks`
