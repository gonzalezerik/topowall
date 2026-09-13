//! SRTM `.hgt` tiles: square big-endian i16 grids (1201² or 3601²) named
//! after their south-west corner, e.g. `N37W120.hgt`.

use crate::{Extent, Heightmap};
use anyhow::{bail, Context, Result};
use std::path::Path;

fn parse_corner(name: &str) -> Option<(f64, f64)> {
    let name = name.to_ascii_uppercase();
    let b = name.as_bytes();
    if b.len() < 7 {
        return None;
    }
    let lat: f64 = name.get(1..3)?.parse().ok()?;
    let lon: f64 = name.get(4..7)?.parse().ok()?;
    let lat = match b[0] {
        b'N' => lat,
        b'S' => -lat,
        _ => return None,
    };
    let lon = match b[3] {
        b'E' => lon,
        b'W' => -lon,
        _ => return None,
    };
    Some((lat, lon))
}

pub fn read(path: &Path) -> Result<Heightmap> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let n = ((bytes.len() / 2) as f64).sqrt() as usize;
    if n * n * 2 != bytes.len() {
        bail!("{}: not a square SRTM .hgt grid", path.display());
    }
    let data = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| {
            let v = i16::from_be_bytes([b[0], b[1]]);
            if v == -32768 {
                f32::NAN
            } else {
                v as f32
            }
        })
        .collect();
    let mut hm = Heightmap::new(n, n, data);
    hm.fill_nodata();

    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    hm.source = Some(format!("SRTM {stem}"));
    match parse_corner(stem) {
        Some((south, west)) => {
            // .hgt cells are centred on the grid lines, so n samples span 1 degree.
            let deg = 1.0 / (n - 1) as f64;
            let extent = Extent {
                west,
                south,
                east: west + 1.0,
                north: south + 1.0,
            };
            Ok(super::geographic_to_square(hm, extent, deg, deg))
        }
        None => Ok(hm),
    }
}
