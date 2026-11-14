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

`engine.open` creates a job and subscribes the calling surface. The host steps the job and, whenever the job's revision changes, pushes an `engine.status` event followed by one binary frame per field, at most `maxHz` times per second (default 30). The final frame of a job is sent at once.
Streams belong to the connection and are closed when it drops. If a kernel accepts `lat` and `lon` and the caller omits them, the host fills them from the site origin.

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

| Field | Units | Meaning |
| --- | --- | --- |
| `shadow` | 0..1 | 1 where the cell is lit at `time`, 0 in shadow or at night |
| `sun_hours` | h | Hours of direct sun on the day of `time` (`day` mode) |

Algorithm: for each cell, march a ray across the `dsm` towards the sun in one-cell steps, starting from the cell's top surface. The cell is in shadow when the `dsm` rises above the ray. The march stops when the ray clears the scene's highest point or leaves the grid. Canopy the ray passes under removes a fixed share of the light per metre. Sun position follows the NOAA solar position equations. In `day` mode the day is the 24 hours from local mean solar midnight, sampled every `step_minutes`.

`shadow` exists in `instant` mode and `sun_hours` in `day` mode. Status `info` carries `sun: { azimuth_deg, altitude_deg }` and `daylight_hours`, so a layer can show them without recomputing.

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
