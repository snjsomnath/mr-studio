//! Sunlight: a shadow mask for one instant, or hours of direct sun over a day.
//! Contract in `docs/contracts/engine.md`.

mod cpu;

use std::time::{Duration, Instant};

use bytemuck::{Pod, Zeroable};
use serde_json::{json, Value};

use crate::solar::{solar_day_start, sun_position, SunPosition};
use crate::time::parse_rfc3339;
use crate::{Backend, Context, EngineError, Field, FieldInfo, Job, JobState, JobStatus, Kernel, KernelInfo, KernelKind, Scene};

/// The sun counts as up above this altitude. Below it shadows are longer than any site.
const MIN_ALTITUDE_DEG: f64 = 0.5;
/// Light lost per metre of tree canopy crossed.
const CANOPY_EXTINCTION_PER_M: f32 = 0.15;

const FIELDS: &[FieldInfo] = &[
    FieldInfo { name: "shadow", units: "0..1", description: "1 where the cell is lit at `time`, 0 in shadow or at night (instant mode)" },
    FieldInfo { name: "sun_hours", units: "h", description: "Hours of direct sun on the day of `time` (day mode)" },
];

pub struct SunlightKernel;

impl Kernel for SunlightKernel {
    fn info(&self) -> KernelInfo {
        KernelInfo {
            id: "sunlight",
            kind: KernelKind::Progressive,
            params: json!({
                "type": "object",
                "required": ["time", "lat", "lon"],
                "properties": {
                    "mode": { "enum": ["instant", "day"], "default": "instant" },
                    "time": { "type": "string", "format": "date-time", "description": "RFC 3339, or Unix seconds as a number" },
                    "lat": { "type": "number", "minimum": -90, "maximum": 90 },
                    "lon": { "type": "number", "minimum": -180, "maximum": 180 },
                    "step_minutes": { "type": "number", "minimum": 5, "maximum": 60, "default": 15 },
                    "trees": { "type": "boolean", "default": true }
                }
            }),
            fields: FIELDS,
        }
    }

    fn create(&self, ctx: &Context, scene: &Scene, params: &Value) -> Result<Box<dyn Job>, EngineError> {
        let params = Params::default().merged(params)?;
        let gpu = match ctx.backend {
            Backend::Gpu => Some(GpuState::new(ctx, scene)),
            _ => None,
        };
        let mut job = SunlightJob {
            params,
            out: vec![0.0; scene.grid.len()],
            gpu,
            samples: Vec::new(),
            cursor: 0,
            revision: 0,
            sun: SunPosition { azimuth_deg: 0.0, altitude_deg: 0.0 },
            step_hours: 0.0,
        };
        job.plan(scene);
        Ok(Box::new(job))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    Instant,
    Day,
}

#[derive(Debug, Clone, PartialEq)]
struct Params {
    mode: Mode,
    time: Option<f64>,
    lat: Option<f64>,
    lon: Option<f64>,
    step_minutes: f64,
    trees: bool,
}

impl Default for Params {
    fn default() -> Self {
        Self { mode: Mode::Instant, time: None, lat: None, lon: None, step_minutes: 15.0, trees: true }
    }
}

impl Params {
    /// Applies a JSON patch and validates the result.
    fn merged(&self, patch: &Value) -> Result<Self, EngineError> {
        let bad = |m: &str| EngineError::InvalidParams(m.to_string());
        let map = patch.as_object().ok_or_else(|| bad("params must be an object"))?;
        let mut p = self.clone();
        for (key, value) in map {
            match key.as_str() {
                "mode" => {
                    p.mode = match value.as_str() {
                        Some("instant") => Mode::Instant,
                        Some("day") => Mode::Day,
                        _ => return Err(bad("mode must be 'instant' or 'day'")),
                    }
                }
                "time" => {
                    let t = match value {
                        Value::String(s) => parse_rfc3339(s),
                        Value::Number(n) => n.as_f64(),
                        _ => None,
                    };
                    p.time = Some(t.filter(|t| t.is_finite()).ok_or_else(|| bad("time must be an RFC 3339 string or Unix seconds"))?);
                }
                "lat" => p.lat = Some(value.as_f64().filter(|v| (-90.0..=90.0).contains(v)).ok_or_else(|| bad("lat must be -90..90"))?),
                "lon" => p.lon = Some(value.as_f64().filter(|v| (-180.0..=180.0).contains(v)).ok_or_else(|| bad("lon must be -180..180"))?),
                "step_minutes" => p.step_minutes = value.as_f64().ok_or_else(|| bad("step_minutes must be a number"))?.clamp(5.0, 60.0),
                "trees" => p.trees = value.as_bool().ok_or_else(|| bad("trees must be a boolean"))?,
                other => return Err(EngineError::InvalidParams(format!("unknown param '{other}'"))),
            }
        }
        if p.time.is_none() || p.lat.is_none() || p.lon.is_none() {
            return Err(bad("time, lat and lon are required"));
        }
        Ok(p)
    }
}

/// One sun position prepared for marching. Mirrors `Params` in kernel.wgsl.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub(crate) struct Ray {
    width: u32,
    height: u32,
    max_steps: u32,
    accumulate: u32,
    dir_col: f32,
    dir_row: f32,
    dz: f32,
    max_height: f32,
    weight: f32,
    canopy_t: f32,
    lit: f32,
    _pad: f32,
}

