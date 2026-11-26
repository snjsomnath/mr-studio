//! Wind: steady pedestrian-level air flow around buildings and through trees.
//! A D2Q9 lattice Boltzmann solver with two-relaxation-time collision.
//! Contract in `docs/contracts/engine.md`.
//!
//! The simulation runs on its own lattice: the scene grid coarsened by a whole
//! factor, with padding around it so the open boundaries sit away from the
//! buildings. Fields cover the visible window at the lattice's resolution.

mod cpu;

use std::time::{Duration, Instant};

use bytemuck::{Pod, Zeroable};
use serde_json::{json, Value};

use crate::{Backend, Context, EngineError, Field, FieldInfo, Job, JobState, JobStatus, Kernel, KernelInfo, KernelKind, Scene};

// ---- Cell flags, shared with kernel.wgsl -----------------------------------

/// Bit 0 of a cell: the cell is a building.
pub(crate) const SOLID: u32 = 1;
/// Bits 1-2 of a cell: its role on the edge of an open domain.
pub(crate) const EDGE_INLET: u32 = 1;
pub(crate) const EDGE_OUTLET: u32 = 2;
pub(crate) const EDGE_SIDE: u32 = 3;
/// Bits `6 + 2k` of a cell, for direction k = 1..8: where that population streams from.
pub(crate) const LINK_PULL: u32 = 0;
pub(crate) const LINK_BOUNCE: u32 = 1;
pub(crate) const LINK_OPEN: u32 = 2;

// ---- Model constants -------------------------------------------------------

/// Lattice speed per m/s of wind, and its ceiling. Above the ceiling the wind
/// speed only scales the output.
const LATTICE_PER_MPS: f32 = 0.005;
const LATTICE_MAX: f32 = 0.05;
/// Ceiling with buildings: leaves headroom for the 2-3x speed-up at corners and gaps.
const LATTICE_MAX_OBSTACLES: f32 = 0.025;
/// The inlet ramps up from rest over this many steps when there are buildings,
/// so a dense street network does not start with a pressure shock.
const RAMP_STEPS: u64 = 400;
/// Sponge strength at the outer edge of the padding, and the clear margin
/// around the visible window where the equations are left alone.
const SPONGE_MAX: f32 = 0.2;
const SPONGE_MARGIN: i32 = 8;
/// Canopy drag: a fully covered cell keeps 60% of its speed per `CANOPY_REFERENCE_M`
/// travelled at unit lattice speed.
const CANOPY_DRAG: f32 = 0.510_825_6;
const CANOPY_REFERENCE_M: f32 = 4.0;
/// Lattice cells along the domain's edge kept free of context buildings (#488), for the inlet and outlet.
const CONTEXT_EDGE_CLEAR: usize = 3;
/// Convergence is checked at least this many steps apart.
const CHECK_INTERVAL: u64 = 100;
/// Settled when the flow changed by less than this share of the inlet speed
/// per `CHECK_INTERVAL` steps, this many checks in a row.
const SETTLED_CHANGE: f32 = 0.001;
const SETTLED_CHECKS: u32 = 5;
/// Numerical limits, in lattice units. Beyond them the run restarts slower.
const DENSITY_RANGE: (f32, f32) = (0.8, 1.2);
const PEAK_SPEED_MAX: f32 = 0.15;
const LATTICE_MIN: f32 = 0.003;
/// Fields are displayed and quantised over 0 to this multiple of the wind speed.
const RANGE_FACTOR: f32 = 2.5;
/// Most steps encoded into one GPU submission.
const MAX_BATCH: usize = 256;
/// Upper bound on one population buffer, whatever the device allows.
const MAX_BUFFER_BYTES: u64 = 256 << 20;

const FIELDS: &[FieldInfo] = &[
    FieldInfo { name: "speed", units: "m/s", description: "Wind speed" },
    FieldInfo { name: "u", units: "m/s", description: "Velocity towards higher columns (the right of the table)" },
    FieldInfo { name: "v", units: "m/s", description: "Velocity towards higher rows (the bottom of the table)" },
];

pub struct WindKernel;

impl Kernel for WindKernel {
    fn info(&self) -> KernelInfo {
        KernelInfo {
            id: "wind",
            kind: KernelKind::Iterative,
            params: json!({
                "type": "object",
                "properties": {
                    "speed": { "type": "number", "minimum": 0.5, "maximum": 20, "default": 5, "description": "Wind speed in m/s" },
                    "direction_deg": { "type": "number", "default": 270, "description": "Compass bearing the wind blows from" },
                    "resolution": { "type": "number", "minimum": 32, "maximum": 1024, "default": 256, "description": "Lattice cells along the longer side of the site" },
                    "trees": { "type": "boolean", "default": true },
                    "viscosity": { "type": "number", "minimum": 0.02, "maximum": 0.15, "default": 0.03, "description": "Lattice viscosity" },
                    "boundary": { "enum": ["open", "periodic", "channel"], "default": "open", "description": "Verification only" },
                    "force": { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2, "description": "Verification only: body force in lattice units" }
                }
            }),
            fields: FIELDS,
        }
    }

