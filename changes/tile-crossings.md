---
bump: minor
issues: 651
---
### Calibrate with the points where the model's tiles meet

On a table built from tiles (`table.tile_cm`, 20 cm at Chalmers and Lindholmen), calibration now also offers the points where four tiles meet, after the base and roof corners. They are exact on the physical table and spread over all of it, so the projector is fitted across the whole surface, not only where the buildings are. Crossings under a building are left out, and the plan on the controller shows the tile seams.

![A tile crossing to calibrate against, with the seams on the plan](docs/screenshots/651-tile-crossings.png)
