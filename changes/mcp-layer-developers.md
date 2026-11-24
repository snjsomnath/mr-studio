---
bump: minor
issues: 284
---
### The MCP server guides a developer through a site code layer

For the ideas that need code, an LLM can now build a team's own layer with them, the way a layer like ECOM is built: blocks first, code last. `create_layer` starts one in the site with `mrstudio layer new`. `sdk_reference` looks up what `@mrstudio/sdk` really exports, read from its source, so code is written against what exists. `check_layer` applies the layer rules: the TV's density budget, every word in Swedish, no places written into code, no talking to surfaces behind the host's back, only the SDK from the core, and the data, services and kernels the layer needs. `build_layer` bundles it and returns the build's errors, `preview_layer` says how to see it in the dev view, and `add_service` declares a model the host starts beside the table. New prompts: `build_code_layer` and `build_controller_app`.

![sdk_reference, create_layer, check_layer catching a place and a WebSocket in the code, build_layer and add_service](docs/screenshots/284-layer-developers.png)