    fn create(&self, ctx: &Context, scene: &Scene, params: &Value) -> Result<Box<dyn Job>, EngineError> {
        let params = Params::default().merged(params)?;
        let gpu = match ctx.backend {
            Backend::Gpu => Some(GpuState::new(ctx)),
            _ => None,
        };
        let mut job = WindJob {
            geo: Geometry::build(ctx, scene, &params),
            params,
            lattice_speed: 0.0,
            backoff: 0,
            steps: 0,
            min_warmup: 0,
            ramp_steps: 0,
            reference: Vec::new(),
            reference_step: 0,
            change: None,
            settled_checks: 0,
            peak: 0.0,
            revision: 0,
            macros: Vec::new(),
            macros_step: 0,
            front: Vec::new(),
            back: Vec::new(),
            gpu,
            step_cost: None,
            rate: 0.0,
        };
        job.rebuild_buffers(ctx);
        job.restart(ctx);
        Ok(Box::new(job))
    }
}

// ---- Params ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Boundary {
    /// Inlet, outlet and open sides around a padded domain. The real thing.
    Open,
    /// Wraps on both axes.
    Periodic,
    /// Wraps along columns, walls at the top and bottom rows.
    Channel,
}

#[derive(Debug, Clone, PartialEq)]
struct Params {
    speed: f32,
    direction_deg: f32,
    resolution: f32,
    trees: bool,
    viscosity: f32,
    boundary: Boundary,
    force: [f32; 2],
}

impl Default for Params {
    fn default() -> Self {
        Self {
            speed: 5.0,
            direction_deg: 270.0,
            resolution: 256.0,
            trees: true,
            viscosity: 0.03,
            boundary: Boundary::Open,
            force: [0.0; 2],
        }
    }
}

impl Params {
    /// Applies a JSON patch, validates types and clamps numbers to their ranges.
    fn merged(&self, patch: &Value) -> Result<Self, EngineError> {
        let bad = |m: &str| EngineError::InvalidParams(m.to_string());
        let map = patch.as_object().ok_or_else(|| bad("params must be an object"))?;
        let number = |value: &Value, name: &str| {
            value
                .as_f64()
                .filter(|v| v.is_finite())
                .map(|v| v as f32)
                .ok_or_else(|| EngineError::InvalidParams(format!("{name} must be a number")))
        };
        let mut p = self.clone();
        for (key, value) in map {
            match key.as_str() {
                "speed" => p.speed = number(value, key)?.clamp(0.5, 20.0),
                "direction_deg" => p.direction_deg = number(value, key)?.rem_euclid(360.0),
                "resolution" => p.resolution = number(value, key)?.round().clamp(32.0, 1024.0),
                "viscosity" => p.viscosity = number(value, key)?.clamp(0.02, 0.15),
                "trees" => p.trees = value.as_bool().ok_or_else(|| bad("trees must be a boolean"))?,
                "boundary" => {
                    p.boundary = match value.as_str() {
                        Some("open") => Boundary::Open,
                        Some("periodic") => Boundary::Periodic,
                        Some("channel") => Boundary::Channel,
                        _ => return Err(bad("boundary must be 'open', 'periodic' or 'channel'")),
                    }
                }
                "force" => {
                    let pair = value.as_array().filter(|a| a.len() == 2).ok_or_else(|| bad("force must be two numbers"))?;
                    p.force = [number(&pair[0], key)?.clamp(-1e-3, 1e-3), number(&pair[1], key)?.clamp(-1e-3, 1e-3)];
                }
                other => return Err(EngineError::InvalidParams(format!("unknown param '{other}'"))),
            }
        }
        Ok(p)
    }
}

// ---- Geometry --------------------------------------------------------------

/// The lattice for one scene, wind direction and resolution.
struct Geometry {
    nx: usize,
    ny: usize,
    /// The visible window: the site, at lattice resolution.
    x0: usize,
    y0: usize,
    vw: usize,
    vh: usize,
    /// Scene cells per lattice cell, along each axis.
    factor: usize,
    cell_m: f32,
    /// Length of the visible window along the wind, in cells.
    along: f32,
    /// Unit vector the wind blows towards, in (column, row).
    wind: (f32, f32),
    has_solid: bool,
    cells: Vec<u32>,
    /// Share of each cell under tree canopy, for rebuilding `aux` when trees are toggled.
    coverage: Vec<f32>,
    /// Per cell: sponge strength, canopy drag.
    aux: Vec<f32>,
}

