//! MR Studio compute engine.
//!
//! One scene per site is uploaded to the GPU once. Kernels read it and produce
//! fields. Every kernel has a GPU implementation in WGSL and a CPU reference of
//! the same algorithm. See `docs/contracts/engine.md`.

mod context;
mod engine;
mod error;
mod field;
mod grid;
mod kernel;
pub mod kernels;
mod scene;
pub mod solar;
pub mod testing;
pub mod time;
mod twin;

pub use context::{Backend, Context, Gpu};
pub use engine::{Engine, EngineConfig, EngineInfo, JobId};
pub use error::EngineError;
pub use field::{encode_frame, Encoding, Field, FRAME_HEADER_LEN};
pub use grid::Grid;
pub use kernel::{FieldInfo, Job, JobState, JobStatus, Kernel, KernelInfo, KernelKind};
pub use scene::{Scene, SceneData, SOLID_THRESHOLD_M};
pub use twin::{SurfaceKind, TwinMesh, TwinOptions, TWIN_HEADER_LEN, TWIN_MAGIC, TWIN_VERSION};
