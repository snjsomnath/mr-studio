# A layer with a model behind it (#278, #279, #281, #282)

The pieces a site needs to put an outside model (Python, or anything that speaks HTTP) behind a
layer, the way ECOM's backend sits behind its layer:

- `services/model/server.py`: a stand-in model with a quick call (`POST /run`) and a long job
  (`POST /optimise`, polled at `/optimise/<id>`).
- `layers/model-runs/`: a site layer that calls it with `ctx.service('model')`, shows the
  answer on the table and the controller, and publishes `busy` while it waits. Its buildings
  are `entities` (#279): tap one on the table and change it on the controller (in the energy
  community, solar on the roof), and the model is asked again once the slider settles.
- Its panels (#281): a `compare` panel shows grid import as today, with this plan and with the
  optimiser's best share (not run, working, done), and a `balance` panel shows where the power
  came from and went, with self-sufficiency. Both bind to what the layer publishes (`scenarios`,
  `sources`, `uses`, `self_sufficiency`), and their chip forms go in the table's ribbon.
- Its sound (#282): a `sound` bed in layer.json, a hiss and a transformer hum that load up with the
  grid import the layer publishes (`import_kw`), with no audio code.
- `site-services.json`: the `services` entry to put in a site's `site.json`.

To try it on the sample site: copy `services/` and `layers/` into a copy of `sites/sample`, add the
entry from `site-services.json` to its `site.json` as `"services"`, add
`{ "use": "./layers/model-runs" }` to its `layers`, run `mrstudio layer build --site <copy>`
and then `mrstudio dev --site <copy>`. The contract is in docs/contracts/site.md, Services.