impl Ray {
    fn new(scene: &Scene, sun: SunPosition, trees: bool, weight: f32, accumulate: bool) -> Self {
        let grid = scene.grid;
        let up = sun.altitude_deg > MIN_ALTITUDE_DEG;
        let (dir_col, dir_row) = grid.bearing_to_cell_dir(sun.azimuth_deg);
        let dz = if up { (sun.altitude_deg.to_radians().tan() * grid.cell_m as f64) as f32 } else { 0.0 };
        let min_height = scene.dsm.iter().copied().fold(f32::MAX, f32::min);
        let reach = if up { ((scene.max_height - min_height) / dz).ceil() as u32 + 1 } else { 0 };
        Self {
            width: grid.width,
            height: grid.height,
            max_steps: reach.min(grid.width + grid.height),
            accumulate: accumulate as u32,
            dir_col: dir_col as f32,
            dir_row: dir_row as f32,
            dz,
            max_height: scene.max_height,
            weight,
            canopy_t: if trees { (-CANOPY_EXTINCTION_PER_M * grid.cell_m).exp() } else { 1.0 },
            lit: if up { 1.0 } else { 0.0 },
            _pad: 0.0,
        }
    }
}

struct GpuState {
    pipeline: wgpu::ComputePipeline,
    uniforms: wgpu::Buffer,
    out: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl GpuState {
    fn new(ctx: &Context, scene: &Scene) -> Self {
        let gpu = ctx.gpu();
        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("sunlight"),
            source: wgpu::ShaderSource::Wgsl(include_str!("kernel.wgsl").into()),
        });
        let pipeline = gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("sunlight"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let uniforms = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("sunlight.params"),
            size: std::mem::size_of::<Ray>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let (out, bind_group) = Self::bind(ctx, scene, &pipeline, &uniforms);
        Self { pipeline, uniforms, out, bind_group }
    }

    fn bind(ctx: &Context, scene: &Scene, pipeline: &wgpu::ComputePipeline, uniforms: &wgpu::Buffer) -> (wgpu::Buffer, wgpu::BindGroup) {
        let gpu = ctx.gpu();
        let rasters = scene.gpu.as_ref().expect("scene is not on the gpu");
        let out = gpu.storage_f32("sunlight.out", &vec![0.0; scene.grid.len()]);
        fn entry(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry { binding, resource: buffer.as_entire_binding() }
        }
        let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("sunlight"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[entry(0, uniforms), entry(1, &rasters.dsm), entry(2, &rasters.dtm), entry(3, &rasters.canopy), entry(4, &out)],
        });
        (out, bind_group)
    }

    fn rebind(&mut self, ctx: &Context, scene: &Scene) {
        let (out, bind_group) = Self::bind(ctx, scene, &self.pipeline, &self.uniforms);
        self.out = out;
        self.bind_group = bind_group;
    }

    fn dispatch(&self, ctx: &Context, ray: &Ray) {
        let gpu = ctx.gpu();
        gpu.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(ray));
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.dispatch_workgroups(ray.width.div_ceil(8), ray.height.div_ceil(8), 1);
        }
        gpu.queue.submit([encoder.finish()]);
    }
}

struct SunlightJob {
    params: Params,
    /// CPU backend output. Unused on the GPU backend.
    out: Vec<f32>,
    gpu: Option<GpuState>,
    /// Sun positions still to evaluate, in order.
    samples: Vec<SunPosition>,
    cursor: usize,
    revision: u64,
    sun: SunPosition,
    step_hours: f32,
}