/// Domain size and the position of the visible window for a coarsening factor.
fn layout(scene: &Scene, factor: usize, wind: (f32, f32), boundary: Boundary) -> (usize, usize, usize, usize, usize, usize, f32) {
    let vw = (scene.grid.width as usize).div_ceil(factor).max(3);
    let vh = (scene.grid.height as usize).div_ceil(factor).max(3);
    let (ax, ay) = (wind.0.abs(), wind.1.abs());
    let along = ax * vw as f32 + ay * vh as f32;
    if boundary != Boundary::Open {
        return (vw, vh, 0, 0, vw, vh, along);
    }
    // Half the visible length upstream, three quarters downstream for the wake,
    // and a third of the visible width on each side.
    let cross = ay * vw as f32 + ax * vh as f32;
    let (up_x, down_x) = if wind.0 >= 0.0 { (0.5, 0.75) } else { (0.75, 0.5) };
    let (up_y, down_y) = if wind.1 >= 0.0 { (0.5, 0.75) } else { (0.75, 0.5) };
    let left = (up_x * along * ax + 0.3 * cross * ay).ceil() as usize;
    let right = (down_x * along * ax + 0.3 * cross * ay).ceil() as usize;
    let top = (up_y * along * ay + 0.3 * cross * ax).ceil() as usize;
    let bottom = (down_y * along * ay + 0.3 * cross * ax).ceil() as usize;
    (vw + left + right, vh + top + bottom, left, top, vw, vh, along)
}

impl Geometry {
    fn build(ctx: &Context, scene: &Scene, params: &Params) -> Self {
        // The wind blows towards the opposite bearing. Snapping keeps an axis-aligned
        // wind exactly on its axis, which is what classifies the edges.
        let (dx, dy) = scene.grid.bearing_to_cell_dir(params.direction_deg as f64 + 180.0);
        let snap = |v: f64| if v.abs() < 1e-6 { 0.0 } else { v as f32 };
        let wind = (snap(dx), snap(dy));

        // Coarsen until the populations fit in one buffer.
        let limit = match &ctx.gpu {
            Some(gpu) => {
                let limits = gpu.device.limits();
                limits.max_storage_buffer_binding_size.min(limits.max_buffer_size).min(MAX_BUFFER_BYTES)
            }
            None => MAX_BUFFER_BYTES,
        };
        let longer = scene.grid.width.max(scene.grid.height) as usize;
        let mut factor = ((longer as f32 / params.resolution).round() as usize).max(1);
        let (nx, ny, x0, y0, vw, vh, along) = loop {
            let l = layout(scene, factor, wind, params.boundary);
            if (l.0 * l.1 * 36) as u64 <= limit || factor >= longer {
                break l;
            }
            factor += 1;
        };

        let (gw, gh) = (scene.grid.width as usize, scene.grid.height as usize);
        let mut solid = vec![false; nx * ny];
        let mut coverage = vec![0.0f32; nx * ny];
        let mut has_solid = false;
        for j in 0..vh {
            for i in 0..vw {
                // A lattice cell is a building when at least half of its scene cells are.
                let (mut total, mut built, mut treed) = (0u32, 0u32, 0u32);
                for row in (j * factor)..((j + 1) * factor).min(gh) {
                    for col in (i * factor)..((i + 1) * factor).min(gw) {
                        let index = row * gw + col;
                        total += 1;
                        built += scene.is_solid(index) as u32;
                        treed += (scene.canopy[index] > 0.0) as u32;
                    }
                }
                let n = (y0 + j) * nx + x0 + i;
                if total > 0 && built * 2 >= total {
                    solid[n] = true;
                    has_solid = true;
                } else if total > 0 {
                    coverage[n] = treed as f32 / total as f32;
                }
            }
        }

        // Buildings around the table (#488) stand in the padding, so wind reaching the table has
        // passed them. The outermost cells stay clear for the inlet and outlet.
        if let (Some(ring), Boundary::Open) = (&scene.context, params.boundary) {
            let edge = CONTEXT_EDGE_CLEAR;
            for y in edge..ny.saturating_sub(edge) {
                for x in edge..nx.saturating_sub(edge) {
                    let (i, j) = (x as i64 - x0 as i64, y as i64 - y0 as i64);
                    if i >= 0 && j >= 0 && (i as usize) < vw && (j as usize) < vh {
                        continue;
                    }
                    let f = factor as i64;
                    let (mut total, mut built) = (0u32, 0u32);
                    for row in (j * f)..((j + 1) * f) {
                        for col in (i * f)..((i + 1) * f) {
                            total += 1;
                            built += ring.is_solid(&scene.grid, col, row) as u32;
                        }
                    }
                    if built * 2 >= total {
                        solid[y * nx + x] = true;
                        has_solid = true;
                    }
                }
            }
        }

        let open = params.boundary == Boundary::Open;
        let mut cells = vec![0u32; nx * ny];
        for y in 0..ny {
            for x in 0..nx {
                let n = y * nx + x;
                if solid[n] {
                    cells[n] = SOLID;
                    continue;
                }
                let mut cell = 0u32;
                for k in 1..9 {
                    let (mut sx, mut sy) = (x as i32 - cpu::EX[k], y as i32 - cpu::EY[k]);
                    if params.boundary != Boundary::Open {
                        sx = sx.rem_euclid(nx as i32);
                    }
                    if params.boundary == Boundary::Periodic {
                        sy = sy.rem_euclid(ny as i32);
                    }
                    let outside = sx < 0 || sy < 0 || sx >= nx as i32 || sy >= ny as i32;
                    let link = if outside {
                        if open {
                            LINK_OPEN
                        } else {
                            LINK_BOUNCE
                        }
                    } else if solid[sy as usize * nx + sx as usize] {
                        LINK_BOUNCE
                    } else {
                        LINK_PULL
                    };
                    cell |= link << (6 + 2 * k);
                }
                if open && (x == 0 || y == 0 || x == nx - 1 || y == ny - 1) {
                    let inlet = (x == 0 && wind.0 > 0.0)
                        || (x == nx - 1 && wind.0 < 0.0)
                        || (y == 0 && wind.1 > 0.0)
                        || (y == ny - 1 && wind.1 < 0.0);
                    let outlet = (x == 0 && wind.0 < 0.0)
                        || (x == nx - 1 && wind.0 > 0.0)
                        || (y == 0 && wind.1 < 0.0)
                        || (y == ny - 1 && wind.1 > 0.0);
                    let edge = if inlet {
                        EDGE_INLET
                    } else if outlet {
                        EDGE_OUTLET
                    } else {
                        EDGE_SIDE
                    };
                    cell |= edge << 1;
                }
                cells[n] = cell;
            }
        }

        let mut geo = Self {
            nx,
            ny,
            x0,
            y0,
            vw,
            vh,
            factor,
            cell_m: scene.grid.cell_m * factor as f32,
            along,
            wind,
            has_solid,
            cells,
            coverage,
            aux: vec![0.0; nx * ny * 2],
        };
        geo.fill_aux(params);
        geo
    }

