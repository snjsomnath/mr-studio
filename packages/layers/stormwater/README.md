# Stormwater

Rain running off roofs and slopes, gathering in streams and pooling, live as the storm goes on (#189).

The `stormwater` engine kernel floods the site's own terrain and buildings with a real shallow-water model (see "Stormwater kernel" in `docs/contracts/engine.md`). It needs nothing beyond what every site already has: the ground (`scene.terrain`) and the buildings. Roofs drain at the nearest wall, and ground under trees soaks up more.

On the table, top down and 2D:

- **Running water**: glowing drops riding the flow, the shared flow overlay's `droplets` mode. They land anywhere water runs, move at the storm's own pace (real metres per second times the storm speed), are coloured teal where the water barely moves, blue as it runs and white when it is fast.
- **Pools**: the water depth, clear on dry ground and a deepening blue where it gathers.

The controller has the rain intensity, "Start the storm again", what to show, and behind More settings the storm speed, soaking, roofs, trees, detail, the number of drops and the opacity. Its tiles show how far into the storm it is, the rain so far and the water on the ground.