impl SunlightJob {
    /// Rebuilds the work list from the current params and restarts.
    fn plan(&mut self, _scene: &Scene) {
        let (time, lat, lon) = (self.params.time.unwrap(), self.params.lat.unwrap(), self.params.lon.unwrap());
        self.sun = sun_position(time, lat, lon);
        self.samples.clear();
        self.cursor = 0;
        match self.params.mode {
            Mode::Instant => {
                self.step_hours = 0.0;
                self.samples.push(self.sun);
            }
            Mode::Day => {
                let step = self.params.step_minutes * 60.0;
                self.step_hours = (step / 3600.0) as f32;
                let start = solar_day_start(time, lon);
                let count = (86400.0 / step).round() as usize;
                for k in 0..count {
                    let sun = sun_position(start + (k as f64 + 0.5) * step, lat, lon);
                    if sun.altitude_deg > MIN_ALTITUDE_DEG {
                        self.samples.push(sun);
                    }
                }
                if self.samples.is_empty() {
                    // Polar night: one unlit pass clears the output.
                    self.samples.push(SunPosition { azimuth_deg: 0.0, altitude_deg: -90.0 });
                }
            }
        }
    }

    fn status(&self) -> JobStatus {
        let done = self.cursor >= self.samples.len();
        JobStatus {
            state: if done { JobState::Done } else { JobState::Running },
            progress: self.cursor as f32 / self.samples.len().max(1) as f32,
            revision: self.revision,
            info: json!({
                "sun": { "azimuth_deg": self.sun.azimuth_deg, "altitude_deg": self.sun.altitude_deg },
                "daylight_hours": self.daylight_hours(),
            }),
        }
    }

    fn daylight_hours(&self) -> f32 {
        match self.params.mode {
            Mode::Instant => 0.0,
            Mode::Day => self.samples.iter().filter(|s| s.altitude_deg > MIN_ALTITUDE_DEG).count() as f32 * self.step_hours,
        }
    }
}

impl Job for SunlightJob {
    fn set_params(&mut self, _ctx: &Context, scene: &Scene, params: &Value) -> Result<(), EngineError> {
        let next = self.params.merged(params)?;
        if next != self.params {
            self.params = next;
            self.plan(scene);
        }
        Ok(())
    }

    fn scene_changed(&mut self, ctx: &Context, scene: &Scene) -> Result<(), EngineError> {
        self.out = vec![0.0; scene.grid.len()];
        if let Some(gpu) = &mut self.gpu {
            gpu.rebind(ctx, scene);
        }
        self.plan(scene);
        Ok(())
    }

    fn step(&mut self, ctx: &Context, scene: &Scene, budget: Duration) -> Result<JobStatus, EngineError> {
        if self.cursor >= self.samples.len() {
            return Ok(self.status());
        }
        let started = Instant::now();
        let weight = match self.params.mode {
            Mode::Instant => 1.0,
            Mode::Day => self.step_hours,
        };
        while self.cursor < self.samples.len() {
            let ray = Ray::new(scene, self.samples[self.cursor], self.params.trees, weight, self.cursor > 0);
            match &self.gpu {
                Some(gpu) => {
                    gpu.dispatch(ctx, &ray);
                    // Submission is asynchronous; wait so the budget measures real work.
                    ctx.gpu().wait()?;
                }
                None => cpu::march(scene, &ray, &mut self.out, ctx.threads),
            }
            self.cursor += 1;
            if started.elapsed() >= budget {
                break;
            }
        }
        self.revision += 1;
        Ok(self.status())
    }

    fn read(&mut self, ctx: &Context, scene: &Scene, field: &str) -> Result<Field, EngineError> {
        let (units, max) = match (field, self.params.mode) {
            ("shadow", Mode::Instant) => ("0..1", 1.0),
            ("sun_hours", Mode::Day) => ("h", self.daylight_hours().max(self.step_hours)),
            _ => return Err(EngineError::UnknownField(field.to_string())),
        };
        let data = match &self.gpu {
            Some(gpu) => ctx.gpu().read_f32(&gpu.out, scene.grid.len())?,
            None => self.out.clone(),
        };
        Ok(Field { width: scene.grid.width, height: scene.grid.height, units, min: 0.0, max, data })
    }
}