    /// Sponge strength and canopy drag per cell.
    fn fill_aux(&mut self, params: &Params) {
        let (nx, ny) = (self.nx as i32, self.ny as i32);
        let (x0, y0, vw, vh) = (self.x0 as i32, self.y0 as i32, self.vw as i32, self.vh as i32);
        let drag = if params.trees { CANOPY_DRAG * self.cell_m / CANOPY_REFERENCE_M } else { 0.0 };
        for y in 0..ny {
            for x in 0..nx {
                let n = (y * nx + x) as usize;
                if params.boundary == Boundary::Open {
                    // Absorb outgoing disturbances in the padding only, rising towards the outer edge.
                    let m = SPONGE_MARGIN;
                    let left = (x0 - m - x) as f32 / (x0 - m).max(1) as f32;
                    let right = (x - x0 - vw - m) as f32 / (nx - x0 - vw - m - 1).max(1) as f32;
                    let top = (y0 - m - y) as f32 / (y0 - m).max(1) as f32;
                    let bottom = (y - y0 - vh - m) as f32 / (ny - y0 - vh - m - 1).max(1) as f32;
                    let distance = left.max(right).max(top).max(bottom).clamp(0.0, 1.0);
                    self.aux[n * 2] = SPONGE_MAX * distance * distance;
                }
                self.aux[n * 2 + 1] = drag * self.coverage[n];
            }
        }
    }

    /// Inlet speed in lattice units for a wind speed in m/s.
    fn lattice_speed(&self, speed: f32) -> f32 {
        (speed * LATTICE_PER_MPS).min(if self.has_solid { LATTICE_MAX_OBSTACLES } else { LATTICE_MAX })
    }

    fn lattice(&self) -> cpu::Lattice<'_> {
        cpu::Lattice { nx: self.nx, ny: self.ny, cells: &self.cells, aux: &self.aux }
    }

    fn visible_len(&self) -> usize {
        self.vw * self.vh
    }
}

// ---- One pass --------------------------------------------------------------

/// The values one step needs. Mirrors `Pass` in kernel.wgsl.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub(crate) struct Pass {
    nx: u32,
    ny: u32,
    x0: u32,
    y0: u32,
    vw: u32,
    vh: u32,
    write_macros: u32,
    _pad: u32,
    omega_plus: f32,
    omega_minus: f32,
    wind_x: f32,
    wind_y: f32,
    inlet_bc: f32,
    inlet_sponge: f32,
    force_x: f32,
    force_y: f32,
}

