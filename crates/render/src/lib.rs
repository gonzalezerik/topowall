//! GPU contour rendering, themes and palettes for topowall.

pub mod palette;
pub mod renderer;
pub mod spacing;
pub mod theme;

pub use color::Color;
pub use gpu::{Backend, GpuOptions};
pub use palette::Palette;
pub use renderer::{Framing, Renderer};
pub use theme::Theme;
pub use topowall_kit::{color, gpu};
