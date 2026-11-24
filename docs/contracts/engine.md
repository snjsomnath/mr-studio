# Engine contract

`mrs-engine` is the compute core. It owns the GPU device, one scene per site, and the kernels.
It has no knowledge of layers, surfaces or the network.

## Coordinates and the grid

All engine data lives on one regular grid per site.

- Frame: metres on a tangent plane at the site origin. `x` runs along grid columns and `y` along grid rows.
- `rotation_deg` is the compass bearing of the grid's "up" direction (towards row 0), clockwise from north. With `rotation_deg = 0`, row 0 is the north edge and column 0 the west edge.
- Cell index is `row * width + col`. Row 0 is the top of the table image, so a field uploads to a texture without flipping.
- Heights are metres above the site datum.

```rust
pub struct Grid {
    pub width: u32,        // columns
    pub height: u32,       // rows
    pub cell_m: f32,       // cell size in metres
    pub rotation_deg: f32, // bearing of grid "up", clockwise from north
}
```

The grid is centred on the site origin. Grid `(col, row)` maps to local metres as
`right = (col + 0.5 - width / 2) * cell_m`, `up = (height / 2 - row - 0.5) * cell_m`, and
`east = right * cos(r) + up * sin(r)`, `north = -right * sin(r) + up * cos(r)` with `r = rotation_deg`.

## Scene

A scene is the shared geometry every kernel reads. It is uploaded to the GPU once.

| Raster | Type | Meaning |
| --- | --- | --- |
| `dtm` | f32 | Ground elevation |
| `dsm` | f32 | Top surface: ground plus buildings and other solid obstacles |
| `canopy` | f32 | Tree canopy height above ground, 0 where there is none. Porous, not solid |

`solid` is derived: a cell is solid when `dsm - dtm > 0.5`.
A scene carries a `revision`. Replacing the scene (for example after phone-drawn obstacles) raises it, and every job recomputes against the new revision.

## Kernels and jobs

A kernel is a named computation with a declared interface. A job is one running instance of a kernel.

```rust
pub struct KernelInfo {
    pub id: &'static str,              // "sunlight"
    pub kind: KernelKind,              // OneShot | Progressive | Iterative
    pub params: serde_json::Value,     // JSON Schema of accepted params
    pub fields: &'static [FieldInfo],  // outputs: name, units, description
}

pub trait Kernel: Send {
    fn info(&self) -> KernelInfo;
    fn create(&self, ctx: &Context, scene: &Scene, params: &Value) -> Result<Box<dyn Job>, EngineError>;
}

pub trait Job: Send {
    /// Merges `params` into the job's params. Restarts only what the change invalidates.
    fn set_params(&mut self, ctx: &Context, scene: &Scene, params: &Value) -> Result<(), EngineError>;
    /// Called when the scene revision changed since the last step.
    fn scene_changed(&mut self, ctx: &Context, scene: &Scene) -> Result<(), EngineError>;
    /// Advances by at most `budget`. Must return promptly.
    fn step(&mut self, ctx: &Context, scene: &Scene, budget: Duration) -> Result<JobStatus, EngineError>;
    fn read(&mut self, ctx: &Context, scene: &Scene, field: &str) -> Result<Field, EngineError>;
}

pub struct JobStatus {
    pub state: JobState,   // Running | Done
    pub progress: f32,     // 0..1
    pub revision: u64,     // raised whenever readable output changed
    pub info: Value,       // kernel-specific values a layer may want, e.g. the sun's position
}
```

Kinds:

- **OneShot**: one `step` produces the result (a shadow mask for one instant).
- **Progressive**: output is valid after every `step` and refines until `Done` (sun hours over a day).
- **Iterative**: a simulation that runs until it settles (wind, stormwater). `progress` reports how far it has developed. It reports `Done` once the result has stopped changing, so a steady result costs nothing to keep on the table; an unsteady one never reaches `Done`. A change of params or scene makes it `Running` again.

Rules for kernels:

