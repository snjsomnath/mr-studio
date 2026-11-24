---
bump: minor
issues: 349, 351
---
### The Magnifier works as the artwork's did, and the Reveal line can show then and now

The Magnifier now works the way round the Lindholmen artwork's did. The table marks the circle being looked at and darkens the rest, with the old warm halo and fine rim. The controller shows that circle larger, through a glass that bends the picture at its rim, with a small table picture beside it to move the circle. A Masterplan drawing is drawn again sharply for the glass. The X-ray stays on the table.

The Reveal line can now show two layers, one on each side of the line, with **With two layers inside, the second shows on the other side**. For example, the 1960 aerial photo on one side and today's on the other.

For layer authors: `ctx.view` sends a picture from the table to the layer's own controller, `ctx.map.addDetail` and `ctx.map.detail` draw a layer again sharply for a magnifier, and `ctx.reveal.item` gives one item a shape of its own.

![The magnified glass on the controller](docs/screenshots/351-magnifier-controller.png)
