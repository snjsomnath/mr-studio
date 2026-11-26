---
bump: minor
issues: 373
---
### One play head for every view

A layer that plays through time now keeps one play head that the table, the controller, the phones and the TV all read (#373). The table tells the host where the time is and how fast it moves (`ctx.clock.set`), and every view works out the time in between, so the controller's time slider, its hero and TV panels bound to the time follow the table smoothly while it plays, instead of jumping where play started. Stopping leaves the slider where the table stopped. Sunlight and Mobility use it: a playing day now sends about one update a second instead of ten. Layers read it with `ctx.clock.now()`.

![The controller's Sunlight hero following the playing day, one and six seconds in](docs/screenshots/373-play-head.png)
