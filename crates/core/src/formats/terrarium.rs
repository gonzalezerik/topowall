//! Terrarium-encoded elevation PNGs (AWS Terrain Tiles / Mapzen):
//! elevation = R * 256 + G + B / 256 - 32768.

use crate::Heightmap;
use anyhow::{bail, Context, Result};
use std::{io::Read, path::Path};

/// Decode a Terrarium PNG into (width, height, elevations).
pub fn decode<R: Read>(r: R) -> Result<(usize, usize, Vec<f32>)> {
    let mut decoder = png::Decoder::new(r);
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf)?;
    let channels = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        other => bail!("terrarium tile must be RGB/RGBA, got {other:?}"),
    };
    let (w, h) = (info.width as usize, info.height as usize);
    let data = buf[..w * h * channels]
        .chunks_exact(channels)
        .map(|p| p[0] as f32 * 256.0 + p[1] as f32 + p[2] as f32 / 256.0 - 32768.0)
        .collect();
    Ok((w, h, data))
}

pub fn read_file(path: &Path) -> Result<Heightmap> {
    let f = std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let (w, h, data) = decode(f).with_context(|| format!("decoding {}", path.display()))?;
    let mut hm = Heightmap::new(w, h, data);
    hm.source = Some(format!("Terrarium PNG {}", path.display()));
    Ok(hm)
}
