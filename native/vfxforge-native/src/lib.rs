//! VFXForge native services.
//!
//! This crate has NO GUI dependency on purpose: everything here is testable with plain
//! `cargo test`, and the Tauri shell is a thin command layer on top.

pub mod bridge;
pub mod error;
pub mod extract;
pub mod fsx;
pub mod jobs;
pub mod probe;
pub mod process;
pub mod project;
pub mod sanitize;
pub mod service;
pub mod sniff;
pub mod tools;
pub mod wire;

pub use error::{Error, Result};

use std::path::{Path, PathBuf};

/// Resolved paths of the external media tools.
#[derive(Debug, Clone)]
pub struct MediaTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl MediaTools {
    /// Looks for ffmpeg/ffprobe in the configured locations, then beside the executable
    /// (`sidecar_dirs`), then on PATH.
    pub fn discover(
        ffmpeg: Option<&Path>,
        ffprobe: Option<&Path>,
        sidecar_dirs: &[PathBuf],
    ) -> Result<Self> {
        Ok(Self {
            ffmpeg: tools::locate("ffmpeg", ffmpeg, sidecar_dirs)?,
            ffprobe: tools::locate("ffprobe", ffprobe, sidecar_dirs)?,
        })
    }
}
