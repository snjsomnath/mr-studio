//! The app's Tauri commands, grouped as the capability files group them (#541). `main.rs`
//! registers every one of them in `generate_handler!`.

use super::*;

mod calibration;
mod files;
mod launcher;
mod recordings;
mod settings;
mod update_commands;

pub(crate) use calibration::*;
pub(crate) use files::*;
pub(crate) use launcher::*;
pub(crate) use recordings::*;
pub(crate) use settings::*;
pub(crate) use update_commands::*;
