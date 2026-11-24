//! Stormwater: rain running off roofs and terrain, pooling and draining, live.
//! Local inertial shallow water on a coarsened copy of the scene grid, stepped
//! in real time so the table shows the storm as it happens. Algorithm in
//! `cpu.rs`, contract in `docs/contracts/engine.md`.
//!
//! The lattice is the visible window (the site at the chosen resolution) with a
//! one-cell ring of outfall cells around it, which stay dry so water leaves at
//! the edge of the table.

mod cpu;

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use bytemuck::{Pod, Zeroable};
use serde_json::{json, Value};

use crate::{Backend, Context, EngineError, Field, FieldInfo, Job, JobState, JobStatus, Kernel, KernelInfo, KernelKind, Scene};

/// Cell flags, shared with kernel.wgsl.
pub(crate) const SOLID: u32 = 1;
pub(crate) const OUTFALL: u32 = 2;

const G: f32 = 9.81;
/// Courant number of the time step, and the depth the step is sized for at the
/// least. A deeper pool shortens the step at the next check.
const CFL: f32 = 0.35;
const H_REFERENCE: f32 = 2.0;
const DT_MAX: f32 = 1.0;
/// Infiltration is this many times faster under a full tree canopy.
const CANOPY_INFILTRATION: f32 = 3.0;
/// Checks (depth readback, settling, the time step) run this many steps apart.
const CHECK_INTERVAL: u64 = 100;
/// Settled when the mean depth changes by less than this share of the rain rate
/// (plus a floor for a dry run), this many checks in a row, after the minimum run time.
const SETTLED_SHARE: f32 = 0.01;
const SETTLED_FLOOR: f32 = 1e-8;
const SETTLED_CHECKS: u32 = 5;
const MIN_SECONDS: f64 = 300.0;
/// Wall time a real-time job may owe before the rest is dropped (it fell behind).
const MAX_DEBT: f64 = 0.5;
/// Depth display range in metres, and velocity range in m/s.
const DEPTH_RANGE: f32 = 1.0;
const VELOCITY_RANGE: f32 = 2.0;
/// Water at least this deep counts as flooded in the status.
const FLOODED_M: f32 = 0.1;
/// Most steps encoded into one GPU submission.
const MAX_BATCH: usize = 256;

const FIELDS: &[FieldInfo] = &[
    FieldInfo { name: "depth", units: "m", description: "Water depth on the ground" },
    FieldInfo { name: "speed", units: "m/s", description: "Speed of the running water" },
    FieldInfo { name: "u", units: "m/s", description: "Water velocity towards higher columns (the right of the table)" },
    FieldInfo { name: "v", units: "m/s", description: "Water velocity towards higher rows (the bottom of the table)" },
];

pub struct StormwaterKernel;

impl Kernel for StormwaterKernel {
    fn info(&self) -> KernelInfo {
        KernelInfo {
            id: "stormwater",
            kind: KernelKind::Iterative,
            params: json!({
                "type": "object",
                "properties": {
                    "rain_mm_h": { "type": "number", "minimum": 0, "maximum": 200, "default": 40, "description": "Rain intensity in mm per hour; 0 lets the site drain" },
                    "infiltration_mm_h": { "type": "number", "minimum": 0, "maximum": 100, "default": 5, "description": "How fast open ground soaks water up, mm per hour" },
                    "speed": { "type": "number", "minimum": 1, "maximum": 600, "default": 60, "description": "Simulated seconds per real second" },
                    "resolution": { "type": "number", "minimum": 32, "maximum": 1024, "default": 384, "description": "Lattice cells along the longer side of the site" },
                    "roofs": { "type": "boolean", "default": true, "description": "Rain on roofs drains to the ground at the nearest wall" },
                    "trees": { "type": "boolean", "default": true, "description": "Ground under trees soaks up water faster" },
                    "manning": { "type": "number", "minimum": 0.01, "maximum": 0.1, "default": 0.025, "description": "Manning roughness of the ground" },
                    "storm": { "type": "number", "default": 0, "description": "Changing it dries the site and starts the storm again" },
                    "pace": { "enum": ["realtime", "fast"], "default": "realtime", "description": "realtime follows the wall clock times speed; fast runs as fast as the budget allows" }
                }
            }),
            fields: FIELDS,
        }
    }