// ---- GPU -------------------------------------------------------------------

struct GpuBuffers {
    aux: wgpu::Buffer,
    populations: [wgpu::Buffer; 2],
    /// (u, v, density) of the visible window.
    out: wgpu::Buffer,
    /// `groups[i]` reads `populations[i]` and writes the other.
    groups: [wgpu::BindGroup; 2],
    /// Which of `populations` holds the current state.
    front: usize,
}

struct GpuState {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    /// One `Pass` per step of a batch, selected with a dynamic offset.
    uniforms: wgpu::Buffer,
    stride: usize,
    buffers: Option<GpuBuffers>,
}

impl GpuState {
    fn new(ctx: &Context) -> Self {
        let gpu = ctx.gpu();
        let pass_size = std::mem::size_of::<Pass>();
        let stride = pass_size.next_multiple_of(gpu.device.limits().min_uniform_buffer_offset_alignment as usize);
        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("wind"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(pass_size as u64),
                    },
                    count: None,
                },
                storage(1, true),
                storage(2, true),
                storage(3, true),
                storage(4, false),
                storage(5, false),
            ],
        });
        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("wind"),
            source: wgpu::ShaderSource::Wgsl(include_str!("kernel.wgsl").into()),
        });
        let pipeline_layout = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("wind"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("wind"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let uniforms = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wind.passes"),
            size: (stride * MAX_BATCH) as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Self { pipeline, layout, uniforms, stride, buffers: None }
    }

    /// Allocates the buffers for a geometry and uploads its fixed data.
    fn allocate(&mut self, ctx: &Context, geo: &Geometry) {
        let gpu = ctx.gpu();
        let cells = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("wind.cells"),
            size: (geo.cells.len() * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        gpu.queue.write_buffer(&cells, 0, bytemuck::cast_slice(&geo.cells));
        let aux = gpu.storage_f32("wind.aux", &geo.aux);
        let empty = |label: &str, len: usize| {
            gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: (len * 4) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        let populations = [empty("wind.populations.0", geo.nx * geo.ny * 9), empty("wind.populations.1", geo.nx * geo.ny * 9)];
        let out = empty("wind.out", geo.visible_len() * 3);
        let group = |src: usize| {
            fn whole(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
                wgpu::BindGroupEntry { binding, resource: buffer.as_entire_binding() }
            }
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("wind"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &self.uniforms,
                            offset: 0,
                            size: wgpu::BufferSize::new(std::mem::size_of::<Pass>() as u64),
                        }),
                    },
                    whole(1, &cells),
                    whole(2, &aux),
                    whole(3, &populations[src]),
                    whole(4, &populations[1 - src]),
                    whole(5, &out),
                ],
            })
        };
        let groups = [group(0), group(1)];
        self.buffers = Some(GpuBuffers { aux, populations, out, groups, front: 0 });
    }

    fn upload_aux(&self, ctx: &Context, geo: &Geometry) {
        let buffers = self.buffers.as_ref().expect("wind buffers");
        ctx.gpu().queue.write_buffer(&buffers.aux, 0, bytemuck::cast_slice(&geo.aux));
    }

    /// Runs the given passes in one submission and waits for them.
    fn run(&mut self, ctx: &Context, passes: &[Pass]) -> Result<(), EngineError> {
        let gpu = ctx.gpu();
        let buffers = self.buffers.as_mut().expect("wind buffers");
        let mut bytes = vec![0u8; passes.len() * self.stride];
        for (i, pass) in passes.iter().enumerate() {
            bytes[i * self.stride..][..std::mem::size_of::<Pass>()].copy_from_slice(bytemuck::bytes_of(pass));
        }
        gpu.queue.write_buffer(&self.uniforms, 0, &bytes);
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut compute = encoder.begin_compute_pass(&Default::default());
            compute.set_pipeline(&self.pipeline);
            for (i, pass) in passes.iter().enumerate() {
                compute.set_bind_group(0, &buffers.groups[buffers.front], &[(i * self.stride) as u32]);
                compute.dispatch_workgroups(pass.nx.div_ceil(8), pass.ny.div_ceil(8), 1);
                buffers.front = 1 - buffers.front;
            }
        }
        gpu.queue.submit([encoder.finish()]);
        // Submission is asynchronous; wait so the budget measures real work.
        gpu.wait()
    }
}

// ---- Job -------------------------------------------------------------------