1. Params are validated and clamped in `create` and `set_params`. Invalid params are an error, never a panic.
2. `step` respects its budget. Long work is split across steps.
3. A change of params or scene revision restarts only what it invalidates. `set_params` with unchanged values does nothing.
4. Each kernel ships a GPU implementation (`kernel.wgsl`) and a CPU reference (`cpu.rs`) of the same algorithm, selected by `Context::backend`. Both live in `crates/mrs-engine/src/kernels/<id>/`.
5. Each kernel ships a parity test (`tests/<id>.rs`) that runs both on `testing::town` and states its tolerance, plus tests of the physics on the CPU reference.
6. A kernel never reads site files. Everything comes from the `Scene` and params.

## Fields

```rust
pub struct Field {
    pub width: u32,
    pub height: u32,
    pub units: &'static str,   // "h", "m/s", "0..1"
    pub min: f32,              // the range to display and quantise over;
    pub max: f32,              // stable while a job runs, so colours do not jump
    pub data: Vec<f32>,        // row-major, row 0 at the top
}
```

Vector fields are delivered as separate component fields (`u`, `v`) plus any derived scalar the layer needs (`speed`).

A field always covers the whole site extent, but it may be coarser than the scene grid: `width` and `height` are the field's own.
A simulation picks the resolution it can afford, and a surface stretches the frame over the extent.
The resolution of a field may change when params change, never between two frames of the same params.

## Engine

```rust
let mut engine = Engine::new(EngineConfig { backend: Backend::Auto })?; // Gpu, Cpu or Auto
engine.load_scene(SceneData { grid, dtm, dsm, canopy })?;
let job = engine.create_job("sunlight", &json!({ "mode": "instant", "time": "2026-06-21T12:00:00Z", "lat": 57.7, "lon": 11.97 }))?;
let status = engine.step(job, Duration::from_millis(8))?;
let field = engine.read_field(job, "shadow")?;
engine.set_params(job, &json!({ "time": "2026-06-21T15:00:00Z" }))?;
engine.drop_job(job);
```

`Backend::Auto` uses the GPU when an adapter exists and falls back to the CPU reference.
Calling `load_scene` again replaces the scene and raises its revision; running jobs recompute on their next step.
The engine is driven from one thread. `mrs-host` runs it on a dedicated thread and talks to it over a channel.

## Wire form

The host exposes the engine to surfaces through these requests (see session.md for the envelope).

| Method | Params | Result |
| --- | --- | --- |
| `engine.info` | | `{ backend, adapter, grid, kernels: KernelInfo[] }` |
| `engine.open` | `{ kernel, params, fields: string[], encoding?: "u8" \| "f32", maxHz?: number }` | `{ stream }` |
| `engine.set` | `{ stream, params }` | `{}` |
| `engine.close` | `{ stream }` | `{}` |
| `engine.probe` | `{ kernel, params, at: [lon, lat] }` | the kernel's answer for that place |

`engine.open` creates a job and subscribes the calling surface. The host steps the job and, whenever the job's revision changes, pushes an `engine.status` event followed by one binary frame per field, at most `maxHz` times per second (default 30). The final frame of a job is sent at once.
Streams belong to the connection and are closed when it drops. If a kernel accepts `lat` and `lon` and the caller omits them, the host fills them from the site origin.

