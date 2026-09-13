//! Separable Gaussian smoothing and Catmull-Rom sampling.

use crate::Heightmap;
use rayon::prelude::*;

fn gaussian_kernel(sigma: f64) -> Vec<f32> {
    let radius = (4.0 * sigma).ceil() as isize;
    let mut k: Vec<f32> = (-radius..=radius)
        .map(|i| (-(i as f64).powi(2) / (2.0 * sigma * sigma)).exp() as f32)
        .collect();
    let sum: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= sum);
    k
}

/// Mirror an index into `0..n` (edge-inclusive reflection).
#[inline]
fn reflect(i: isize, n: usize) -> usize {
    let n = n as isize;
    if n == 1 {
        return 0;
    }
    let period = 2 * n;
    let mut i = i.rem_euclid(period);
    if i >= n {
        i = period - 1 - i;
    }
    i as usize
}

/// Gaussian blur with standard deviation `sigma` in cells.
pub fn gaussian_blur(hm: &mut Heightmap, sigma: f64) {
    if sigma <= 0.0 {
        return;
    }
    let k = gaussian_kernel(sigma);
    let r = (k.len() / 2) as isize;
    let (w, h) = (hm.width, hm.height);

    let mut tmp = vec![0f32; w * h];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, out) in row.iter_mut().enumerate() {
            let mut acc = 0.0;
            for (j, kv) in k.iter().enumerate() {
                acc += kv * hm.data[y * w + reflect(x as isize + j as isize - r, w)];
            }
            *out = acc;
        }
    });
    hm.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, out) in row.iter_mut().enumerate() {
            let mut acc = 0.0;
            for (j, kv) in k.iter().enumerate() {
                acc += kv * tmp[reflect(y as isize + j as isize - r, h) * w + x];
            }
            *out = acc;
        }
    });
}

#[inline]
fn catmull_rom(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ]
}

/// Sample a row-major grid with Catmull-Rom interpolation at cell coordinate
/// (x, y), where integer coordinates are cell centres. Edges are clamped.
pub fn sample_bicubic(data: &[f32], w: usize, h: usize, x: f64, y: f64) -> f32 {
    let xf = x.floor();
    let yf = y.floor();
    let wx = catmull_rom((x - xf) as f32);
    let wy = catmull_rom((y - yf) as f32);
    let (xi, yi) = (xf as isize, yf as isize);
    let mut acc = 0.0;
    for (j, wyj) in wy.iter().enumerate() {
        let yy = (yi + j as isize - 1).clamp(0, h as isize - 1) as usize;
        let mut row = 0.0;
        for (i, wxi) in wx.iter().enumerate() {
            let xx = (xi + i as isize - 1).clamp(0, w as isize - 1) as usize;
            row += wxi * data[yy * w + xx];
        }
        acc += wyj * row;
    }
    acc
}

/// Resize a heightmap to `width` x `height` (smoothing first when shrinking so
/// detail averages out instead of aliasing). Metres per pixel is updated.
pub fn resize(hm: &Heightmap, width: usize, height: usize) -> Heightmap {
    let (sx, sy) = (
        hm.width as f64 / width as f64,
        hm.height as f64 / height as f64,
    );
    let mut src = hm.clone();
    let shrink = sx.max(sy);
    if shrink > 1.0 {
        gaussian_blur(&mut src, 0.5 * shrink);
    }
    let mut data = vec![0f32; width * height];
    data.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        let yy = (y as f64 + 0.5) * sy - 0.5;
        for (x, v) in row.iter_mut().enumerate() {
            *v = sample_bicubic(
                &src.data,
                src.width,
                src.height,
                (x as f64 + 0.5) * sx - 0.5,
                yy,
            );
        }
    });
    let mut out = Heightmap::new(width, height, data);
    out.m_per_px = hm.m_per_px.map(|m| m * sx);
    out.extent = hm.extent;
    out.source = hm.source.clone();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_keeps_range_and_scale() {
        let hm = {
            let mut h = Heightmap::new(64, 32, (0..64 * 32).map(|i| (i % 64) as f32).collect());
            h.m_per_px = Some(10.0);
            h
        };
        let r = resize(&hm, 16, 8);
        assert_eq!((r.width, r.height), (16, 8));
        assert_eq!(r.m_per_px, Some(40.0));
        let (lo, hi) = r.min_max();
        assert!(lo >= -1.0 && hi <= 64.0 && hi > 50.0);
    }
}
