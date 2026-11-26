---
bump: minor
issues: 500, 81
---
### What if a building were here?

Visitors can change the place from their phones in Sunlight (#500, from #81). They can draw a new building, plant a tree, or tap a building or tree to take it away. The shadows and sun hours redraw with the change.

The changes live only in the simulation's scene, so every simulation on the table sees them. Nothing is saved: the controller can undo them, and closing Sunlight brings the real place back. Layers can do the same with the new `ctx.engine.edit` (host request `engine.edit`, see docs/contracts/engine.md).

![Before and after: a new 40 m block casts its shadow, a row of trees is planted, and a building is taken away](docs/screenshots/500-what-if.png)
