# Magnifier

A glass people move over the table (#287, #351): with the mouse on the table, by dragging the navigator on the controller, or with a phone's Move the glass tool. It works as the Lindholmen artwork's magnifier did, made a layer of its own so any table can have one.

- **Magnify: the table, larger on the controller** (`show: zoom`, the default): the table marks the circle being looked at and darkens the rest (`dim`), with a warm halo that breathes and a fine rim. The controller shows that circle `zoom` times larger through a glass: the middle stays exact, the rim bends the picture inward with a slight colour fringe and a warm reflection. Beside it a navigator of the whole table moves the circle. The table sends the picture with `ctx.view`; it is what the screen shows there, with any layer that can (`ctx.map.addDetail`, the Masterplan drawing) drawn again sharply at the glass's resolution.
- **X-ray: the layers inside it** (`show: under`): the layers placed inside it in the editor (Insert › Add inside…) show only inside the glass, on the table, at their own size: pipes under the street, an old map, a plan. With `cover` the map under the glass is hidden first. This uses the reveal core (docs/contracts/layer.md, Reveals).

With `look: hole` (#554) the X-ray is drawn as a hole cut in the table instead of a glass: the walls darken towards the rim, the near edge (the table's `front`) throws shade across the front of the hole, the far lip catches the light, and there is no halo. The glass is drawn on a `top` canvas, so it stays above the layers inside it.

With `follow` the circle follows the mouse and a click keeps it where it is (`pinned`); without it a press or drag places it. Where it is lives in the host (`x`, `y`, fractions of the table), so the projector, the editor and the controller agree.

Params: `show`, `look` (`glass` or `hole`, for the X-ray), `zoom`, `size` (the glass's width as a share of the table's shorter side; the circle on the table is `size / zoom`), `pinned`, `dim`, `cover`, `caustic` (slow rings of light over the lines in the controller's glass, every 8 s; on by default, off when the viewer asks for less motion, #415), `follow`, `x`, `y`. Tool: `move` (a point).

Not yet: clipping of shapes and flows inside an X-ray, and the old caustic light over the drawing's lines.