struct WindJob {
    params: Params,
    geo: Geometry,
    /// Inlet speed in lattice units, after the ceilings and any stability back-off.
    lattice_speed: f32,
    /// Times the run restarted at half the lattice speed after hitting a numerical limit.
    backoff: u32,
    steps: u64,
    /// Steps for the wind to cross the site once, after the ramp.
    min_warmup: u64,
    ramp_steps: u64,
    /// (u, v, density) of the visible window at `reference_step`, for the convergence check.
    reference: Vec<f32>,
    reference_step: u64,
    /// Change of the flow per `CHECK_INTERVAL` steps as a share of the inlet speed, once measured.
    change: Option<f32>,
    settled_checks: u32,
    /// Highest speed in the visible window at the last check, lattice units.
    peak: f32,
    revision: u64,
    /// (u, v, density) of the visible window at `macros_step`, lattice units.
    macros: Vec<f32>,
    macros_step: u64,
    /// CPU backend populations: the current state and the buffer the next step writes.
    front: Vec<f32>,
    back: Vec<f32>,
    gpu: Option<GpuState>,
    /// Seconds one step took, from the last batch.
    step_cost: Option<f64>,
    /// Steps per second over the last `step` call.
    rate: f64,
}

impl WindJob {
    /// Allocates the population buffers for the current geometry.
    fn rebuild_buffers(&mut self, ctx: &Context) {
        self.macros = vec![0.0; self.geo.visible_len() * 3];
        match &mut self.gpu {
            Some(gpu) => gpu.allocate(ctx, &self.geo),
            None => {
                self.front = vec![0.0; self.geo.nx * self.geo.ny * 9];
                self.back = self.front.clone();
            }
        }
    }

    /// Inlet speed for a step, in lattice units: a cosine ramp from rest.
    fn inlet(&self, step: u64) -> f32 {
        if self.ramp_steps == 0 {
            return self.lattice_speed;
        }
        let t = (step as f32 / self.ramp_steps as f32).min(1.0);
        self.lattice_speed * (0.5 - 0.5 * (std::f32::consts::PI * t).cos())
    }

    /// The pass that takes the lattice from step `step - 1` to `step`.
    fn pass(&self, step: u64, write_macros: bool) -> Pass {
        let geo = &self.geo;
        let omega_plus = 1.0 / (0.5 + 3.0 * self.params.viscosity);
        // The second rate follows from the "magic" product 1/4, which keeps walls halfway between cells.
        let omega_minus = 1.0 / (0.5 + 0.25 / (1.0 / omega_plus - 0.5));
        Pass {
            nx: geo.nx as u32,
            ny: geo.ny as u32,
            x0: geo.x0 as u32,
            y0: geo.y0 as u32,
            vw: geo.vw as u32,
            vh: geo.vh as u32,
            write_macros: write_macros as u32,
            _pad: 0,
            omega_plus,
            omega_minus,
            wind_x: geo.wind.0,
            wind_y: geo.wind.1,
            inlet_bc: self.inlet(step),
            inlet_sponge: self.inlet(step + 1),
            force_x: self.params.force[0],
            force_y: self.params.force[1],
        }
    }

    /// Starts the simulation again from rest (or from uniform wind when nothing is in the way).
    fn restart(&mut self, ctx: &Context) {
        let geo = &self.geo;
        let open = self.params.boundary == Boundary::Open;
        self.lattice_speed = geo.lattice_speed(self.params.speed) * 0.5f32.powi(self.backoff as i32);
        self.ramp_steps = if open && geo.has_solid { RAMP_STEPS } else { 0 };
        self.min_warmup = self.ramp_steps + (geo.along / self.lattice_speed).ceil() as u64;
        self.steps = 0;
        self.settled_checks = 0;
        self.change = None;
        self.peak = 0.0;

        let at_rest = self.ramp_steps > 0 || self.params.boundary == Boundary::Channel;
        let (u0, v0) = if at_rest { (0.0, 0.0) } else { (geo.wind.0 * self.lattice_speed, geo.wind.1 * self.lattice_speed) };
        let pass = self.pass(0, true);
        match &mut self.gpu {
            Some(gpu) => {
                let mut initial = vec![0.0; geo.nx * geo.ny * 9];
                cpu::initialise(&geo.lattice(), &pass, u0, v0, &mut initial, &mut self.macros);
                let buffers = gpu.buffers.as_mut().expect("wind buffers");
                ctx.gpu().queue.write_buffer(&buffers.populations[buffers.front], 0, bytemuck::cast_slice(&initial));
            }
            None => cpu::initialise(&geo.lattice(), &pass, u0, v0, &mut self.front, &mut self.macros),
        }
        self.macros_step = 0;
        self.reference = self.macros.clone();
        self.reference_step = 0;
        self.revision += 1;
    }