    fn create(&self, ctx: &Context, scene: &Scene, params: &Value) -> Result<Box<dyn Job>, EngineError> {
        let params = Params::default().merged(params)?;
        let geo = Geometry::build(scene, &params);
        let gpu = match ctx.backend {
            Backend::Gpu => Some(GpuState::new(ctx)),
            _ => None,
        };
        let mut job = StormJob {
            params,
            geo,
            dt: 0.0,
            steps: 0,
            seconds: 0.0,
            rain_m: 0.0,
            reference: Vec::new(),
            reference_seconds: 0.0,
            reference_step: 0,
            change: None,
            settled_checks: 0,
            deepest: 0.0,
            water_m3: 0.0,
            flooded_m2: 0.0,
            revision: 0,
            out: Vec::new(),
            out_step: 0,
            h: Vec::new(),
            qx: Vec::new(),
            qy: Vec::new(),
            gpu,
            step_cost: None,
            rate: 0.0,
            realtime: 0.0,
            meter: None,
            wall: None,
            debt: 0.0,
        };
        job.rebuild(ctx);
        Ok(Box::new(job))
    }
}

// ---- Params ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Pace {
    Realtime,
    Fast,
}

#[derive(Debug, Clone, PartialEq)]
struct Params {
    rain_mm_h: f32,
    infiltration_mm_h: f32,
    speed: f32,
    resolution: f32,
    roofs: bool,
    trees: bool,
    manning: f32,
    storm: f64,
    pace: Pace,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            rain_mm_h: 40.0,
            infiltration_mm_h: 5.0,
            speed: 60.0,
            resolution: 384.0,
            roofs: true,
            trees: true,
            manning: 0.025,
            storm: 0.0,
            pace: Pace::Realtime,
        }
    }
}

impl Params {
    /// Applies a JSON patch, validates types and clamps numbers to their ranges.
    fn merged(&self, patch: &Value) -> Result<Self, EngineError> {
        let bad = |m: &str| EngineError::InvalidParams(m.to_string());
        let map = patch.as_object().ok_or_else(|| bad("params must be an object"))?;
        let number = |value: &Value, name: &str| {
            value.as_f64().filter(|v| v.is_finite()).ok_or_else(|| EngineError::InvalidParams(format!("{name} must be a number")))
        };
        let boolean =
            |value: &Value, name: &str| value.as_bool().ok_or_else(|| EngineError::InvalidParams(format!("{name} must be a boolean")));
        let mut p = self.clone();
        for (key, value) in map {
            match key.as_str() {
                "rain_mm_h" => p.rain_mm_h = (number(value, key)? as f32).clamp(0.0, 200.0),
                "infiltration_mm_h" => p.infiltration_mm_h = (number(value, key)? as f32).clamp(0.0, 100.0),
                "speed" => p.speed = (number(value, key)? as f32).clamp(1.0, 600.0),
                "resolution" => p.resolution = (number(value, key)? as f32).round().clamp(32.0, 1024.0),
                "manning" => p.manning = (number(value, key)? as f32).clamp(0.01, 0.1),
                "storm" => p.storm = number(value, key)?,
                "roofs" => p.roofs = boolean(value, key)?,
                "trees" => p.trees = boolean(value, key)?,
                "pace" => {
                    p.pace = match value.as_str() {
                        Some("realtime") => Pace::Realtime,
                        Some("fast") => Pace::Fast,
                        _ => return Err(bad("pace must be 'realtime' or 'fast'")),
                    }
                }
                other => return Err(EngineError::InvalidParams(format!("unknown param '{other}'"))),
            }
        }
        Ok(p)
    }
}

/// Millimetres per hour to metres per second.
fn mm_h(value: f32) -> f32 {
    value / 3_600_000.0
}

