//! The `.topo` heightmap format.
//!
//! A `.topo` file is a valid 16-bit grayscale PNG (row 0 = north), so any
//! image viewer can open it. Elevation metadata lives in an iTXt chunk with
//! the keyword `topowall`, as JSON:
//!
//! ```json
//! { "version": 1, "min_m": 1173.13, "range_m": 1839.97,
//!   "m_per_px": 6.25, "extent": { "west": ..., "south": ..., "east": ..., "north": ... },
//!   "source": "AWS Terrain Tiles (terrarium) z14" }
//! ```
//!
//! elevation(x, y) = min_m + value / 65535 * range_m

use crate::{Extent, Heightmap};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::BufWriter, path::Path};

const KEYWORD: &str = "topowall";

#[derive(Debug, Serialize, Deserialize)]
pub struct TopoMeta {
    pub version: u32,
    pub min_m: f64,
    pub range_m: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub m_per_px: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extent: Option<Extent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

pub fn write(hm: &Heightmap, path: &Path) -> Result<()> {
    let (lo, hi) = hm.min_max();
    if !lo.is_finite() {
        bail!("heightmap has no valid elevations");
    }
    let range = (hi - lo).max(1e-3) as f64;
    let meta = TopoMeta {
        version: 1,
        min_m: lo as f64,
        range_m: range,
        m_per_px: hm.m_per_px,
        extent: hm.extent,
        source: hm.source.clone(),
    };

    let file = File::create(path).with_context(|| format!("creating {}", path.display()))?;
    let mut enc = png::Encoder::new(BufWriter::new(file), hm.width as u32, hm.height as u32);
    enc.set_color(png::ColorType::Grayscale);
    enc.set_depth(png::BitDepth::Sixteen);
    enc.set_compression(png::Compression::Best);
    enc.add_itxt_chunk(KEYWORD.to_string(), serde_json::to_string(&meta)?)?;
    let mut writer = enc.write_header()?;

    let mut bytes = Vec::with_capacity(hm.data.len() * 2);
    for &v in &hm.data {
        let v = if v.is_finite() { v } else { lo };
        let q = (((v - lo) as f64 / range) * 65535.0)
            .round()
            .clamp(0.0, 65535.0) as u16;
        bytes.extend_from_slice(&q.to_be_bytes());
    }
    writer.write_image_data(&bytes)?;
    writer.finish()?;
    Ok(())
}

pub fn read(path: &Path) -> Result<Heightmap> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let decoder = png::Decoder::new(file);
    let mut reader = decoder.read_info()?;

    let meta: TopoMeta = {
        let info = reader.info();
        let chunk = info
            .utf8_text
            .iter()
            .find(|c| c.keyword == KEYWORD)
            .with_context(|| format!("{} is a PNG but has no topowall metadata", path.display()))?;
        serde_json::from_str(&chunk.get_text()?)?
    };

    let info = reader.info();
    if info.color_type != png::ColorType::Grayscale || info.bit_depth != png::BitDepth::Sixteen {
        bail!("{}: .topo must be 16-bit grayscale", path.display());
    }
    let (w, h) = (info.width as usize, info.height as usize);
    let mut buf = vec![0u8; reader.output_buffer_size()];
    reader.next_frame(&mut buf)?;

    let data = buf
        .as_chunks::<2>()
        .0
        .iter()
        .take(w * h)
        .map(|b| {
            (meta.min_m + u16::from_be_bytes([b[0], b[1]]) as f64 / 65535.0 * meta.range_m) as f32
        })
        .collect();

    let mut hm = Heightmap::new(w, h, data);
    hm.m_per_px = meta.m_per_px;
    hm.extent = meta.extent;
    hm.source = meta.source;
    Ok(hm)
}
