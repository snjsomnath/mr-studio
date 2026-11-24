# Energy community (ECOM)

The Chalmers campus energy community (#192), ported from interactive_map's ECOM layers onto the
2.0 SDK. It plays a summer day: energy flows along the streets from roofs, the grid and the
battery, the buildings fill by how much of their use the community covers that hour, and the
controller shows a map to pick buildings, the time of day, self-sufficiency, where the power comes
from, and the grid import together against each building on its own.

- **The model:** `ecom` in site.json is the ECOM backend (interactive_map `Dashboard/backend`,
  started with `launch_ecom_backend.sh`, port 8000). A change to a building posts the community to
  its `/api/mr/layer`. Without the backend, the day it last exported is shown (`data/ecom`, copied
  with `python tools/ecom_data.py ../interactive_map`) and changes are worked out here roughly.
- **Buildings** are entities: a tap picks one, and the controller offers "In the community" and
  "Solar on the roof".
- **The controller** is a stage of panels in layer.json: no controller code.
- **Its own widget:** `day-clock` (src/day-clock.ts). A tap on it plays or pauses the day.

Build it once with `mrstudio layer build ecom --site sites/chalmers` before opening the table (this repo ignores `dist/`).