// ---- Geometry --------------------------------------------------------------

/// The lattice for one scene and resolution.
struct Geometry {
    nx: usize,
    ny: usize,
    /// The visible window: the site at lattice resolution, inside the outfall ring.
    vw: usize,
    vh: usize,
    factor: usize,
    cell_m: f32,
    cells: Vec<u32>,
    bed: Vec<f32>,
    /// Share of each cell under tree canopy.
    coverage: Vec<f32>,
    /// Ground cell each roof cell drains to, if any.
    drain: Vec<Option<usize>>,
    /// Per cell: rain multiplier, infiltration multiplier.
    aux: Vec<f32>,
    /// Number of cells rain falls on (ground plus the roofs that drain to it).
    catchment: usize,
}

impl Geometry {
    fn build(scene: &Scene, params: &Params) -> Self {
        let (gw, gh) = (scene.grid.width as usize, scene.grid.height as usize);
        let longer = gw.max(gh);
        let factor = ((longer as f32 / params.resolution).round() as usize).max(1);
        let vw = gw.div_ceil(factor).max(3);
        let vh = gh.div_ceil(factor).max(3);
        let (nx, ny) = (vw + 2, vh + 2);
        let mut cells = vec![0u32; nx * ny];
        let mut bed = vec![0.0f32; nx * ny];
        let mut coverage = vec![0.0f32; nx * ny];
        for j in 0..vh {
            for i in 0..vw {
                // A lattice cell is a building when at least half of its scene cells are.
                // Its bed is the mean ground of the open scene cells inside it.
                let (mut total, mut built, mut treed, mut wet) = (0u32, 0u32, 0u32, 0u32);
                let (mut ground, mut open, mut all) = (0.0f64, 0u32, 0.0f64);
                for row in (j * factor)..((j + 1) * factor).min(gh) {
                    for col in (i * factor)..((i + 1) * factor).min(gw) {
                        let index = row * gw + col;
                        total += 1;
                        all += scene.dtm[index] as f64;
                        if scene.is_solid(index) {
                            built += 1;
                        } else {
                            open += 1;
                            ground += scene.dtm[index] as f64;
                            treed += (scene.canopy[index] > 0.0) as u32;
                            wet += (scene.water[index] != 0) as u32;
                        }
                    }
                }
                let n = (j + 1) * nx + i + 1;
                if total == 0 {
                    continue;
                }
                bed[n] = if open > 0 { (ground / open as f64) as f32 } else { (all / total as f64) as f32 };
                if built * 2 >= total {
                    cells[n] = SOLID;
                } else if wet * 2 >= total {
                    // A river, a lake or the sea takes what runs into it, like the edge of the table (#343).
                    cells[n] = OUTFALL;
                } else {
                    coverage[n] = treed as f32 / total as f32;
                }
            }
        }
        // The outfall ring sits at the height of the cell inside it, so water spills out level.
        for y in 0..ny {
            for x in 0..nx {
                if x == 0 || y == 0 || x == nx - 1 || y == ny - 1 {
                    let inner = y.clamp(1, vh) * nx + x.clamp(1, vw);
                    bed[y * nx + x] = bed[inner];
                    cells[y * nx + x] = OUTFALL;
                }
            }
        }
        let drain = drains(nx, ny, &cells);
        let mut geo = Self {
            nx,
            ny,
            vw,
            vh,
            factor,
            cell_m: scene.grid.cell_m * factor as f32,
            cells,
            bed,
            coverage,
            drain,
            aux: vec![0.0; nx * ny * 2],
            catchment: 0,
        };
        geo.fill_aux(params);
        geo
    }

    /// Rain and infiltration multipliers per cell.
    fn fill_aux(&mut self, params: &Params) {
        self.aux.fill(0.0);
        let mut catchment = 0;
        for n in 0..self.nx * self.ny {
            if self.cells[n] == 0 {
                self.aux[n * 2] += 1.0;
                catchment += 1;
                let canopy = if params.trees { self.coverage[n] } else { 0.0 };
                self.aux[n * 2 + 1] = 1.0 + (CANOPY_INFILTRATION - 1.0) * canopy;
            } else if self.cells[n] & SOLID != 0 && params.roofs {
                if let Some(target) = self.drain[n] {
                    self.aux[target * 2] += 1.0;
                    catchment += 1;
                }
            }
        }
        self.catchment = catchment;
    }

