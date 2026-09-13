//! Fetch elevation for any area on Earth from AWS Terrain Tiles
//! (Terrarium encoding; sources include USGS 3DEP, SRTM, GMTED, ETOPO).
//! <https://registry.opendata.aws/terrain-tiles/>

use crate::{formats::terrarium, resample, Extent, Heightmap};
use anyhow::{bail, Context, Result};
use rayon::prelude::*;
use std::{
    f64::consts::PI,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const TILE_URL: &str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const TILE: usize = 256;
const MAX_ZOOM: u8 = 15;

#[derive(Debug, Clone)]
pub struct Request {
    pub center_lat: f64,
    pub center_lon: f64,
    /// Width of the area in kilometres; height follows from the pixel aspect.
    pub width_km: f64,
    pub width_px: usize,
    pub height_px: usize,
    /// Tile zoom; `None` picks the one closest to the output resolution.
    pub zoom: Option<u8>,
    /// Gaussian smoothing in metres (0 = none). Softens DEM noise into flowing lines.
    pub smooth_m: f64,
    /// Refuse requests needing more tiles than this.
    pub max_tiles: usize,
    pub cache_dir: PathBuf,
}

impl Request {
    pub fn m_per_px(&self) -> f64 {
        self.width_km * 1000.0 / self.width_px as f64
    }

    pub fn extent(&self) -> Extent {
        let dlon = self.width_km / (111.32 * self.center_lat.to_radians().cos());
        let dlat = (self.width_km * self.height_px as f64 / self.width_px as f64) / 110.57;
        Extent {
            west: self.center_lon - dlon / 2.0,
            east: self.center_lon + dlon / 2.0,
            south: self.center_lat - dlat / 2.0,
            north: self.center_lat + dlat / 2.0,
        }
    }

    /// Zoom whose ground resolution is closest to the requested output resolution.
    pub fn auto_zoom(&self) -> u8 {
        let tile_m_at_z0 = 156_543.034 * self.center_lat.to_radians().cos();
        (tile_m_at_z0 / self.m_per_px())
            .log2()
            .round()
            .clamp(0.0, MAX_ZOOM as f64) as u8
    }
}

/// Global Web Mercator pixel coordinates at a zoom level.
fn mercator_px(lon: f64, lat: f64, zoom: u8) -> (f64, f64) {
    let n = (1u64 << zoom) as f64 * TILE as f64;
    let x = (lon + 180.0) / 360.0 * n;
    let y = (1.0 - lat.to_radians().tan().asinh() / PI) / 2.0 * n;
    (x, y)
}

fn fetch_tile(cache: &Path, z: u8, x: i64, y: i64) -> Result<Vec<f32>> {
    let path = cache.join(format!("{z}/{x}/{y}.png"));
    if !path.exists() {
        fs::create_dir_all(path.parent().unwrap())?;
        let url = format!("{TILE_URL}/{z}/{x}/{y}.png");
        let resp = ureq::get(&url)
            .call()
            .with_context(|| format!("downloading {url}"))?;
        let mut bytes = Vec::new();
        resp.into_reader().take(16 << 20).read_to_end(&mut bytes)?;
        let tmp = path.with_extension("part");
        fs::write(&tmp, &bytes)?;
        fs::rename(&tmp, &path)?;
    }
    let (w, h, data) = terrarium::decode(fs::File::open(&path)?)
        .with_context(|| format!("decoding cached tile {}", path.display()))?;
    if w != TILE || h != TILE {
        bail!("tile {z}/{x}/{y} is {w}x{h}, expected {TILE}x{TILE}");
    }
    Ok(data)
}

/// Download (or reuse cached) tiles and build the heightmap for a request.
/// `progress(done, total)` is called as tiles arrive.
pub fn fetch(req: &Request, progress: impl Fn(usize, usize) + Sync) -> Result<Heightmap> {
    if req.width_px == 0 || req.height_px == 0 || req.width_km <= 0.0 {
        bail!("width, height and width-km must be positive");
    }
    if req.center_lat.abs() > 85.0 {
        bail!("latitude must be within ±85° (Web Mercator tiles)");
    }
    let z = req.zoom.unwrap_or_else(|| req.auto_zoom()).min(MAX_ZOOM);
    let ext = req.extent();

    let (x0, y0) = mercator_px(ext.west, ext.north, z);
    let (x1, y1) = mercator_px(ext.east, ext.south, z);
    let tiles_n = 1i64 << z;
    // One tile of margin for the bicubic kernel.
    let tx0 = (x0 / TILE as f64).floor() as i64 - 1;
    let tx1 = (x1 / TILE as f64).floor() as i64 + 1;
    let ty0 = ((y0 / TILE as f64).floor() as i64 - 1).max(0);
    let ty1 = ((y1 / TILE as f64).floor() as i64 + 1).min(tiles_n - 1);
    let (cols, rows) = ((tx1 - tx0 + 1) as usize, (ty1 - ty0 + 1) as usize);
    let total = cols * rows;
    if total > req.max_tiles {
        bail!(
            "area needs {total} tiles at zoom {z} (limit {}); use a smaller area, lower --zoom or raise --max-tiles",
            req.max_tiles
        );
    }

    let coords: Vec<(i64, i64)> = (ty0..=ty1)
        .flat_map(|y| (tx0..=tx1).map(move |x| (x, y)))
        .collect();
    let done = std::sync::atomic::AtomicUsize::new(0);
    let pool = rayon::ThreadPoolBuilder::new().num_threads(8).build()?;
    let tiles: Vec<Vec<f32>> = pool.install(|| {
        coords
            .par_iter()
            .map(|&(x, y)| {
                let t = fetch_tile(&req.cache_dir, z, x.rem_euclid(tiles_n), y);
                progress(
                    done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1,
                    total,
                );
                t
            })
            .collect::<Result<_>>()
    })?;

    // Stitch into one mosaic.
    let (mw, mh) = (cols * TILE, rows * TILE);
    let mut mosaic = vec![0f32; mw * mh];
    for (i, tile) in tiles.iter().enumerate() {
        let (c, r) = (i % cols, i / cols);
        for ty in 0..TILE {
            let dst = (r * TILE + ty) * mw + c * TILE;
            mosaic[dst..dst + TILE].copy_from_slice(&tile[ty * TILE..(ty + 1) * TILE]);
        }
    }

    // Sample the requested frame at output resolution.
    let (w, h) = (req.width_px, req.height_px);
    let ox = tx0 as f64 * TILE as f64;
    let oy = ty0 as f64 * TILE as f64;
    let mut data = vec![0f32; w * h];
    data.par_chunks_mut(w).enumerate().for_each(|(gy, row)| {
        let sy = y0 + (y1 - y0) * (gy as f64 + 0.5) / h as f64 - oy - 0.5;
        for (gx, v) in row.iter_mut().enumerate() {
            let sx = x0 + (x1 - x0) * (gx as f64 + 0.5) / w as f64 - ox - 0.5;
            *v = resample::sample_bicubic(&mosaic, mw, mh, sx, sy);
        }
    });

    let mut hm = Heightmap::new(w, h, data);
    let m_per_px = req.m_per_px();
    resample::gaussian_blur(&mut hm, req.smooth_m / m_per_px);
    hm.m_per_px = Some(m_per_px);
    hm.extent = Some(ext);
    hm.source = Some(format!("AWS Terrain Tiles (terrarium) z{z}"));
    Ok(hm)
}
