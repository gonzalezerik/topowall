//! Contour spacing: changing a theme's line intervals, and choosing one
//! automatically so lines stay readable at a given output size.

use crate::theme::Theme;
use anyhow::{bail, Result};
use topowall_core::Heightmap;

/// Round numbers used for automatic intervals (metres).
const NICE: &[f64] = &[
    1.0, 2.0, 2.5, 5.0, 10.0, 20.0, 25.0, 50.0, 100.0, 200.0, 250.0, 500.0, 1000.0,
];

impl Theme {
    /// Set the base line spacing to `interval` metres. All tiers scale by the
    /// same factor, so index lines keep their ratio. With `index_every`, the
    /// second tier becomes every `index_every`-th line (later tiers keep
    /// their ratio to it).
    pub fn set_spacing(&mut self, interval: f64, index_every: Option<u32>) -> Result<()> {
        if !(interval > 0.0 && interval.is_finite()) {
            bail!("interval must be a positive number of metres");
        }
        if matches!(index_every, Some(0)) {
            bail!("index-every must be at least 1");
        }
        let Some(first) = self.lines.first().map(|t| t.every) else {
            return Ok(());
        };
        let factor = interval / first;
        for t in &mut self.lines {
            t.every *= factor;
            t.offset *= factor;
        }
        if let (Some(n), true) = (index_every, self.lines.len() >= 2) {
            let old = self.lines[1].every;
            let new = interval * n as f64;
            for t in self.lines.iter_mut().skip(1) {
                t.every *= new / old;
            }
        }
        Ok(())
    }
}

/// Pick a round interval (metres) so that, on typical terrain in this map,
/// neighbouring lines are about `target_px` output pixels apart.
///
/// `tex_per_px` is heightmap cells per output pixel (see [`crate::Framing`]).
pub fn auto_interval(hm: &Heightmap, tex_per_px: f64, target_px: f64) -> f64 {
    let (w, h) = (hm.width, hm.height);
    if w < 3 || h < 3 {
        return 20.0;
    }
    // Sample the gradient on a coarse grid (central differences, metres per cell).
    let step = (w.max(h) / 256).max(1);
    let mut slopes: Vec<f64> = Vec::new();
    for y in (1..h - 1).step_by(step) {
        for x in (1..w - 1).step_by(step) {
            let dx = (hm.get(x + 1, y) - hm.get(x - 1, y)) as f64 * 0.5;
            let dy = (hm.get(x, y + 1) - hm.get(x, y - 1)) as f64 * 0.5;
            slopes.push(dx.hypot(dy) * tex_per_px);
        }
    }
    slopes.sort_by(|a, b| a.total_cmp(b));
    // 70th percentile: steep enough that most of the map reads cleanly.
    let slope = slopes[(slopes.len() as f64 * 0.7) as usize].max(1e-3);
    let ideal = slope * target_px;
    // Nearest round number on a log scale.
    NICE.iter()
        .copied()
        .min_by(|a, b| (a / ideal).ln().abs().total_cmp(&(b / ideal).ln().abs()))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme() -> Theme {
        Theme::load("graphite").unwrap().0
    }

    #[test]
    fn scales_all_tiers() {
        let mut t = theme();
        t.set_spacing(50.0, None).unwrap();
        assert_eq!((t.lines[0].every, t.lines[1].every), (50.0, 250.0));
    }

    #[test]
    fn index_every_sets_second_tier() {
        let mut t = theme();
        t.set_spacing(10.0, Some(10)).unwrap();
        assert_eq!((t.lines[0].every, t.lines[1].every), (10.0, 100.0));
    }

    #[test]
    fn rejects_bad_values() {
        assert!(theme().set_spacing(0.0, None).is_err());
        assert!(theme().set_spacing(20.0, Some(0)).is_err());
    }

    #[test]
    fn steeper_terrain_gets_wider_spacing() {
        let ramp = |grade: f32| {
            let (w, h) = (64, 64);
            Heightmap::new(w, h, (0..w * h).map(|i| (i % w) as f32 * grade).collect())
        };
        assert!(auto_interval(&ramp(10.0), 1.0, 6.0) > auto_interval(&ramp(1.0), 1.0, 6.0));
        assert_eq!(auto_interval(&ramp(3.0), 1.0, 6.0), 20.0); // 18 m ideal → 20 m
        assert_eq!(auto_interval(&ramp(6.5), 1.0, 6.0), 50.0); // 39 m ideal → 50 m (nearer than 25 on a log scale)
    }
}
