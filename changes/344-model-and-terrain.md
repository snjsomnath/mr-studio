---
bump: minor
issues: 344
---
### Models in map coordinates and surface-model terrain come in through Add data

A 3D model exported in SWEREF 99 TM (or a SWEREF 99 local zone, or UTM) metres is now placed where it belongs as it comes in: no anchor, units or turn to work out. A terrain GeoTIFF that has the buildings raised in it (a surface model) is noticed, and **Take the buildings out of the ground** keeps only the ground under them, so the buildings stop counting as hills. Both Lindholmen files now come in with no script: the model lands where the hand-placed one did, and the built area is 24 % of the table again.

![The Lindholmen model placed by itself, and the surface-model terrain offering to take the buildings out](docs/screenshots/344-model-and-terrain.png)
