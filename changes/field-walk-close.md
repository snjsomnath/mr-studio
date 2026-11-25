---
bump: minor
issues: 466
---

### Field walk closes like a layer

Closing Field walk now takes its viewer off the controller. Before, it stayed above "Turn a layer on to see it here". Picking another layer now closes Field walk too, except Reveal line and Magnifier, which still open over the walk with the spots on top. A layer sets this with `alongsideOf` in layer.json.

![Controller after closing Field walk](docs/screenshots/466-closed.png)
