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
    /// What covers the ground, one [`Surface`] per cell; 0 where the site does not say (#624).
    pub surface: Vec<u8>,
    /// The soil under it, one [`Soil`] per cell; 0 where the site does not say (#624).
    pub soil: Vec<u8>,
    /// Buildings around the table that only shape the wind (#488). Nothing draws them.
    pub context: Option<ContextRing>,
}

impl SceneData {
    pub fn flat(grid: Grid) -> Self {
        let n = grid.len();
        Self {
            grid,
            dtm: vec![0.0; n],
            dsm: vec![0.0; n],
            canopy: vec![0.0; n],
            water: vec![0; n],
            surface: vec![0; n],
            soil: vec![0; n],
            context: None,
        }
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
    /// What covers the ground, one [`Surface`] per cell (#624).
    pub surface: Vec<u8>,
    /// The soil under it, one [`Soil`] per cell (#624).
    pub soil: Vec<u8>,
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
        if data.surface.len() != n {
            return Err(EngineError::InvalidScene(format!("surface has {} values, grid has {n}", data.surface.len())));
        }
        if let Some(bad) = data.surface.iter().find(|&&s| Surface::from_u8(s).is_none()) {
            return Err(EngineError::InvalidScene(format!("surface {bad} is not a known surface")));
        }
        if data.soil.len() != n {
            return Err(EngineError::InvalidScene(format!("soil has {} values, grid has {n}", data.soil.len())));
        }
        if let Some(bad) = data.soil.iter().find(|&&s| Soil::from_u8(s).is_none()) {
            return Err(EngineError::InvalidScene(format!("soil {bad} is not a known soil")));
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
            surface: data.surface,
            soil: data.soil,
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

/// What covers the ground of a cell (#624, #625). The value is what `SceneData::surface` stores.
/// Stormwater gives each its own infiltration and roughness; `Unknown` takes the kernel's site-wide values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Surface {
    Unknown = 0,
    /// Asphalt, concrete, roofs at ground level, sealed paving: almost nothing soaks in.
    Sealed = 1,
    /// Paving stones, setts, cobbles: a little soaks in through the joints.
    Paving = 2,
    /// Gravel and compacted ground.
    Gravel = 3,
    /// Lawns, parks, meadows, fields.
    Grass = 4,
    /// Bare earth, sand, open ground without plants.
    Bare = 5,
    /// Woodland and scrub.
    Woodland = 6,
    /// A planted dip built to hold rain and let it soak in.
    RainGarden = 7,
    /// A gully or inlet that takes water into a pipe.
    Drain = 8,
}

impl Surface {
    pub const ALL: [Surface; 9] = [
        Surface::Unknown,
        Surface::Sealed,
        Surface::Paving,
        Surface::Gravel,
        Surface::Grass,
        Surface::Bare,
        Surface::Woodland,
        Surface::RainGarden,
        Surface::Drain,
    ];

    pub fn from_u8(value: u8) -> Option<Self> {
        Self::ALL.get(value as usize).copied()
    }

    /// The name site files, params and status use.
    pub fn name(self) -> &'static str {
        match self {
            Surface::Unknown => "unknown",
            Surface::Sealed => "sealed",
            Surface::Paving => "paving",
            Surface::Gravel => "gravel",
            Surface::Grass => "grass",
            Surface::Bare => "bare",
            Surface::Woodland => "woodland",
            Surface::RainGarden => "rain_garden",
            Surface::Drain => "drain",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.name() == name)
    }

    /// Whether water can soak through it into the soil below.
    pub fn is_open(self) -> bool {
        !matches!(self, Surface::Sealed | Surface::Paving | Surface::Drain)
    }
}

/// The soil under a cell's surface (#624): how fast open ground soaks up rain. The value is what
/// `SceneData::soil` stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Soil {
    Unknown = 0,
    Clay = 1,
    Silt = 2,
    /// Till (morän): a mix of everything from clay to stones.
    Till = 3,
    Sand = 4,
    Gravel = 5,
    Peat = 6,
    /// Bedrock at the surface.
    Rock = 7,
    /// Made ground: fill under streets and yards.
    Fill = 8,
}

impl Soil {
    pub const ALL: [Soil; 9] =
        [Soil::Unknown, Soil::Clay, Soil::Silt, Soil::Till, Soil::Sand, Soil::Gravel, Soil::Peat, Soil::Rock, Soil::Fill];

    pub fn from_u8(value: u8) -> Option<Self> {
        Self::ALL.get(value as usize).copied()
    }

    pub fn name(self) -> &'static str {
        match self {
            Soil::Unknown => "unknown",
            Soil::Clay => "clay",
            Soil::Silt => "silt",
            Soil::Till => "till",
            Soil::Sand => "sand",
            Soil::Gravel => "gravel",
            Soil::Peat => "peat",
            Soil::Rock => "rock",
            Soil::Fill => "fill",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.name() == name)
    }
}