    fn lattice(&self) -> cpu::Lattice<'_> {
        cpu::Lattice { nx: self.nx, ny: self.ny, cells: &self.cells, bed: &self.bed, aux: &self.aux }
    }

    fn visible_len(&self) -> usize {
        self.vw * self.vh
    }
}

/// For every building cell, the nearest open ground cell (by steps through the
/// building), where its roof's rain comes down. Breadth first from all open cells.
fn drains(nx: usize, ny: usize, cells: &[u32]) -> Vec<Option<usize>> {
    let mut drain = vec![None; nx * ny];
    let mut queue = VecDeque::new();
    for (n, &flags) in cells.iter().enumerate() {
        if flags == 0 {
            drain[n] = Some(n);
            queue.push_back(n);
        }
    }
    while let Some(n) = queue.pop_front() {
        let (x, y) = (n % nx, n / nx);
        let target = drain[n];
        for (dx, dy) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
            let (sx, sy) = (x as i32 + dx, y as i32 + dy);
            if sx < 0 || sy < 0 || sx >= nx as i32 || sy >= ny as i32 {
                continue;
            }
            let m = sy as usize * nx + sx as usize;
            if cells[m] & SOLID != 0 && drain[m].is_none() {
                drain[m] = target;
                queue.push_back(m);
            }
        }
    }
    // Open cells are not drains of themselves in the result.
    for (n, &flags) in cells.iter().enumerate() {
        if flags & SOLID == 0 {
            drain[n] = None;
        }
    }
    drain
}

#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub(crate) struct Pass {
    nx: u32,
    ny: u32,
    dt: f32,
    g: f32,
    manning2: f32,
    cell_m: f32,
    rain: f32,
    infiltration: f32,
}

// ---- GPU -------------------------------------------------------------------

struct GpuBuffers {
    aux: wgpu::Buffer,
    h: wgpu::Buffer,
    qx: wgpu::Buffer,
    qy: wgpu::Buffer,
    out: wgpu::Buffer,
    group: wgpu::BindGroup,
    len: usize,
}

struct GpuState {
    faces: wgpu::ComputePipeline,
    cells: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    uniforms: wgpu::Buffer,
    buffers: Option<GpuBuffers>,
}

