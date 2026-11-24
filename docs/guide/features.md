# Everything on the table

*Every core layer, what it shows and where to find it. Add one from the Edit tab, under Add a layer.*

## Base map

What the table stands on: your own streets and buildings drawn dark, a light, dark, grey, street or terrain map, an aerial photo, a map from your sources (Mapbox, CARTO, Lantmäteriet), or plain ground.

Layer `basemap`, base.

![Base map](docs/screenshots/37-aerial.png)

## Sunlight

Shadows at any moment, or hours of direct sun over a day.

Layer `sunlight`.

![Sunlight](docs/screenshots/137-sunlight.png)

## Wind

How the wind moves between buildings and through trees.

Layer `wind`.

![Wind](docs/screenshots/159-wind-after-ribbons.jpg)

## Stormwater

Rain running off roofs and slopes, gathering in streams and pooling, live as the storm goes on.

Layer `stormwater`, analysis.

![Stormwater](docs/screenshots/189-stormwater-table.jpg)

## Cool paths

The shortest walk between two points, and the one with the least heat (PET), as in the Chalmers demo.

Layer `coolpaths`.

![Cool paths](docs/screenshots/196-coolpaths-pet-table.jpg)

## Mobility

People on the move: trips played over time, and a map of how travel differs from place to place.

Layer `mobility`.

![Mobility](docs/screenshots/76-mobility-hero.png)

## Isovist

What a person standing here can see, how green that view is, and how it sounds.

Layer `isovist`.

![Isovist](docs/screenshots/190-isovist-table.png)

## Traffic

Cars, taxis and buses with headlights driving the street network, and now and then an emergency vehicle.

Layer `cars`, ambient.

![Traffic](docs/screenshots/201-traffic-table.png)

## Public transport

Trams, buses, trains and ferries on their routes, simulated or from a live feed.

Layer `transit`, ambient.

![Public transport](docs/screenshots/202-after.png)

## Street life

Walkers on the footways and paths, cyclists on the cycleways and warm streetlights along the main streets.

Layer `street-life`, ambient.

![Street life](docs/screenshots/195-at-rest.png)

## Street glow

Streets glowing in a colour for each kind of street, pulsing, with light flowing along them.

Layer `street-glow`, ambient.

![Street glow](docs/screenshots/195-close.png)

## Building lights

Lit windows along the facades that come on and go off.

Layer `building-lights`, ambient.

![Building lights](docs/screenshots/53-at-rest.png)

## Trees

Tree crowns that sway in a light wind.

Layer `trees`, ambient.

## Table grid

A glowing grid on the model's tile seams, to check that the projection lines up.

Layer `grid`, analysis.

![Table grid](docs/screenshots/191-grid-table.png)

## Map data

A GeoJSON dataset of the site drawn on the table, coloured by category, revealed one category at a time.

Layer `mapdata`, analysis.

![Map data](docs/screenshots/43-slides-next-reveals.png)

## Masterplan

A plan drawing over the table, revealed one phase at a time.

Layer `plan`, media.

![Masterplan](docs/screenshots/193-table-3.png)

Set **When it opens** to *Its lines trace in* and give it a **Colour version**, and the drawing draws itself line by line, then turns to colour, as the Lindholmen artwork does. With **Before the first Next** on *Only what is outside the phases*, each Next grows one phase (a viewpoint, a stage of a plan) from its own middle. A group in the drawing named *Base* is always shown and never becomes a phase. **Place by its corners** puts a drawing that is not the table's shape where it belongs on the map; with the Masterplan open in the editor, drag its frame on the map to move, scale and turn it by hand, and **Turn the drawing** shows a drawing drawn on its side the right way round. The controller shows the drawing too.

![Masterplan tracing in](docs/screenshots/286-trace.png)

Name the parts of each phase by what they are (Boundary, Main axis, Routes, Arrows, Points, Nodes, Green spaces) and number the phases (01_, 02_...), and each part moves the way it should: the boundary marches, the axis grows from its middle, points pop in, green spaces breathe. `samples/kit/drawing/masterplan-roles.svg` is a template.

![A masterplan coming to life part by part](docs/screenshots/300-routes.png)

## Magnifier

A glass people move over the table with the mouse, from the controller or from a phone. It shows what is under it larger, or, set to *The layers inside it (an X-ray)*, an X-ray of the layers placed inside it in the editor (pipes under the street, an old map, a plan), only inside the glass.

Layer `lens`, analysis.

![Magnifier as an X-ray](docs/screenshots/287-xray.png)

## Reveal line

A line across the table people drag, from the table, the controller or a phone. On one side of it the layers placed inside it show, such as what is under the ground; on the other the table stays as it is. Left alone it sweeps slowly to invite people in.

Layer `swipe`, analysis.

![Reveal line over the underground](docs/screenshots/288-reveal-line.png)

## Video walk

A video on the controller, with the walker who filmed it moving along their path on the table.

Layer `walkthrough`, media.

![Video walk](docs/screenshots/194-tv-playing.png)

## Slideshow

Images, video and map data shown on the table one after another.

Layer `slideshow`, media.

![Slideshow](docs/screenshots/43-slides-editor.png)

## Picture or video

A picture or a video of the site laid over the whole table, such as a simulation, an old photo or a film of a sun study. In a slideshow, slides move on with a cut, a fade or a dip to black.

Layer `media`, media.

![A picture over the table](docs/screenshots/197-table-picture.png)

## Web map (WMS)

A map from a WMS service, such as a planning map or an aerial photo, laid over the table.

Layer `wms`, media.

## Sketch

Mark places, routes and areas on the table from a phone.

Layer `sketch`.

## Building blocks

Two scenes assembled from the SDK's building blocks, with pointer interactions.

Layer `blocks-demo`.

![Building blocks](docs/screenshots/163-lit-blocks.png)

## Your own layers

The layer builder (Edit tab, Make your own) combines data, look, motion and interaction into a custom layer saved in the table: points, lines and zones coloured by your data, place motions such as pulses and circular waves, particles and flows along streets.

![Place motions](docs/screenshots/161-place-motions.png)
