---
bump: minor
issues: 282
---
### Sound that follows the data, and a Sound switch on the controller
A layer can now carry a sound bed in its layer.json, with no audio code: up to four slow voices (a band of filtered noise, a hum with harmonics, or a plain tone) whose loudness and colour follow a value the layer publishes or one of its controls. The model-runs sample hisses and hums louder as the community draws more from the grid. The bed keeps to the rules learned at the table: one level ceiling for all the voices together, slow glides and no repeating beeps. It plays on the table only. A new **Sound** button under Map controls on the controller mutes the table for the session, voices and sounds on points alike, while the rings that follow the sound carry on. How to write one: docs/contracts/layer.md, Sound voices.

![The Sound switch under Map controls, on](docs/screenshots/282-controller.png)

![Muted for the session](docs/screenshots/282-controller-muted.png)
