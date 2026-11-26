---
bump: minor
issues: 488
---
### Wind feels the buildings around the table

A table can now bring in the buildings around it, up to 500 m past its edge (Add data, **Buildings around**). The wind simulation stands them around the table, so wind reaching the table has already passed real streets and blocks, as in a CFD run with a context ring. Nothing is drawn for them. Left: wind from the west arriving clean; right: the same wind after the buildings west of the table, with the gusts along the west edge gone.

![Wind speed without and with the buildings around the table](docs/screenshots/488-wind-context.png)
