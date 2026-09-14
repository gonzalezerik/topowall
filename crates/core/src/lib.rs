//! Elevation data for topowall: loading DEM files, fetching open elevation
//! tiles, resampling, and the `.topo` heightmap format.

/// Safe file replacement (from topowall-kit).
pub use topowall_kit::atomic;
pub mod fetch;
pub mod formats;
pub mod heightmap;
pub mod resample;
pub mod topo;

pub use heightmap::{Extent, Heightmap};

use anyhow::{bail, Result};
use std::path::Path;

/// Load any supported elevation file, picking the reader from the extension.
///
/// Supported: `.topo` (topowall), `.tif`/`.tiff` (GeoTIFF, incl. COG),
/// `.hgt` (SRTM), `.png` (Terrarium-encoded tile).
pub fn load(path: &Path) -> Result<Heightmap> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "topo" => topo::read(path),
        "tif" | "tiff" => formats::geotiff::read(path),
        "hgt" => formats::hgt::read(path),
        "png" => formats::terrarium::read_file(path),
        _ => bail!(
            "unsupported elevation file '{}' (expected .topo, .tif, .hgt or Terrarium .png)",
            path.display()
        ),
    }
}
