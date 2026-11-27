---
bump: patch
issues: 533
---
### Long shadows are worked out about twice as fast

At a low sun the sunlight kernel walked from every cell towards the sun one cell at a time, hundreds of steps per cell. It now keeps the highest point of each block of 32 by 32 cells, and a ray already above a block jumps to its far side, since it only climbs and nothing in that block can shade it (#533).

The picture is exactly the same: a test compares every cell with the old walk at many sun positions, and the GPU and CPU still agree. On a made-up town of 1 to 2 km at 1 m cells, a winter or evening sun is about twice as fast, and Sun hours gains the same way.

![Every step walked against jumping, on a 1 km and a 2 km town](docs/screenshots/533-sun-jump.png)
