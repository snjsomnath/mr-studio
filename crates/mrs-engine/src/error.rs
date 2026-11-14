use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("no GPU adapter available: {0}")]
    NoGpu(String),
    #[error("no scene loaded")]
    NoScene,
    #[error("invalid scene: {0}")]
    InvalidScene(String),
    #[error("unknown kernel '{0}'")]
    UnknownKernel(String),
    #[error("unknown job {0}")]
    UnknownJob(u64),
    #[error("invalid params: {0}")]
    InvalidParams(String),
    #[error("field '{0}' is not available")]
    UnknownField(String),
    #[error("simulation became unstable: {0}")]
    Unstable(String),
    #[error("gpu error: {0}")]
    Gpu(String),
}
