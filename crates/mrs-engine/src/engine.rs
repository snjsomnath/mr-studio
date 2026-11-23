use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::kernels;
use crate::{Backend, Context, EngineError, Field, Grid, Job, JobStatus, Kernel, KernelInfo, Scene, SceneData};

pub type JobId = u64;

#[derive(Debug, Clone, Copy)]
pub struct EngineConfig {
    pub backend: Backend,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self { backend: Backend::Auto }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineInfo {
    pub backend: Backend,
    pub adapter: Option<String>,
    pub grid: Option<Grid>,
    pub kernels: Vec<KernelInfo>,
}

struct JobEntry {
    job: Box<dyn Job>,
    scene_revision: u64,
}

pub struct Engine {
    ctx: Context,
    scene: Option<Scene>,
    kernels: BTreeMap<&'static str, Box<dyn Kernel>>,
    jobs: HashMap<JobId, JobEntry>,
    next_job: JobId,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Result<Self, EngineError> {
        let ctx = Context::new(config.backend)?;
        let mut engine = Self { ctx, scene: None, kernels: BTreeMap::new(), jobs: HashMap::new(), next_job: 1 };
        for kernel in kernels::builtin() {
            engine.register(kernel);
        }
        Ok(engine)
    }

    pub fn register(&mut self, kernel: Box<dyn Kernel>) {
        self.kernels.insert(kernel.info().id, kernel);
    }

    /// Whether the GPU under this engine was lost. A lost engine is replaced, not repaired.
    pub fn lost(&self) -> bool {
        self.ctx.is_lost()
    }

    pub fn info(&self) -> EngineInfo {
        EngineInfo {
            backend: self.ctx.backend,
            adapter: self.ctx.gpu.as_ref().map(|g| g.adapter.clone()),
            grid: self.scene.as_ref().map(|s| s.grid),
            kernels: self.kernels.values().map(|k| k.info()).collect(),
        }
    }

    pub fn context(&self) -> &Context {
        &self.ctx
    }

    pub fn scene(&self) -> Option<&Scene> {
        self.scene.as_ref()
    }

    /// Loads or replaces the scene. Running jobs pick up the new revision on their next step.
    pub fn load_scene(&mut self, data: SceneData) -> Result<(), EngineError> {
        let revision = self.scene.as_ref().map_or(1, |s| s.revision + 1);
        self.scene = Some(Scene::new(&self.ctx, data, revision)?);
        Ok(())
    }

    pub fn create_job(&mut self, kernel: &str, params: &Value) -> Result<JobId, EngineError> {
        let scene = self.scene.as_ref().ok_or(EngineError::NoScene)?;
        let kernel = self.kernels.get(kernel).ok_or_else(|| EngineError::UnknownKernel(kernel.to_string()))?;
        let job = kernel.create(&self.ctx, scene, params)?;
        let id = self.next_job;
        self.next_job += 1;
        self.jobs.insert(id, JobEntry { job, scene_revision: scene.revision });
        Ok(id)
    }

    pub fn set_params(&mut self, job: JobId, params: &Value) -> Result<(), EngineError> {
        let scene = self.scene.as_ref().ok_or(EngineError::NoScene)?;
        let entry = self.jobs.get_mut(&job).ok_or(EngineError::UnknownJob(job))?;
        entry.job.set_params(&self.ctx, scene, params)
    }

    pub fn step(&mut self, job: JobId, budget: Duration) -> Result<JobStatus, EngineError> {
        let scene = self.scene.as_ref().ok_or(EngineError::NoScene)?;
        let entry = self.jobs.get_mut(&job).ok_or(EngineError::UnknownJob(job))?;
        if entry.scene_revision != scene.revision {
            entry.job.scene_changed(&self.ctx, scene)?;
            entry.scene_revision = scene.revision;
        }
        entry.job.step(&self.ctx, scene, budget)
    }

    pub fn read_field(&mut self, job: JobId, field: &str) -> Result<Field, EngineError> {
        let scene = self.scene.as_ref().ok_or(EngineError::NoScene)?;
        let entry = self.jobs.get_mut(&job).ok_or(EngineError::UnknownJob(job))?;
        entry.job.read(&self.ctx, scene, field)
    }

    pub fn drop_job(&mut self, job: JobId) {
        self.jobs.remove(&job);
    }
}
