//! Truecolor terminal output: color strips and half-block images.

use std::fmt::Write;
use topowall_render::color::Color;

fn rgb8(c: Color) -> (u8, u8, u8) {
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    (q(c.r), q(c.g), q(c.b))
}

/// A strip of 16 two-cell blocks, one per base16 color.
pub fn swatches(base: &[Color; 16]) -> String {
    let mut s = String::with_capacity(16 * 24);
    for c in base {
        let (r, g, b) = rgb8(*c);
        let _ = write!(s, "\x1b[48;2;{r};{g};{b}m  ");
    }
    s.push_str("\x1b[0m");
    s
}

/// Average each `f`x`f` block of an RGBA8 image into one RGB pixel.
pub fn downsample(rgba: &[u8], w: usize, h: usize, f: usize) -> Vec<[u8; 3]> {
    let (ow, oh) = (w / f, h / f);
    let mut out = Vec::with_capacity(ow * oh);
    for y in 0..oh {
        for x in 0..ow {
            let mut sum = [0u32; 3];
            for dy in 0..f {
                for dx in 0..f {
                    let i = ((y * f + dy) * w + x * f + dx) * 4;
                    for (k, s) in sum.iter_mut().enumerate() {
                        *s += rgba[i + k] as u32;
                    }
                }
            }
            let n = (f * f) as u32;
            out.push(sum.map(|s| ((s + n / 2) / n) as u8));
        }
    }
    out
}

/// Draw an RGB image with `▀`: the foreground paints the top pixel and the
/// background the bottom one, so each terminal cell shows two pixels.
pub fn half_blocks(px: &[[u8; 3]], w: usize, h: usize) -> String {
    let mut s = String::with_capacity(w * h * 20);
    for y in (0..h - h % 2).step_by(2) {
        let (mut fg, mut bg) = (None, None);
        for x in 0..w {
            let (top, bottom) = (px[y * w + x], px[(y + 1) * w + x]);
            if fg != Some(top) {
                let [r, g, b] = top;
                let _ = write!(s, "\x1b[38;2;{r};{g};{b}m");
                fg = Some(top);
            }
            if bg != Some(bottom) {
                let [r, g, b] = bottom;
                let _ = write!(s, "\x1b[48;2;{r};{g};{b}m");
                bg = Some(bottom);
            }
            s.push('▀');
        }
        s.push_str("\x1b[0m\n");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_blocks_pair_rows_and_reuse_colors() {
        let red = [255, 0, 0];
        let blue = [0, 0, 255];
        let out = half_blocks(&[red, red, blue, blue], 2, 2);
        assert_eq!(out, "\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀▀\x1b[0m\n");
    }

    #[test]
    fn downsample_averages_blocks() {
        let rgba = [
            0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
        ];
        assert_eq!(downsample(&rgba, 2, 2, 2), vec![[128, 128, 128]]);
    }
}