    /// The flow keeps its state but has to settle again.
    fn unsettle(&mut self, ctx: &Context) -> Result<(), EngineError> {
        self.sync_macros(ctx)?;
        self.reference.copy_from_slice(&self.macros);
        self.reference_step = self.steps;
        self.settled_checks = 0;
        self.change = None;
        self.revision += 1;
        Ok(())
    }

    fn settled(&self) -> bool {
        self.steps >= self.min_warmup && self.settled_checks >= SETTLED_CHECKS
    }

    /// Brings `macros` up to the current step.
    fn sync_macros(&mut self, ctx: &Context) -> Result<(), EngineError> {
        if self.macros_step != self.steps {
            if let Some(gpu) = &self.gpu {
                let buffers = gpu.buffers.as_ref().expect("wind buffers");
                self.macros = ctx.gpu().read_f32(&buffers.out, self.geo.visible_len() * 3)?;
            }
            self.macros_step = self.steps;
        }
        Ok(())
    }

    /// Runs `count` steps. The last one writes the macroscopic values.
    fn advance(&mut self, ctx: &Context, count: usize) -> Result<(), EngineError> {
        // The passes are built before the GPU state is borrowed for the run.
        let passes: Vec<Pass> = match self.gpu {
            Some(_) => (0..count).map(|i| self.pass(self.steps + 1 + i as u64, i + 1 == count)).collect(),
            None => Vec::new(),
        };
        if let Some(gpu) = &mut self.gpu {
            gpu.run(ctx, &passes)?;
            self.steps += count as u64;
        } else {
            for _ in 0..count {
                let pass = self.pass(self.steps + 1, true);
                cpu::step(&self.geo.lattice(), &pass, &self.front, &mut self.back, &mut self.macros, ctx.threads);
                std::mem::swap(&mut self.front, &mut self.back);
                self.steps += 1;
                self.macros_step = self.steps;
            }
        }
        Ok(())
    }

    /// Checks the numerical limits and measures how much the flow still changes.
    /// Returns false when the run hit a limit and was restarted slower.
    fn check(&mut self, ctx: &Context) -> Result<bool, EngineError> {
        self.sync_macros(ctx)?;
        let (mut sum, mut count) = (0.0f64, 0u64);
        let (mut peak, mut low, mut high) = (0.0f32, f32::MAX, f32::MIN);
        let mut finite = true;
        let visible = self.geo.visible_len();
        for i in 0..visible {
            let (x, y) = (self.geo.x0 + i % self.geo.vw, self.geo.y0 + i / self.geo.vw);
            if self.geo.cells[y * self.geo.nx + x] & SOLID != 0 {
                continue;
            }
            let (u, v, r) = (self.macros[i * 3], self.macros[i * 3 + 1], self.macros[i * 3 + 2]);
            finite &= u.is_finite() && v.is_finite() && r.is_finite();
            peak = peak.max((u * u + v * v).sqrt());
            low = low.min(r);
            high = high.max(r);
            let (du, dv) = (u - self.reference[i * 3], v - self.reference[i * 3 + 1]);
            sum += (du * du + dv * dv) as f64;
            count += 1;
        }
        if count > 0 && (!finite || low < DENSITY_RANGE.0 || high > DENSITY_RANGE.1 || peak > PEAK_SPEED_MAX) {
            if self.lattice_speed * 0.5 < LATTICE_MIN {
                return Err(EngineError::Unstable(format!(
                    "wind left its numerical limits at step {}: density {low:.3} to {high:.3}, peak speed {peak:.3}",
                    self.steps
                )));
            }
            tracing::warn!(
                "wind hit a numerical limit at step {} (density {low:.3} to {high:.3}, peak {peak:.3}); restarting slower",
                self.steps
            );
            self.backoff += 1;
            self.restart(ctx);
            return Ok(false);
        }
        self.peak = peak;
        let interval = (self.steps - self.reference_step) as f32;
        let rms = (sum / count.max(1) as f64).sqrt() as f32;
        let change = rms / self.lattice_speed * CHECK_INTERVAL as f32 / interval;
        self.settled_checks = if change < SETTLED_CHANGE { self.settled_checks + 1 } else { 0 };
        self.change = Some(change);
        self.reference.copy_from_slice(&self.macros);
        self.reference_step = self.steps;
        Ok(true)
    }

    /// Metres per second per lattice unit of velocity.
    fn scale(&self) -> f32 {
        self.params.speed / self.lattice_speed
    }

