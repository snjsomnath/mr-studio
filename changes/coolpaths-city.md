---
bump: patch
issues: 492
---
### CoolPaths starts smoothly on a city-sized table

CoolPaths now works out its walks in the background and draws its map of roofs and water once per file. On a city-sized table you can keep using it while it searches. On the Universeum table, its longest pause at start fell from about 2.5 seconds to about 1.2 seconds, and the total time the table stops while starting it halved.

![Pauses before and after](docs/screenshots/492-coolpaths-start.png)