impl GpuState {
    fn new(ctx: &Context) -> Self {
        let gpu = ctx.gpu();
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
            label: Some("stormwater"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<Pass>() as u64),
                    },
                    count: None,
                },
                storage(1, true),
                storage(2, true),
                storage(3, true),
                storage(4, false),
                storage(5, false),
                storage(6, false),
                storage(7, false),
            ],
        });
        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("stormwater"),
            source: wgpu::ShaderSource::Wgsl(include_str!("kernel.wgsl").into()),
        });
        let pipeline_layout = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("stormwater"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = |entry: &str| {
            gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("stormwater"),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let (faces, cells) = (pipeline("faces"), pipeline("cells"));
        let uniforms = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("stormwater.pass"),
            size: std::mem::size_of::<Pass>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Self { faces, cells, layout, uniforms, buffers: None }
    }

    /// Allocates the buffers for a geometry, uploads its fixed data and starts dry.
    fn allocate(&mut self, ctx: &Context, geo: &Geometry) {
        let gpu = ctx.gpu();
        let n = geo.nx * geo.ny;
        let flags = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("stormwater.flags"),
            size: (n * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        gpu.queue.write_buffer(&flags, 0, bytemuck::cast_slice(&geo.cells));
        let bed = gpu.storage_f32("stormwater.bed", &geo.bed);
        let aux = gpu.storage_f32("stormwater.aux", &geo.aux);
        let zeros = vec![0.0f32; n];
        let h = gpu.storage_f32("stormwater.h", &zeros);
        let qx = gpu.storage_f32("stormwater.qx", &zeros);
        let qy = gpu.storage_f32("stormwater.qy", &zeros);
        let out = gpu.storage_f32("stormwater.out", &vec![0.0f32; geo.visible_len() * 3]);
        fn whole(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry { binding, resource: buffer.as_entire_binding() }
        }
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("stormwater"),
            layout: &self.layout,
            entries: &[
                whole(0, &self.uniforms),
                whole(1, &flags),
                whole(2, &bed),
                whole(3, &aux),
                whole(4, &h),
                whole(5, &qx),
                whole(6, &qy),
                whole(7, &out),
            ],
        });
        self.buffers = Some(GpuBuffers { aux, h, qx, qy, out, group, len: n });
    }

    fn upload_aux(&self, ctx: &Context, geo: &Geometry) {
        let buffers = self.buffers.as_ref().expect("stormwater buffers");
        ctx.gpu().queue.write_buffer(&buffers.aux, 0, bytemuck::cast_slice(&geo.aux));
    }

    /// Dries the site.
    fn clear(&self, ctx: &Context) {
        let buffers = self.buffers.as_ref().expect("stormwater buffers");
        let zeros = vec![0.0f32; buffers.len];
        for buffer in [&buffers.h, &buffers.qx, &buffers.qy] {
            ctx.gpu().queue.write_buffer(buffer, 0, bytemuck::cast_slice(&zeros));
        }
    }

    /// Runs `count` steps of one pass in one submission and waits for them.
    fn run(&mut self, ctx: &Context, pass: &Pass, count: usize) -> Result<(), EngineError> {
        let gpu = ctx.gpu();
        let buffers = self.buffers.as_ref().expect("stormwater buffers");
        gpu.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(pass));
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut compute = encoder.begin_compute_pass(&Default::default());
            compute.set_bind_group(0, &buffers.group, &[]);
            let (wx, wy) = (pass.nx.div_ceil(8), pass.ny.div_ceil(8));
            for _ in 0..count {
                compute.set_pipeline(&self.faces);
                compute.dispatch_workgroups(wx, wy, 1);
                compute.set_pipeline(&self.cells);
                compute.dispatch_workgroups(wx, wy, 1);
            }
        }
        gpu.queue.submit([encoder.finish()]);
        gpu.wait()
    }
}

// ---- Job -------------------------------------------------------------------

struct StormJob {
    params: Params,
    geo: Geometry,
    /// Seconds of storm per step.
    dt: f32,
    steps: u64,
    /// Simulated seconds since the storm started.
    seconds: f64,
    /// Rain fallen since the storm started, metres.
    rain_m: f64,
    /// Depths of the visible window at the last check, for the settling measure.
    reference: Vec<f32>,
    reference_seconds: f64,
    reference_step: u64,
    /// Mean depth change per second at the last check, m/s.
    change: Option<f32>,
    settled_checks: u32,
    deepest: f32,
    water_m3: f32,
    flooded_m2: f32,
    revision: u64,
    /// (u, v, depth) of the visible window at `out_step`.
    out: Vec<f32>,
    out_step: u64,
    /// CPU backend state: depth per cell, discharge per unit width through east and south faces.
    h: Vec<f32>,
    qx: Vec<f32>,
    qy: Vec<f32>,
    gpu: Option<GpuState>,
    /// Seconds one step took, from the last batch.
    step_cost: Option<f64>,
    /// Steps per wall second over the last `step` call.
    rate: f64,
    /// Simulated seconds per wall second, and where the last measurement started.
    realtime: f64,
    meter: Option<(Instant, f64)>,
    /// Wall clock of the last real-time step, and simulated seconds owed since.
    wall: Option<Instant>,
    debt: f64,
}

