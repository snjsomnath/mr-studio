---
bump: minor
issues: 358
---
### The Developer window is now a workbench for layer and widget authors
The Developer window (Open in a window > Developer) now opens with a workbench of five tabs beside the live table; its **Workbench** button hides it:

- **Widgets:** every widget, the site's team widgets too, at every size with made-up data, with what each size costs against its budget.
- **Live values:** what each layer publishes and its params as they change. A click copies the binding for a panel.
- **Controller:** the 46-inch controller at its real layout, scaled to fit.
- **Action log:** actions, tool inputs and param and entity edits, with their round trip.
- **Problems:** refused panels, bindings to values a layer hasn't published, and what layers complained about.

![The widget gallery: the donut at each size it takes, with its cost](docs/screenshots/358-widgets.png)

![The controller at 46-inch size beside the live table](docs/screenshots/358-stage.png)

![The action log: a choice, the optimiser button and the model's progress](docs/screenshots/358-log.png)

![Live values: click one to copy its binding](docs/screenshots/358-values.png)
