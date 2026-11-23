# Map data

Draws a GeoJSON dataset of the site (any dataset brought in with **Add data**) on the table, coloured by the categories of one property, such as `kind`.

With "Next reveals one category at a time" on, the layer tells the controller it has one sub-step per category (`ctx.steps.define`). Each Next reveals the next category, with a short pulse, while the rest stay faint as context. With nothing revealed, or all of them, the whole map shows. Inside a slideshow, Next moves on to the next slide after the last category, or stays, as the slide says. This is how the Chalmers campus demo walks through a map.

Up to 12 categories get their own colours; with more, the map is drawn in the layer's one colour.