impl StormJob {
    /// Allocates the state for the current geometry and starts the storm dry.
    fn rebuild(&mut self, ctx: &Context) {
        let n = self.geo.nx * self.geo.ny;
        match &mut self.gpu {
            Some(gpu) => gpu.allocate(ctx, &self.geo),
            None => {
                self.h = vec![0.0; n];
                self.qx = vec![0.0; n];
                self.qy = vec![0.0; n];
            }
        }
        self.restart(ctx);
    }

    /// Dries the site and starts the storm from its first second.
    fn restart(&mut self, ctx: &Context) {
        match &self.gpu {
            Some(gpu) => gpu.clear(ctx),
            None => {
                self.h.fill(0.0);
                self.qx.fill(0.0);
                self.qy.fill(0.0);
            }
        }
        self.out = vec![0.0; self.geo.visible_len() * 3];
        self.out_step = 0;
        self.steps = 0;
        self.seconds = 0.0;
        self.rain_m = 0.0;
        self.reference = vec![0.0; self.geo.visible_len()];
        self.reference_seconds = 0.0;
        self.reference_step = 0;
        self.change = None;
        self.settled_checks = 0;
        self.deepest = 0.0;
        self.water_m3 = 0.0;
        self.flooded_m2 = 0.0;
        self.dt = self.time_step(0.0);
        self.wall = None;
        self.debt = 0.0;
        self.meter = None;
        self.revision += 1;
    }

    /// The step for the deepest water: a Courant number of `CFL` for gravity waves.
    fn time_step(&self, deepest: f32) -> f32 {
        let depth = H_REFERENCE.max(deepest * 1.5);
        (CFL * self.geo.cell_m / (G * depth).sqrt()).min(DT_MAX)
    }

    fn pass(&self) -> Pass {
        Pass {
            nx: self.geo.nx as u32,
            ny: self.geo.ny as u32,
            dt: self.dt,
            g: G,
            manning2: self.params.manning * self.params.manning,
            cell_m: self.geo.cell_m,
            rain: mm_h(self.params.rain_mm_h),
            infiltration: mm_h(self.params.infiltration_mm_h),
        }
    }

    /// The storm keeps its water but has to settle again.
    fn unsettle(&mut self) {
        self.settled_checks = 0;
        self.change = None;
        self.revision += 1;
    }

    fn settled(&self) -> bool {
        self.seconds >= MIN_SECONDS && self.settled_checks >= SETTLED_CHECKS
    }

    /// Brings `out` up to the current step.
    fn sync_out(&mut self, ctx: &Context) -> Result<(), EngineError> {
        if self.out_step != self.steps {
            if let Some(gpu) = &self.gpu {
                let buffers = gpu.buffers.as_ref().expect("stormwater buffers");
                self.out = ctx.gpu().read_f32(&buffers.out, self.geo.visible_len() * 3)?;
            }
            self.out_step = self.steps;
        }
        Ok(())
    }

    fn advance(&mut self, ctx: &Context, count: usize) -> Result<(), EngineError> {
        let pass = self.pass();
        if let Some(gpu) = &mut self.gpu {
            gpu.run(ctx, &pass, count)?;
        } else {
            let lat = self.geo.lattice();
            for _ in 0..count {
                cpu::faces(&lat, &pass, &self.h, &mut self.qx, &mut self.qy, ctx.threads);
                cpu::cells(&lat, &pass, &mut self.h, &self.qx, &self.qy, &mut self.out, ctx.threads);
            }
            self.out_step = self.steps + count as u64;
        }
        self.steps += count as u64;
        self.seconds += pass.dt as f64 * count as f64;
        self.rain_m += pass.rain as f64 * pass.dt as f64 * count as f64;
        Ok(())
    }

