use serde::Serialize;

use crate::EngineError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    /// GPU when an adapter exists, otherwise the CPU reference.
    Auto,
    Gpu,
    Cpu,
}

impl Backend {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "gpu" => Some(Self::Gpu),
            "cpu" => Some(Self::Cpu),
            _ => None,
        }
    }
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter: String,
}

/// What a kernel needs to run: the resolved backend and, on the GPU backend, the device.
pub struct Context {
    /// Never `Auto` once constructed.
    pub backend: Backend,
    pub gpu: Option<Gpu>,
    /// Worker threads for the CPU reference.
    pub threads: usize,
}

impl Context {
    pub fn new(requested: Backend) -> Result<Self, EngineError> {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        if requested == Backend::Cpu {
            return Ok(Self { backend: Backend::Cpu, gpu: None, threads });
        }
        match pollster::block_on(request_gpu()) {
            Ok(gpu) => Ok(Self { backend: Backend::Gpu, gpu: Some(gpu), threads }),
            Err(e) if requested == Backend::Auto => {
                tracing::warn!("no GPU adapter ({e}); using the CPU reference backend");
                Ok(Self { backend: Backend::Cpu, gpu: None, threads })
            }
            Err(e) => Err(EngineError::NoGpu(e)),
        }
    }

    pub fn gpu(&self) -> &Gpu {
        self.gpu.as_ref().expect("gpu backend without a device")
    }
}

async fn request_gpu() -> Result<Gpu, String> {
    let instance = wgpu::Instance::default();
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })
        .await
        .map_err(|e| e.to_string())?;
    let info = adapter.get_info();
    let limits = adapter.limits();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("mrs-engine"),
            required_limits: wgpu::Limits {
                max_storage_buffer_binding_size: limits.max_storage_buffer_binding_size,
                max_buffer_size: limits.max_buffer_size,
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(Gpu { device, queue, adapter: format!("{} ({:?})", info.name, info.backend) })
}

impl Gpu {
    /// Copies a storage buffer of f32 values back to the CPU.
    pub fn read_f32(&self, buffer: &wgpu::Buffer, len: usize) -> Result<Vec<f32>, EngineError> {
        let size = (len * 4) as u64;
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, size);
        self.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.wait()?;
        rx.recv().map_err(|e| EngineError::Gpu(e.to_string()))?.map_err(|e| EngineError::Gpu(e.to_string()))?;
        let view = staging.slice(..).get_mapped_range().map_err(|e| EngineError::Gpu(e.to_string()))?;
        let out = bytemuck::cast_slice::<u8, f32>(&view).to_vec();
        drop(view);
        staging.unmap();
        Ok(out)
    }

    /// Blocks until submitted work has finished.
    pub fn wait(&self) -> Result<(), EngineError> {
        self.device
            .poll(wgpu::PollType::Wait { submission_index: None, timeout: None })
            .map(|_| ())
            .map_err(|e| EngineError::Gpu(e.to_string()))
    }

    pub fn storage_f32(&self, label: &str, data: &[f32]) -> wgpu::Buffer {
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: (data.len() * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        self.queue.write_buffer(&buffer, 0, bytemuck::cast_slice(data));
        buffer
    }
}
