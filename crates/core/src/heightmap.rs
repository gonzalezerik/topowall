use serde::{Deserialize, Serialize};

/// Geographic bounds in WGS84 degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Extent {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// A grid of elevations in metres. Row 0 is the northern edge.
#[derive(Debug, Clone)]
pub struct Heightmap {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
    /// Ground distance covered by one cell, in metres (if known).
    pub m_per_px: Option<f64>,
    /// Geographic bounds (if known).
    pub extent: Option<Extent>,
    /// Free-form description of where the data came from.
    pub source: Option<String>,
}

impl Heightmap {
    pub fn new(width: usize, height: usize, data: Vec<f32>) -> Self {
        assert_eq!(data.len(), width * height, "heightmap data size mismatch");
        Self {
            width,
            height,
            data,
            m_per_px: None,
            extent: None,
            source: None,
        }
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize) -> f32 {
        self.data[y * self.width + x]
    }

    /// Minimum and maximum elevation, ignoring non-finite cells.
    pub fn min_max(&self) -> (f32, f32) {
        self.data
            .iter()
            .filter(|v| v.is_finite())
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| {
                (lo.min(v), hi.max(v))
            })
    }

    /// Replace non-finite cells (nodata) with the minimum elevation.
    pub fn fill_nodata(&mut self) {
        let (lo, _) = self.min_max();
        let lo = if lo.is_finite() { lo } else { 0.0 };
        for v in &mut self.data {
            if !v.is_finite() {
                *v = lo;
            }
        }
    }
}
