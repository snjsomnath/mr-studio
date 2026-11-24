use crate::{Context, EngineError, Grid};

/// A cell is solid when the top surface is this far above the ground.
pub const SOLID_THRESHOLD_M: f32 = 0.5;

/// The rasters a site provides. All have `grid.len()` values.
#[derive(Debug, Clone)]
pub struct SceneData {
    pub grid: Grid,
    /// Ground elevation.
    pub dtm: Vec<f32>,
    /// Top surface: ground plus buildings and other solid obstacles.
    pub dsm: Vec<f32>,
    /// Tree canopy height above ground, 0 where there is none.
    pub canopy: Vec<f32>,
    /// 1 where the ground is water (a river, a lake, the sea), else 0 (#343).
    pub water: Vec<u8>,
}

impl SceneData {
    pub fn flat(grid: Grid) -> Self {
        let n = grid.len();
        Self { grid, dtm: vec![0.0; n], dsm: vec![0.0; n], canopy: vec![0.0; n], water: vec![0; n] }
    }
}

pub struct SceneGpu {
    pub dtm: wgpu::Buffer,
    pub dsm: wgpu::Buffer,
    pub canopy: wgpu::Buffer,
}

/// The shared geometry every kernel reads, held on the CPU and (on the GPU backend) in GPU buffers.
pub struct Scene {
    pub grid: Grid,
    pub dtm: Vec<f32>,
    pub dsm: Vec<f32>,
    pub canopy: Vec<f32>,
    /// 1 where the ground is water.
    pub water: Vec<u8>,
    /// Highest point of the top surface or canopy.
    pub max_height: f32,
    /// Lowest point of the top surface.
    pub min_height: f32,
    pub revision: u64,
    pub gpu: Option<SceneGpu>,
}

impl Scene {
    pub(crate) fn new(ctx: &Context, data: SceneData, revision: u64) -> Result<Self, EngineError> {
        let n = data.grid.len();
        if n == 0 || !(data.grid.cell_m > 0.0) {
            return Err(EngineError::InvalidScene("grid is empty".into()));
        }
        for (name, raster) in [("dtm", &data.dtm), ("dsm", &data.dsm), ("canopy", &data.canopy)] {
            if raster.len() != n {
                return Err(EngineError::InvalidScene(format!("{name} has {} values, grid has {n}", raster.len())));
            }
            if raster.iter().any(|v| !v.is_finite()) {
                return Err(EngineError::InvalidScene(format!("{name} contains non-finite values")));
            }
        }
        if data.water.len() != n {
            return Err(EngineError::InvalidScene(format!("water has {} values, grid has {n}", data.water.len())));
        }
        let (mut max_height, mut min_height) = (f32::MIN, f32::MAX);
        for i in 0..n {
            max_height = max_height.max(data.dsm[i]).max(data.dtm[i] + data.canopy[i]);
            min_height = min_height.min(data.dsm[i]);
        }
        let gpu = ctx.gpu.as_ref().map(|gpu| SceneGpu {
            dtm: gpu.storage_f32("scene.dtm", &data.dtm),
            dsm: gpu.storage_f32("scene.dsm", &data.dsm),
            canopy: gpu.storage_f32("scene.canopy", &data.canopy),
        });
        Ok(Self {
            grid: data.grid,
            dtm: data.dtm,
            dsm: data.dsm,
            canopy: data.canopy,
            water: data.water,
            max_height,
            min_height,
            revision,
            gpu,
        })
    }

    pub fn is_solid(&self, index: usize) -> bool {
        self.dsm[index] - self.dtm[index] > SOLID_THRESHOLD_M
    }
}
