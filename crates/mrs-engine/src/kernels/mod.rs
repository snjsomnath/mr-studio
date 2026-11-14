use crate::Kernel;

pub mod sunlight;

/// The kernels every engine starts with.
pub fn builtin() -> Vec<Box<dyn Kernel>> {
    vec![Box::new(sunlight::SunlightKernel)]
}
