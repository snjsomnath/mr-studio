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
    /// Buildings around the table that only shape the wind (#488). Nothing draws them.
    pub context: Option<ContextRing>,
}

impl SceneData {
    pub fn flat(grid: Grid) -> Self {
        let n = grid.len();
        Self { grid, dtm: vec![0.0; n], dsm: vec![0.0; n], canopy: vec![0.0; n], water: vec![0; n], context: None }
    }
}

/// Buildings in a ring around the table (#488): a mask over the grid grown by `margin` cells on
/// every side, at the grid's cell size and turn. Row-major, `(width + 2 margin)` by `(height + 2 margin)`.
/// The wind kernel puts them in its padding, so wind reaching the table has passed real buildings.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextRing {
    pub margin: u32,
    /// 1 where a building stands. Cells inside the table itself are ignored: the scene has those.
    pub solid: Vec<u8>,
}

impl ContextRing {
    pub fn len_for(grid: &Grid, margin: u32) -> usize {
        (grid.width as usize + 2 * margin as usize) * (grid.height as usize + 2 * margin as usize)
    }

    /// Whether a grid cell, which may lie outside the grid by up to `margin`, holds a building.
    pub fn is_solid(&self, grid: &Grid, col: i64, row: i64) -> bool {
        let m = self.margin as i64;
        let (width, height) = (grid.width as i64 + 2 * m, grid.height as i64 + 2 * m);
        let (x, y) = (col + m, row + m);
        x >= 0 && y >= 0 && x < width && y < height && self.solid[(y * width + x) as usize] != 0
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
    /// Buildings around the table, for the wind only (#488).
    pub context: Option<ContextRing>,
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
        if let Some(ring) = &data.context {
            let want = ContextRing::len_for(&data.grid, ring.margin);
            if ring.solid.len() != want {
                return Err(EngineError::InvalidScene(format!("context has {} values, its ring needs {want}", ring.solid.len())));
            }
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
            context: data.context,
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
