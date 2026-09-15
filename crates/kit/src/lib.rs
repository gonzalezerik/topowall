//! Pieces shared by topowall and streetwall.
//!
//! - [`color`]: color parsing and OKLab/OKLCH math
//! - [`atomic`]: replace files only after they are fully written
//! - [`palette`] (feature `palette`): color schemes from base16, terminal configs, pywal and images
//! - [`gpu`] (feature `gpu`): find a working GPU (dedicated, integrated or software)
//! - [`tags`] (feature `palette`): computed tags for the built-in color schemes
//! - [`suggest`]: "did you mean" suggestions for mistyped names

pub mod atomic;
pub mod color;
#[cfg(feature = "gpu")]
pub mod gpu;
#[cfg(feature = "palette")]
pub mod palette;
pub mod suggest;
#[cfg(feature = "palette")]
pub mod tags;

pub use color::Color;
