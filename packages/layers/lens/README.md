# Magnifier

A glass people move over the table (#287): with the mouse on the table, by dragging on the controller's pad, or with a phone's Move the glass tool. It is the Lindholmen artwork's magnifying glass, made a layer of its own so any table can have one.

- **The table, larger** (`show: zoom`, the default): the glass shows what the table shows under it, `zoom` times larger. It copies the table's picture each frame (`ctx.map.addPicture()`), so it magnifies every layer that is on, the base map included. It is a copy of pixels, so it is softer on a 1× screen.
- **The layers inside it (an X-ray)** (`show: under`): the layers placed inside it in the editor show only inside the glass, at their own size: pipes under the street, an old map, a plan. With `cover` the map under the glass is hidden first. This uses the reveal core (docs/contracts/layer.md, Reveals).

The table around the glass darkens by `dim`. With `follow` the glass follows the mouse and a click keeps it where it is (`pinned`); without it a press or drag places it. Where it is lives in the host (`x`, `y`, fractions of the table), so the projector, the editor and the controller agree.

Params: `show`, `zoom`, `size` (percent of the table's shorter side), `pinned`, `dim`, `cover`, `follow`, `x`, `y`. Tool: `move` (a point).

Not yet: the magnified view on the controller itself, and clipping of shapes and flows inside an X-ray.