    /// Reads the depths back: the totals, how much they still change, and the next time step.
    fn check(&mut self, ctx: &Context) -> Result<(), EngineError> {
        self.sync_out(ctx)?;
        let area = self.geo.cell_m * self.geo.cell_m;
        let (mut sum, mut open) = (0.0f64, 0u64);
        let (mut deepest, mut water, mut flooded) = (0.0f32, 0.0f64, 0u64);
        for i in 0..self.geo.visible_len() {
            let depth = self.out[i * 3 + 2];
            if !depth.is_finite() {
                return Err(EngineError::Unstable(format!("stormwater depth is not finite at step {}", self.steps)));
            }
            let (x, y) = (1 + i % self.geo.vw, 1 + i / self.geo.vw);
            if self.geo.cells[y * self.geo.nx + x] != 0 {
                continue;
            }
            sum += (depth - self.reference[i]).abs() as f64;
            open += 1;
            deepest = deepest.max(depth);
            water += depth as f64;
            flooded += (depth >= FLOODED_M) as u64;
            self.reference[i] = depth;
        }
        let interval = (self.seconds - self.reference_seconds).max(1e-9);
        let change = (sum / open.max(1) as f64 / interval) as f32;
        let threshold = SETTLED_SHARE * mm_h(self.params.rain_mm_h) + SETTLED_FLOOR;
        self.settled_checks = if change < threshold { self.settled_checks + 1 } else { 0 };
        self.change = Some(change);
        self.reference_seconds = self.seconds;
        self.reference_step = self.steps;
        self.deepest = deepest;
        self.water_m3 = (water * area as f64) as f32;
        self.flooded_m2 = flooded as f32 * area;
        self.dt = self.time_step(deepest);
        Ok(())
    }

    /// Steps owed to the wall clock: all the budget allows when running fast.
    fn owed(&mut self, budget: Duration) -> Option<u64> {
        if self.params.pace == Pace::Fast {
            return None;
        }
        let now = Instant::now();
        if let Some(last) = self.wall {
            let elapsed = now.duration_since(last).as_secs_f64().min(MAX_DEBT);
            self.debt = (self.debt + elapsed * self.params.speed as f64).min(MAX_DEBT * self.params.speed as f64);
        }
        self.wall = Some(now);
        let due = (self.debt / self.dt as f64).floor() as u64;
        if due == 0 && !budget.is_zero() {
            // Nothing is due yet: wait for the next step inside this slice rather than spin.
            let wait = (self.dt as f64 - self.debt) / self.params.speed as f64;
            std::thread::sleep(Duration::from_secs_f64(wait.max(0.0)).min(budget));
        }
        Some(due)
    }

    fn status(&self) -> JobStatus {
        let settled = self.settled();
        let area = self.geo.cell_m * self.geo.cell_m;
        JobStatus {
            state: if settled { JobState::Done } else { JobState::Running },
            progress: if settled { 1.0 } else { (self.seconds / MIN_SECONDS).min(0.99) as f32 },
            revision: self.revision,
            info: json!({
                "steps": self.steps,
                "seconds": self.seconds,
                "minutes": self.seconds / 60.0,
                "settled": settled,
                "change": self.change,
                "dt": self.dt,
                "rain_mm": self.rain_m * 1000.0,
                "rain_m3": self.rain_m * self.geo.catchment as f64 * area as f64,
                "water_m3": self.water_m3,
                "deepest_m": self.deepest,
                "flooded_m2": self.flooded_m2,
                "steps_per_second": self.rate,
                "realtime": self.realtime,
                "lattice": { "width": self.geo.vw, "height": self.geo.vh, "cell_m": self.geo.cell_m, "factor": self.geo.factor },
            }),
        }
    }
}

impl Job for StormJob {
    fn set_params(&mut self, ctx: &Context, scene: &Scene, params: &Value) -> Result<(), EngineError> {
        let next = self.params.merged(params)?;
        if next == self.params {
            return Ok(());
        }
        let previous = std::mem::replace(&mut self.params, next);
        let p = &self.params;
        if p.resolution != previous.resolution {
            self.geo = Geometry::build(scene, &self.params);
            self.rebuild(ctx);
            return Ok(());
        }
        if p.storm != previous.storm {
            self.restart(ctx);
            return Ok(());
        }
        if p.roofs != previous.roofs || p.trees != previous.trees {
            self.geo.fill_aux(&self.params);
            if let Some(gpu) = &self.gpu {
                gpu.upload_aux(ctx, &self.geo);
            }
        }
        if p.pace != previous.pace {
            self.wall = None;
            self.debt = 0.0;
        }
        // Rain, soaking and roughness change the water from here on; the water already there stays.
        self.unsettle();
        Ok(())
    }

