bump: patch
issues: 424, 411, 414, 422

### Open data that arrives, layers that line up, phones that stay

**OpenStreetMap no longer hangs.** The second mirror was the same silent server as the third, and each try waited 200 s. Now each server is asked once, a server that has not started answering in 20 s is skipped, and a table wider than 1.2 km is asked in tiles, so the main server stops refusing buildings. The Fetch everything dialog says which server and part it is on, and when no server answers it says so within about a minute.

![Fetch everything says which server and part it is asking](docs/screenshots/424-progress.png)

**Buildings keep their heights** when a file mixes height names, for example `height` on most and `höjd` on some. The import notes how many came from another name.

**Custom layers line up with the map** (layer builder layers, place motions, blocks). They were drawn about 12 % too large when the table sat inside margins, and spilled past its edge. Before and after:

![Before: a custom layer drawn too large](docs/screenshots/414-before.png)
![After: the same layer on the buildings](docs/screenshots/414-after.png)

**Phones stay joined when the controller window goes.** Every window that carries phones now uses the same phone link, so when the controller closes, sleeps, or is hidden, the table takes over in a few seconds and phones come back on their own, without scanning again.
