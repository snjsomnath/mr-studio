---
bump: none
issues: 539
audience: developers
---
### The host's hub is split by job

`crates/mrs-host/src/hub.rs` was 4,259 lines, and parallel work kept colliding in it. It is now a `hub/` folder, with each part's tests beside it:
- `scene.rs`: adding, moving and switching layers, their buttons, settings and entities
- `load.rs`: building the scene from site.json
- `steps.rs`: slideshows, sub-steps and the tick
- `seats.rs`: phones, the guide, joining and leaving
- `settings.rs`: table and controller settings, languages, sources
- `custom.rs`: custom layers, the palette, datasets
- `tools.rs`: what phones draw
- `requests.rs`: the request handler
- `mod.rs`: the types, the `Hub` and its events

The diff only moves code. The only edits are `pub(super)` so the parts can reach each other, and two signatures that rustfmt wrapped as a result. All 41 hub tests pass unchanged.

![Lines per file, before and after](docs/screenshots/539-hub-split.png)