`engine.probe` asks a kernel about one place instead of the whole table, without a job (#252): a point question is cheap where a field is not. `at` is WGS84 and must be on the table. It is answered in the engine thread between job steps, so it waits for at most one step of a running job. Kernels without a probe answer with an error; so far only `sunlight` has one. Phones cannot call it; a layer's table code asks and publishes what the controller shows.

| Event | Payload |
| --- | --- |
| `engine.status` | `{ stream, state: "running" \| "done", progress, revision, info }` |
| `engine.error` | `{ stream, error }`; the stream is closed |

Binary field frame, little endian, 40-byte header followed by the data:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | 4 bytes | magic `MRSF` |
| 4 | u16 | version (1) |
| 6 | u16 | encoding: 0 = f32, 1 = u8 |
| 8 | u32 | stream id |
| 12 | u32 | field index within the stream's `fields` |
| 16 | u32 | width |
| 20 | u32 | height |
| 24 | u32 | revision |
| 28 | f32 | min |
| 32 | f32 | max |
| 36 | f32 | progress 0..1 |
| 40 | | `width * height` values |

With `u8` encoding a value `v` is `round((v - min) / (max - min) * 255)`.

## Sunlight kernel

Kernel id `sunlight`. Reference implementation of the rules above.

| Param | Type | Meaning |
| --- | --- | --- |
| `mode` | `"instant"` or `"day"` | One moment, or accumulated sun hours over a day |
| `time` | RFC 3339 string, or Unix seconds | The instant, or any time on the day to accumulate |
| `lat`, `lon` | number | Required by the kernel; the host fills them from the site |
| `step_minutes` | number, 5 to 60, default 15 | Sampling interval in `day` mode |
| `trees` | boolean, default true | Tree canopy dims the light that passes through it |
| `from`, `until` | RFC 3339 or Unix seconds, optional | In `day` mode, only samples between these times count, so `sun_hours` is the sun in that window (an evening on a terrace) and `daylight_hours` the daylight in it |

| Field | Units | Meaning |
| --- | --- | --- |
| `shadow` | 0..1 | 1 where the cell is lit at `time`, 0 in shadow or at night |
| `sun_hours` | h | Hours of direct sun on the day of `time` (`day` mode) |
| `tree_shade` | 0..1 | Share of the light that tree canopy takes from a cell no building shades (`instant` mode) |
| `tree_shade_hours` | h | Hours of direct sun lost to tree canopy (`day` mode) |

Algorithm: for each cell, march a ray across the `dsm` towards the sun in one-cell steps, starting from the cell's top surface. The cell is in shadow when the `dsm` rises above the ray. The march stops when the ray clears the scene's highest point or leaves the grid. Canopy the ray passes under removes a fixed share of the light per metre. Sun position follows the NOAA solar position equations. In `day` mode the day is the 24 hours from local mean solar midnight, sampled every `step_minutes`.

`shadow` and `tree_shade` exist in `instant` mode, `sun_hours` and `tree_shade_hours` in `day` mode. Where no building shades a cell, `shadow + tree_shade = 1`, so a layer can colour the two kinds of shade differently. Status `info` carries `sun: { azimuth_deg, altitude_deg }` and `daylight_hours`, so a layer can show them without recomputing.

**Probe.** `engine.probe` with `params` as for a job (`time` picks the day; `step_minutes` defaults to 5 here; `mode` is ignored) marches the same rays from the one cell under `at` across the day, and returns:

| Key | Meaning |
| --- | --- |
| `day_start` | Unix seconds of local mean solar midnight; sample `k` is at `day_start + (k + 0.5) * step_minutes * 60` |
| `step_minutes` | The sampling interval |
| `light`, `tree`, `altitude` | Per sample: light reaching the cell (0..1), the share trees took, the sun's height in degrees |
| `sun_hours`, `tree_hours`, `daylight_hours` | The day's sums, in hours; `sun_hours` matches the `sun_hours` field there |
| `first_sun`, `last_sun` | Unix seconds of the first and last sample with at least half the light, or null |
| `roof`, `height_m` | Whether the cell is on a building, and its `dsm - dtm` |

The march is the simplest correct algorithm and costs one step per cell of shadow length. The planned speed-up is a max-height pyramid that lets the ray skip empty space; the parity and physics tests are what make that change safe.

## Wind kernel

Kernel id `wind`, kind Iterative. Steady air flow at pedestrian level around buildings and through trees, in two dimensions.
Ported from `animations/cfd-core.js` of the previous app.

| Param | Type | Meaning |
| --- | --- | --- |
| `speed` | number, 0.5 to 20, default 5 | Wind speed in m/s |
| `direction_deg` | number, default 270 | Compass bearing the wind blows from, clockwise from north |
| `resolution` | number, 32 to 1024, default 256 | Lattice cells along the longer side of the site |
| `trees` | boolean, default true | Tree canopy slows the air that passes through it |
| `viscosity` | number, 0.02 to 0.15, default 0.03 | Lattice viscosity. Higher is smoother and more stable |
| `boundary` | `"open"`, `"periodic"` or `"channel"`, default `"open"` | Verification only. `open` is the real thing |
| `force` | two numbers | Verification only: a body force in lattice units |

| Field | Units | Meaning |
| --- | --- | --- |
| `speed` | m/s | Wind speed, 0 inside buildings |
| `u` | m/s | Velocity towards higher columns (the right of the table) |
| `v` | m/s | Velocity towards higher rows (the bottom of the table) |

All three fields have the lattice's resolution and a fixed display range: `speed` runs from 0 to 2.5 times the wind speed, `u` and `v` over plus and minus that, with the lower bound stretched by 128/127 so that zero falls exactly on a step of the 8-bit encoding and still air stays still.

Algorithm: a D2Q9 lattice Boltzmann solver with two-relaxation-time collision (magic parameter 1/4) and halfway bounce-back at buildings.
The lattice is the scene grid coarsened by a whole factor, chosen from `resolution`. A lattice cell is a building when at least half of its scene cells are solid, and its canopy cover is the share of its scene cells under trees.
Around the site the lattice is padded: half the site's length upstream, three quarters downstream and a third of its width on each side, so the open boundaries sit away from the buildings.
The upwind edges prescribe the wind velocity, the downwind edges prescribe density, and edges parallel to the wind let air leave; all three use non-equilibrium extrapolation. A sponge in the outer padding absorbs pressure waves.
Canopy removes momentum in proportion to speed squared and cover, applied with exact-difference forcing.
With buildings the inlet ramps up from rest over 400 steps.

One pass does one time step for every cell: pull the incoming populations (or reflect them at a wall), apply the edge condition, take density and velocity, collide, write to the other buffer. Nothing else touches the populations, so a step is one dispatch and the GPU never waits for the CPU. Steps are batched into one submission sized to the budget.

Wind speed and lattice speed are separate. The inlet runs at `speed * 0.005` lattice units, capped at 0.05, or 0.025 when there are buildings, and the result is scaled back to m/s. So above 5 m/s a change of `speed` only rescales the fields and nothing is recomputed.
What a change restarts: `direction_deg` and `resolution` rebuild the lattice; `speed` restarts only when it changes the lattice speed; `trees` and `viscosity` keep the flow and let it adapt.

Every 100 steps the kernel compares the visible velocities with the previous check. The run has settled, and reports `Done`, when the wind has had time to cross the site once and the root-mean-square change stayed under 0.1% of the inlet speed per 100 steps for five checks in a row.
The same check enforces the numerical limits (density within 0.8 to 1.2, lattice speed under 0.15). A run that leaves them restarts at half the lattice speed; if that cannot help the job fails with `EngineError::Unstable`.

Status `info` carries `steps`, `settled`, `change`, `lattice_speed`, `peak_mps`, `steps_per_second`, `lattice: { width, height, cell_m, factor, domain }` and `wind: { u, v }`, the unit vector the wind blows towards in table axes.

A zero budget runs exactly one step, which is how the parity test keeps both backends on the same step.

## Stormwater kernel

Kernel id `stormwater`, kind Iterative. Rain running off roofs and terrain, gathering in streams, pooling and draining, simulated live: the storm runs at `speed` times real time, so the table shows it as it happens. Two dimensions, top down. Replaces the Chalmers demo's static D8 routing (`animations/stormwater-flow.js`) with real water.

| Param | Type | Meaning |
| --- | --- | --- |
| `rain_mm_h` | number, 0 to 200, default 40 | Rain intensity. 0 stops the rain and lets the site drain; the water already there stays |
| `infiltration_mm_h` | number, 0 to 100, default 5 | How fast open ground soaks water up; three times as fast under a full tree canopy when `trees` is on |
| `speed` | number, 1 to 600, default 60 | Simulated seconds per real second |
| `resolution` | number, 32 to 1024, default 384 | Lattice cells along the longer side of the site |
| `roofs` | boolean, default true | Rain on a roof comes down at the nearest open ground beside its building, like a downpipe. Off, roof rain is dropped (a green roof that keeps it) |
| `trees` | boolean, default true | Ground under trees soaks up more |
| `manning` | number, 0.01 to 0.1, default 0.025 | Manning roughness of the ground |
| `storm` | number | Any change dries the site and starts the storm again |
| `pace` | `"realtime"` or `"fast"`, default `"realtime"` | `fast` ignores the clock and runs as many steps as the budget allows (tests, benchmarks) |

| Field | Units | Meaning |
| --- | --- | --- |
| `depth` | m | Water on the ground, 0 inside buildings. Display range 0 to 1 m |
| `speed` | m/s | Speed of the running water. Display range 0 to 2 m/s |
| `u` | m/s | Velocity towards higher columns (the right of the table), plus and minus 2 m/s with zero on an 8-bit step |
| `v` | m/s | Velocity towards higher rows (the bottom of the table), as `u` |

Velocity is reported only where the water is at least 5 mm deep, so dry ground and films of rain are zero in `u` and `v`, and a flow overlay treats them as places nothing runs.

Algorithm: the local inertial form of the shallow water equations (Bates, Horritt and Fewtrell 2010, the scheme behind LISFLOOD-FP), explicit, on a staggered grid. Depth lives on cells, discharge per unit width on the faces between them. One step is two dispatches:

1. Faces. Each cell updates the discharge through its east and south faces from the water-surface slope across the face, `q' = (q - g h_f dt dη/dx) / (1 + g dt n² |q| / h_f^(7/3))`, Manning friction applied semi-implicitly so thin sheets stay slow and stable. The flow depth `h_f` is the water above the higher of the two beds, so water does not climb a kerb it cannot reach over. A face carries no water when it is shallower than 1 mm, and may move at most a quarter of the upstream cell's water in one step, which keeps every depth non-negative and the scheme exactly mass-conserving.
2. Cells. Each cell adds its rain (times its rain multiplier), the net inflow through its four faces, takes off infiltration, and writes depth and velocity for the visible window.

The lattice is the scene grid coarsened by a whole factor chosen from `resolution`, with a one-cell ring of outfall cells around the site. A lattice cell is a building when at least half of its scene cells are solid; buildings are walls. The bed is the mean ground of the open scene cells in a lattice cell. The outfall ring sits level with the cell inside it and is kept dry, so water reaching the edge of the table leaves it. Each roof cell drains to the nearest open cell by steps through its building (breadth first), which adds one to that cell's rain multiplier.

The time step keeps a Courant number of 0.35 for gravity waves over the deeper of 2 m and one and a half times the deepest water, at most 1 s: about 0.24 s on 3 m cells. In `realtime` pace a job owes `speed` simulated seconds per wall second; each `step` call runs the steps that are due within its budget, sleeps until the next one inside the budget when none is, and drops anything owed beyond half a second of wall time, so a slow machine falls behind the clock rather than piling up work. `realtime` in the status reports the storm seconds actually achieved per wall second.

Every 100 steps the depths are read back: the totals, the next time step and how much the water still changes. The run has settled, and reports `Done`, after at least 300 simulated seconds once the mean depth changes by less than 1% of the rain rate (plus 1e-8 m/s) per second for five checks in a row: either steady (as much runs off and soaks in as falls) or drained. Any param change makes it run again; `resolution` rebuilds the lattice and `storm` starts dry, everything else keeps the water.

Status `info` carries `steps`, `seconds` and `minutes` into the storm, `settled`, `change`, `dt`, `rain_mm` fallen per square metre, `rain_m3` fallen on the site (roofs included when they drain), `water_m3` on the ground, `deepest_m`, `flooded_m2` (deeper than 10 cm), `steps_per_second`, `realtime` and `lattice: { width, height, cell_m, factor }`.

On Chalmers at the default resolution (417 x 250 cells of 3 m) the kernel runs about 180 times real time on llvmpipe, a software GPU, so any real GPU keeps up with the fastest storm speed and leaves room for `resolution` 1024.
A zero budget in `fast` pace runs exactly one step, which is how the parity test keeps both backends on the same step.
