---
bump: minor
issues: 609
---
### Everything that moves on the table is drawn by the graphics card

Street glow, cars, trees swaying in the wind, lit windows, people and bikes, and transit vehicles with their trails and ferry wakes are now drawn by the graphics card, in one draw per layer (#609). Nothing is drawn on the processor while they move, and no picture of the whole table is sent each frame. Each of these layers now takes under 1 ms a frame, where together they took about 100 ms.

Layer authors get the same tools: `ctx.map.addSprites(id, images)` stamps many small pictures placed each frame from a buffer, as deck.gl's IconLayer does, and `ctx.map.addStrokes(id)` draws lines with a width and alpha per point, for trails. Both are cut at the table's edge and answer a click on the map in the editor.

![Before and after: the same lights and traffic](docs/screenshots/609-gpu-sprites.png)

![Before and after: trees, windows, people and transit](docs/screenshots/609-gpu-part2.png)
