---
bump: minor
issues: 279
---
### Tap a building on the table, change it on the controller
A layer can now list things visitors change one at a time, such as the buildings of an energy community. Tap one on the table and it lights up. The controller then shows its name and its own settings, like whether it is in the community and how much of its roof has solar panels. Visitors can also pick one from a list, put it back to how it was, or apply its settings to every building of the same kind. Changed buildings get a dashed outline on the table. The layer needs no code for any of this: it only reads the values, and it can wait for a slider to settle before asking a model again. `samples/service-example` now works this way.

![The controller with building 77 picked: in the energy community, 60 % solar on the roof](docs/screenshots/279-controller.png)
![The table with the picked building outlined and every shop changed at once, dashed](docs/screenshots/279-table.png)
