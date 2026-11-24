---
bump: minor
issues: 354
---
### Sliders, toggles, choices and buttons on panels
A panel can now hold one of its layer's controls: a slider, a toggle, up to three choices side by side, or a button for an action. It takes its label, range and choices from the layer, so they are written once, and it changes the table exactly as the controller's own control does. With this a view of the controller or the TV can be put together from panels alone, the first step towards custom controller views without code. On the table's ribbon a control only shows its value. A team's own widgets can be controls too.

![A TV page built from panels: a slider, three choices and a button drive the model-runs layer](docs/screenshots/354-after.png)