    fn status(&self) -> JobStatus {
        let settled = self.settled();
        JobStatus {
            state: if settled { JobState::Done } else { JobState::Running },
            progress: if settled { 1.0 } else { (self.steps as f32 / self.min_warmup.max(1) as f32).min(0.99) },
            revision: self.revision,
            info: json!({
                "steps": self.steps,
                "settled": settled,
                "change": self.change,
                "lattice_speed": self.lattice_speed,
                "peak_mps": self.peak * self.scale(),
                "steps_per_second": self.rate,
                "lattice": { "width": self.geo.vw, "height": self.geo.vh, "cell_m": self.geo.cell_m, "factor": self.geo.factor, "domain": [self.geo.nx, self.geo.ny] },
                "wind": { "u": self.geo.wind.0, "v": self.geo.wind.1 },
            }),
        }
    }
}

impl Job for WindJob {
    fn set_params(&mut self, ctx: &Context, scene: &Scene, params: &Value) -> Result<(), EngineError> {
        let next = self.params.merged(params)?;
        if next == self.params {
            return Ok(());
        }
        let previous = std::mem::replace(&mut self.params, next);
        let p = &self.params;
        if p.direction_deg != previous.direction_deg || p.resolution != previous.resolution || p.boundary != previous.boundary {
            // The lattice itself changes.
            self.backoff = 0;
            self.geo = Geometry::build(ctx, scene, &self.params);
            self.rebuild_buffers(ctx);
            self.restart(ctx);
            return Ok(());
        }
        // Compared with a margin: above the ceiling a faster wind only rescales the output.
        if (self.geo.lattice_speed(p.speed) - self.geo.lattice_speed(previous.speed)).abs() > 1e-6 {
            self.backoff = 0;
            self.restart(ctx);
            return Ok(());
        }
        // Everything else keeps the flow and lets it adapt.
        if p.trees != previous.trees {
            self.geo.fill_aux(&self.params);
            if let Some(gpu) = &self.gpu {
                gpu.upload_aux(ctx, &self.geo);
            }
        }
        if p.trees != previous.trees || p.viscosity != previous.viscosity || p.force != previous.force {
            self.unsettle(ctx)?;
        } else {
            // Only the wind speed changed, inside the range where it just scales the output.
            self.revision += 1;
        }
        Ok(())
    }

    fn scene_changed(&mut self, ctx: &Context, scene: &Scene) -> Result<(), EngineError> {
        self.backoff = 0;
        self.geo = Geometry::build(ctx, scene, &self.params);
        self.rebuild_buffers(ctx);
        self.restart(ctx);
        Ok(())
    }

    fn step(&mut self, ctx: &Context, _scene: &Scene, budget: Duration) -> Result<JobStatus, EngineError> {
        if self.settled() {
            return Ok(self.status());
        }
        let started = Instant::now();
        let first = self.steps;
        loop {
            // Size the batch to what is left of the budget, from the cost of the last one.
            let left = budget.saturating_sub(started.elapsed()).as_secs_f64();
            let count = match self.step_cost {
                Some(cost) if cost > 0.0 => ((left / cost) as usize).clamp(1, MAX_BATCH),
                _ => 1,
            };
            // Never run past a convergence check, so both backends check at the same steps.
            let until_check = (self.reference_step + CHECK_INTERVAL).saturating_sub(self.steps).max(1) as usize;
            let count = count.min(until_check);
            let batch = Instant::now();
            self.advance(ctx, count)?;
            self.step_cost = Some(batch.elapsed().as_secs_f64() / count as f64);
            if self.steps - self.reference_step >= CHECK_INTERVAL && (!self.check(ctx)? || self.settled()) {
                break;
            }
            if started.elapsed() >= budget {
                break;
            }
        }
        let elapsed = started.elapsed().as_secs_f64();
        if self.steps > first && elapsed > 0.0 {
            self.rate = (self.steps - first) as f64 / elapsed;
        }
        self.revision += 1;
        Ok(self.status())
    }

    fn read(&mut self, ctx: &Context, _scene: &Scene, field: &str) -> Result<Field, EngineError> {
        if !FIELDS.iter().any(|f| f.name == field) {
            return Err(EngineError::UnknownField(field.to_string()));
        }
        self.sync_macros(ctx)?;
        let scale = self.scale();
        let range = RANGE_FACTOR * self.params.speed;
        // The components' range puts zero exactly on a quantisation step (128 of 255),
        // so a still cell stays still after 8-bit encoding.
        let negative = -range * 128.0 / 127.0;
        let cells = self.macros.as_chunks::<3>().0.iter();
        let (min, data): (f32, Vec<f32>) = match field {
            "speed" => (0.0, cells.map(|m| (m[0] * m[0] + m[1] * m[1]).sqrt() * scale).collect()),
            "u" => (negative, cells.map(|m| m[0] * scale).collect()),
            _ => (negative, cells.map(|m| m[1] * scale).collect()),
        };
        Ok(Field { width: self.geo.vw as u32, height: self.geo.vh as u32, units: "m/s", min, max: range, data })
    }
}
