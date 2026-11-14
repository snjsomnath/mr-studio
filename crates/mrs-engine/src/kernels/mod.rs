use crate::Kernel;

pub mod sunlight;
pub mod wind;

/// The kernels every engine starts with.
pub fn builtin() -> Vec<Box<dyn Kernel>> {
    vec![Box::new(sunlight::SunlightKernel), Box::new(wind::WindKernel)]
}