    fn scene_changed(&mut self, ctx: &Context, scene: &Scene) -> Result<(), EngineError> {
        self.geo = Geometry::build(scene, &self.params);
        self.rebuild(ctx);
        Ok(())
    }

    fn step(&mut self, ctx: &Context, _scene: &Scene, budget: Duration) -> Result<JobStatus, EngineError> {
        if self.settled() {
            self.wall = None;
            self.debt = 0.0;
            return Ok(self.status());
        }
        let started = Instant::now();
        let first = self.steps;
        let mut due = self.owed(budget);
        loop {
            // Size the batch to what is left of the budget, from the cost of the last one.
            let left = budget.saturating_sub(started.elapsed()).as_secs_f64();
            let mut count = match self.step_cost {
                Some(cost) if cost > 0.0 => ((left / cost) as usize).clamp(1, MAX_BATCH),
                _ => 1,
            };
            if let Some(due) = due {
                count = count.min(due as usize);
            }
            // Never run past a check, so both backends check at the same steps.
            let until_check = (self.reference_step + CHECK_INTERVAL).saturating_sub(self.steps).max(1) as usize;
            let count = count.min(until_check);
            if count == 0 {
                break;
            }
            let batch = Instant::now();
            self.advance(ctx, count)?;
            self.step_cost = Some(batch.elapsed().as_secs_f64() / count as f64);
            if let Some(d) = due.as_mut() {
                *d -= count as u64;
            }
            if self.params.pace == Pace::Realtime {
                self.debt = (self.debt - count as f64 * self.dt as f64).max(0.0);
            }
            if self.steps - self.reference_step >= CHECK_INTERVAL {
                self.check(ctx)?;
                if self.settled() {
                    break;
                }
            }
            if started.elapsed() >= budget {
                break;
            }
        }
        let elapsed = started.elapsed().as_secs_f64();
        if self.steps > first {
            if elapsed > 0.0 {
                self.rate = (self.steps - first) as f64 / elapsed;
            }
            self.revision += 1;
        }
        // Storm seconds per wall second, measured over about a second of wall time between calls.
        let now = Instant::now();
        match self.meter {
            Some((at, seconds)) if now.duration_since(at).as_secs_f64() >= 1.0 => {
                self.realtime = (self.seconds - seconds) / now.duration_since(at).as_secs_f64();
                self.meter = Some((now, self.seconds));
            }
            Some(_) => {}
            None => self.meter = Some((now, self.seconds)),
        }
        Ok(self.status())
    }

    fn read(&mut self, ctx: &Context, _scene: &Scene, field: &str) -> Result<Field, EngineError> {
        if !FIELDS.iter().any(|f| f.name == field) {
            return Err(EngineError::UnknownField(field.to_string()));
        }
        self.sync_out(ctx)?;
        let cells = self.out.chunks_exact(3);
        // The components' range puts zero exactly on a quantisation step (128 of 255),
        // so still water stays still after 8-bit encoding.
        let negative = -VELOCITY_RANGE * 128.0 / 127.0;
        let (units, min, max, data): (&'static str, f32, f32, Vec<f32>) = match field {
            "depth" => ("m", 0.0, DEPTH_RANGE, cells.map(|m| m[2]).collect()),
            "speed" => ("m/s", 0.0, VELOCITY_RANGE, cells.map(|m| (m[0] * m[0] + m[1] * m[1]).sqrt()).collect()),
            "u" => ("m/s", negative, VELOCITY_RANGE, cells.map(|m| m[0]).collect()),
            _ => ("m/s", negative, VELOCITY_RANGE, cells.map(|m| m[1]).collect()),
        };
        Ok(Field { width: self.geo.vw as u32, height: self.geo.vh as u32, units, min, max, data })
    }
}
