---
bump: minor
issues: 609
---
### Street glow and cars are drawn by the graphics card

The lights flowing along the streets and every car, taxi, bus and emergency vehicle are now drawn by the graphics card, in one draw per layer (#609). Nothing is drawn on the processor while they move. Street glow's drawing time fell from about 12 ms a frame to under 1 ms.

Layer authors get the same tool: `ctx.map.addSprites(id, images)` stamps many small pictures, which you place each frame from a buffer, as deck.gl's IconLayer does.

![Before and after: the same lights and traffic](docs/screenshots/609-gpu-sprites.png)
