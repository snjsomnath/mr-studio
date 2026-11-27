---
bump: minor
issues: 624, 625
---
### Stormwater knows asphalt from grass, and rain gardens from drains

Rain now soaks in by what covers the ground and the soil under it: asphalt and concrete shed it, paving lets a little through, grass and woodland soak it up as fast as the soil allows (clay slowly, sand fast), rain gardens hold it in a shallow dip, and drains take it into the pipes. The table's own roads and paths are read as surfaces without any setup; land cover (Naturvårdsverket's NMD, or OpenStreetMap land use), SGU's soil map and any points or areas marked as rain gardens or drains can be added under `scene.surfaces`. A new switch, **Each surface soaks up its own way**, compares with one rate for all ground.

![Lindholmen in a two-hour storm: with surfaces, the streets carry the runoff](docs/screenshots/624-surfaces-on.jpg)
