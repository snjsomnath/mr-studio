---
bump: minor
issues: 278
breaking: A table with "services" in its site.json opens only in this version or newer; update the app on every computer that runs it.
---
### Models that run beside the table
A table can now start its own models, such as an energy optimiser in Python, every time it opens. It keeps them running, restarting any that stop, and its layers ask them for answers. Long runs show their progress on the controller. If a model is down or the table is offline, the table shows the last answer it got. `samples/service-example` has a small model and a layer that uses it.

![The controller while the model optimises, with its progress under the layer's name](docs/screenshots/278-controller-busy.png)
![The model's answer drawn on the table, one circle per building](docs/screenshots/278-table.png)
