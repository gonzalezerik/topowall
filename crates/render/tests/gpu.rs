//! End-to-end render on whatever GPU (or software renderer) is available.
//!
//! Skipped when no adapter exists, unless TOPOWALL_REQUIRE_GPU=1 (set in CI).
//! TOPOWALL_BACKEND / TOPOWALL_GPU pick the adapter, like the CLI.

use topowall_core::Heightmap;
use topowall_render::{Backend, Framing, GpuOptions, Renderer, Theme};

fn renderer() -> Option<Renderer> {
    let opts = GpuOptions {
        backend: Backend::parse(&std::env::var("TOPOWALL_BACKEND").unwrap_or_default()).unwrap(),
        gpu: std::env::var("TOPOWALL_GPU").ok(),
    };
    match Renderer::with_options(&opts) {
        Ok(r) => {
            eprintln!("rendering on {}", r.adapter_name());
            Some(r)
        }
        Err(e) if std::env::var("TOPOWALL_REQUIRE_GPU").as_deref() != Ok("1") => {
            eprintln!("skipping GPU test: {e:#}");
            None
        }
        Err(e) => panic!("TOPOWALL_REQUIRE_GPU=1 but no adapter: {e:#}"),
    }
}

/// A west-to-east ramp: elevation = column × 10 m.
fn ramp() -> Heightmap {
    let (w, h) = (64, 64);
    Heightmap::new(w, h, (0..w * h).map(|i| (i % w) as f32 * 10.0).collect())
}

fn pixel(rgba: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * width + x) * 4) as usize;
    rgba[i..i + 4].try_into().unwrap()
}

#[test]
fn draws_lines_at_the_right_elevations() {
    let Some(r) = renderer() else { return };
    let theme = Theme::from_toml(
        "background = \"#102030\"\n[[lines]]\nevery = 100\nwidth = 2\ncolor = \"#ffffff\"\n",
    )
    .unwrap();
    let hm = ramp();
    let (lo, hi) = hm.min_max();
    let resolved = theme.resolve(lo, hi, None).unwrap();
    let out = r.render(&hm, &resolved, 64, 64, Framing::Cover).unwrap();

    // Column 10 is exactly 100 m: on a line. Column 5 is 50 m: halfway between lines.
    assert_eq!(
        pixel(&out, 64, 10, 32),
        [255, 255, 255, 255],
        "line at 100 m"
    );
    assert_eq!(
        pixel(&out, 64, 5, 32),
        [0x10, 0x20, 0x30, 255],
        "background at 50 m"
    );
    assert_eq!(
        pixel(&out, 64, 30, 10),
        [255, 255, 255, 255],
        "line at 300 m"
    );
}

#[test]
fn tiles_large_outputs_seamlessly() {
    let Some(r) = renderer() else { return };
    let theme = Theme::load("graphite").unwrap().0;
    let hm = ramp();
    let (lo, hi) = hm.min_max();
    let resolved = theme.resolve(lo, hi, None).unwrap();
    // Wider than one 4096 px tile: the same column must look identical in both tiles' rows.
    let (w, h) = (4200, 8);
    let out = r.render(&hm, &resolved, w, h, Framing::Cover).unwrap();
    assert_eq!(out.len(), (w * h * 4) as usize);
    for x in (0..w).step_by(97) {
        assert_eq!(pixel(&out, w, x, 1), pixel(&out, w, x, 6), "column {x}");
    }
}

#[test]
fn shrinks_heightmaps_that_exceed_the_texture_limit() {
    let Some(r) = renderer() else { return };
    let max = r.max_texture_size() as usize;
    assert!(r.fit_heightmap(&ramp()).is_none());
    // Only the size decision is checked here; allocating a real over-limit map is too large for CI.
    let too_big = Heightmap::new(max + 1, 1, vec![0.0; max + 1]);
    let fitted = r.fit_heightmap(&too_big).expect("should shrink");
    assert!(fitted.width <= max && fitted.height >= 1);
}
