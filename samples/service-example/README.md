# A layer with a model behind it (#278)

The pieces a site needs to put an outside model (Python, or anything that speaks HTTP) behind a
layer, the way ECOM's backend sits behind its layer:

- `services/model/server.py`: a stand-in model with a quick call (`POST /run`) and a long job
  (`POST /optimise`, polled at `/optimise/<id>`).
- `layers/model-runs/`: a site layer that calls it with `ctx.service('model')`, shows the
  answer on the table and the controller, and publishes `busy` while it waits.
- `site-services.json`: the `services` entry to put in a site's `site.json`.

To try it on the sample site: copy `services/` and `layers/` into a copy of `sites/sample`, add the
entry from `site-services.json` to its `site.json` as `"services"`, add
`{ "use": "./layers/model-runs" }` to its `layers`, run `mrstudio layer build --site <copy>`
and then `mrstudio dev --site <copy>`. The contract is in docs/contracts/site.md, Services.
