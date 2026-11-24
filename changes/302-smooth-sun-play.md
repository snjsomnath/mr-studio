---
bump: patch
issues: 302
---
### The sun glides through the day

Playing the sun study no longer jerks. The table now keeps its own clock while the day plays, so the sun, its glow and the shadows move a little every frame instead of jumping each time the time came back from the host. Shadows are drawn without stalling the frame, and on a slower graphics card they are drawn a little less often rather than slowing the whole table. The controller and the TV still follow the time a few times a second.

![The table playing the sun study](docs/screenshots/302-sun-playing.png)

![Frame times on the Mac, before and after](docs/screenshots/302-frame-times.png)
