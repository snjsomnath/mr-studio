# A map stage on the controller, with no code (#374)

A site layer whose controller centre is a map, written in `layer.json` alone:

- `layers/building-uses/`: `"stage": { "map": { ... }, "panels": [...] }`. The map fills the centre
  under the layer's name. Each building is filled by the value of its `use` entity control
  (`fill_by` with `entity` and `categories`), so the map shows the plan as visitors change it. A
  tap picks a building, and its controls show under the map. Drag and pinch zoom the map; Reset
  frames the table again. A legend and the layer's homes goal (a control panel) sit along the map's bottom edge.

To try it on the sample site: copy `layers/` into a copy of `sites/sample`, add
`"buildings": "data/buildings.geojson"` to its `data` and
`{ "use": "./layers/building-uses", "id": "building-uses" }` to its `layers`, then run
`mrstudio dev --site <copy>`. The layer has no code, so there is nothing to build. The contract is
in docs/contracts/layer.md, The controller stage.
