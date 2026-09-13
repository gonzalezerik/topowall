//! Single-band GeoTIFF elevation rasters (including Cloud Optimized GeoTIFFs
//! such as Copernicus GLO-30 and USGS 3DEP).

use crate::{Extent, Heightmap};
use anyhow::{bail, Context, Result};
use std::{fs::File, io::BufReader, path::Path};
use tiff::{
    decoder::{Decoder, DecodingResult, Limits},
    tags::Tag,
};

const MODEL_PIXEL_SCALE: u16 = 33550;
const MODEL_TIEPOINT: u16 = 33922;
const GEO_KEY_DIRECTORY: u16 = 34735;
const GDAL_NODATA: u16 = 42113;
const GT_MODEL_TYPE_KEY: u16 = 1024;
const MODEL_TYPE_GEOGRAPHIC: u16 = 2;

pub fn read(path: &Path) -> Result<Heightmap> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut dec = Decoder::new(BufReader::new(file))
        .with_context(|| format!("{} is not a readable TIFF", path.display()))?
        .with_limits(Limits::unlimited());

    let (w, h) = dec.dimensions()?;
    let (w, h) = (w as usize, h as usize);

    let scale = dec.get_tag_f64_vec(Tag::Unknown(MODEL_PIXEL_SCALE)).ok();
    let tie = dec.get_tag_f64_vec(Tag::Unknown(MODEL_TIEPOINT)).ok();
    let geokeys = dec
        .find_tag(Tag::Unknown(GEO_KEY_DIRECTORY))?
        .and_then(|v| v.into_u16_vec().ok());
    let nodata: Option<f64> = dec
        .get_tag_ascii_string(Tag::Unknown(GDAL_NODATA))
        .ok()
        .and_then(|s| s.trim_matches(char::from(0)).trim().parse().ok());

    let raw: Vec<f64> = match dec.read_image()? {
        DecodingResult::F32(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::F64(v) => v,
        DecodingResult::I16(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::U16(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::I32(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::U32(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::I8(v) => v.into_iter().map(|x| x as f64).collect(),
        DecodingResult::U8(v) => v.into_iter().map(|x| x as f64).collect(),
        _ => bail!("{}: unsupported sample format", path.display()),
    };
    if raw.len() != w * h {
        bail!(
            "{}: expected a single-band raster ({} samples for {}x{}, got {})",
            path.display(),
            w * h,
            w,
            h,
            raw.len()
        );
    }

    let data = raw
        .into_iter()
        .map(|v| match nodata {
            Some(nd) if (v - nd).abs() < 1e-6 => f32::NAN,
            _ if !v.is_finite() || v < -12_000.0 => f32::NAN,
            _ => v as f32,
        })
        .collect();
    let mut hm = Heightmap::new(w, h, data);
    hm.fill_nodata();
    hm.source = Some(format!(
        "GeoTIFF {}",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));

    let (Some(scale), Some(tie)) = (scale, tie) else {
        return Ok(hm); // no georeferencing: plain grid
    };
    if scale.len() < 2 || tie.len() < 6 {
        return Ok(hm);
    }
    let (sx, sy) = (scale[0], scale[1]);

    let geographic = geokeys
        .as_deref()
        .map(|k| {
            k.as_chunks::<4>()
                .0
                .iter()
                .skip(1)
                .any(|e| e[0] == GT_MODEL_TYPE_KEY && e[3] == MODEL_TYPE_GEOGRAPHIC)
        })
        .unwrap_or(false);

    if geographic {
        let west = tie[3] - tie[0] * sx;
        let north = tie[4] + tie[1] * sy;
        let extent = Extent {
            west,
            south: north - h as f64 * sy,
            east: west + w as f64 * sx,
            north,
        };
        Ok(super::geographic_to_square(hm, extent, sx, sy))
    } else {
        // Projected CRS: assume linear units are metres (true for UTM / 3DEP / most DEMs).
        hm.m_per_px = Some(sy);
        Ok(hm)
    }
}
