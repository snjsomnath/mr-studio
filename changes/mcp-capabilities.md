---
bump: minor
issues: 326
---
### The MCP server knows what each part of MR Studio is for, and what it cannot do

An LLM can now design an experience before it builds one. `find_capabilities` takes a goal in plain words and returns the layers, building blocks, kernels and site features that serve it, ranked, each with its status from the code (available, needs setup, planned, unsupported), what it needs, what the table, controller and phones do, what it pairs with, and the files that prove it; `describe_capability` gives one in full. Every core layer now says in its `layer.json` what it is for, the questions it answers, what it pairs with and its limits (`about`), and CI checks them. New resources give the three surfaces and eight experience patterns (`mrstudio://concepts`, `mrstudio://patterns/<id>`, from [docs/experience-design.md](docs/experience-design.md)), the catalogue, the site and recipe schemas, and the example sites. `save_custom_layer` works out the controller's legend from the looks and their data, as the editor does. Roadmap rows that are already built (ambient cars and people, dark and light maps, guided tours, annotations) are marked built.

![find_capabilities for a goal, the constraints, the patterns, and a worked-out legend](docs/screenshots/326-capabilities.png)
