# Reveal line

A line across the table that people move (#288). On one side of it the layers placed inside it in the editor show, such as what is under the ground; on the other the table stays as it is. Drag it on the table (a press anywhere jumps it there), on the controller's pad, or with a phone's Move the line tool.

It uses the same reveal core as the Magnifier's X-ray (docs/contracts/layer.md, Reveals): the runtime clips the items to the side the layer sets, so any layer can go inside it.

Left alone for 8 seconds with `sweep` on, the line sweeps slowly across the table to invite people in; the sweep is drawn by each view on its own.

Params: `at` (percent across or down), `axis` (`vertical`, `horizontal`), `side` (which side shows the items: `before` is left or above), `cover` (hide the map on that side), `sweep`, `colour`. Tool: `move` (a point).
