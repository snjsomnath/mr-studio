use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::{Context, EngineError, Field, Scene};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KernelKind {
    /// One step produces the result.
    OneShot,
    /// Output is valid after every step and refines until done.
    Progressive,
    /// A simulation that keeps running; progress reports convergence.
    Iterative,
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldInfo {
    pub name: &'static str,
    pub units: &'static str,
    pub description: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct KernelInfo {
    pub id: &'static str,
    pub kind: KernelKind,
    /// JSON Schema of the accepted params.
    pub params: Value,
    pub fields: &'static [FieldInfo],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Running,
    Done,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobStatus {
    pub state: JobState,
    /// 0..1
    pub progress: f32,
    /// Raised whenever readable output changed.
    pub revision: u64,
    /// Kernel-specific values a layer may want without recomputing them.
    pub info: Value,
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
