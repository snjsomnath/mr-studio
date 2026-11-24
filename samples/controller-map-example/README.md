# A map app on the controller (#283)

A site layer with its own app in the controller's centre, whose actions drive the table:

- `layers/route-planner/`: the controller shows a map of the site (`controllerMap`). Two taps make
  a route, along the streets (`StreetGraph.route`) or straight, sent to the table as a tool input
  (`ctx.sendTool`). **Send a traveller** presses the named action `travel` (`ctx.action`), and the
  table sends a light along the route and plays the attention cue where it arrives.

To try it on the sample site: copy `layers/` into a copy of `sites/sample`, add
`{ "use": "./layers/route-planner", "id": "route-planner" }` to its `layers`, run
`mrstudio layer build --site <copy>` and then `mrstudio dev --site <copy>`. The contract is in
docs/contracts/layer.md, The controller stage.
