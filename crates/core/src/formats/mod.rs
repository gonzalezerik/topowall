pub mod geotiff;
pub mod hgt;
pub mod terrarium;

use crate::{resample, Extent, Heightmap};
use rayon::prelude::*;

/// Metres per degree of longitude at a latitude (spherical approximation).
pub fn m_per_deg_lon(lat: f64) -> f64 {
    111_320.0 * lat.to_radians().cos()
}

/// Metres per degree of latitude.
pub const M_PER_DEG_LAT: f64 = 110_574.0;

/// Grids in geographic coordinates have cells that are narrower (in metres)
/// east-west than north-south. Resample columns so cells are square in
/// metres at the map's middle latitude; otherwise contours render stretched.
pub fn geographic_to_square(hm: Heightmap, extent: Extent, deg_x: f64, deg_y: f64) -> Heightmap {
    let mid_lat = 0.5 * (extent.north + extent.south);
    let m_x = deg_x * m_per_deg_lon(mid_lat);
    let m_y = deg_y * M_PER_DEG_LAT;
    let new_w = ((hm.width as f64) * m_x / m_y).round().max(1.0) as usize;

    let mut out = if new_w == hm.width {
        hm.clone()
    } else {
        let (w, h) = (hm.width, hm.height);
        let scale = w as f64 / new_w as f64;
        let mut data = vec![0f32; new_w * h];
        data.par_chunks_mut(new_w).enumerate().for_each(|(y, row)| {
            for (x, v) in row.iter_mut().enumerate() {
                let sx = (x as f64 + 0.5) * scale - 0.5;
                *v = resample::sample_bicubic(&hm.data, w, h, sx, y as f64);
            }
        });
        Heightmap::new(new_w, h, data)
    };
    out.m_per_px = Some(m_y);
    out.extent = Some(extent);
    out.source = hm.source;
    out
}
