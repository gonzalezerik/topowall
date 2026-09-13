//! Colors: parsing (`#rgb`, `#rrggbb`, `#rrggbbaa`, `oklch(L C H)`) and OKLab/OKLCH math.

use anyhow::{bail, Context, Result};

/// sRGB-encoded color with straight alpha, components in 0..=1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Oklch {
    pub l: f32,
    pub c: f32,
    /// Hue in degrees.
    pub h: f32,
}

fn to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn to_srgb(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

impl Color {
    pub const BLACK: Color = Color {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 1.0,
    };

    pub fn rgb8(r: u8, g: u8, b: u8) -> Self {
        Self {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
            a: 1.0,
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        let t = s.trim();
        if let Some(inner) = t.strip_prefix("oklch(").and_then(|x| x.strip_suffix(')')) {
            let parts: Vec<&str> = inner
                .split(|c: char| c.is_whitespace() || c == ',' || c == '/')
                .filter(|p| !p.is_empty())
                .collect();
            if parts.len() < 3 {
                bail!("oklch() needs L C H, got '{s}'");
            }
            let num = |p: &str| -> Result<f32> {
                match p.strip_suffix('%') {
                    Some(pct) => Ok(pct.parse::<f32>()? / 100.0),
                    None => Ok(p.trim_end_matches("deg").parse::<f32>()?),
                }
            };
            let mut c = Oklch {
                l: num(parts[0])?,
                c: num(parts[1])?,
                h: num(parts[2])?,
            }
            .to_color();
            if let Some(a) = parts.get(3) {
                c.a = num(a)?;
            }
            return Ok(c);
        }
        let hex = t.strip_prefix('#').unwrap_or(t);
        let digits: Vec<u8> = hex
            .chars()
            .map(|c| c.to_digit(16).map(|d| d as u8))
            .collect::<Option<_>>()
            .with_context(|| format!("invalid color '{s}' (use #rrggbb or oklch(L C H))"))?;
        let byte = |i: usize| digits[i] * 16 + digits[i + 1];
        let (r, g, b, a) = match digits.len() {
            3 => (digits[0] * 17, digits[1] * 17, digits[2] * 17, 255),
            6 => (byte(0), byte(2), byte(4), 255),
            8 => (byte(0), byte(2), byte(4), byte(6)),
            _ => bail!("invalid color '{s}' (use #rrggbb or oklch(L C H))"),
        };
        Ok(Self {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
            a: a as f32 / 255.0,
        })
    }

    pub fn to_hex(self) -> String {
        let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        if q(self.a) == 255 {
            format!("#{:02x}{:02x}{:02x}", q(self.r), q(self.g), q(self.b))
        } else {
            format!(
                "#{:02x}{:02x}{:02x}{:02x}",
                q(self.r),
                q(self.g),
                q(self.b),
                q(self.a)
            )
        }
    }

    pub fn to_array(self) -> [f32; 4] {
        [self.r, self.g, self.b, self.a]
    }

    pub fn to_oklab(self) -> [f32; 3] {
        let (r, g, b) = (to_linear(self.r), to_linear(self.g), to_linear(self.b));
        let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
        let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
        let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
        [
            0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
            1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
            0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
        ]
    }

    pub fn from_oklab([ll, a, b]: [f32; 3]) -> Self {
        let l = (ll + 0.396_337_78 * a + 0.215_803_76 * b).powi(3);
        let m = (ll - 0.105_561_346 * a - 0.063_854_17 * b).powi(3);
        let s = (ll - 0.089_484_18 * a - 1.291_485_5 * b).powi(3);
        Self {
            r: to_srgb(4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s),
            g: to_srgb(-1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s),
            b: to_srgb(-0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s),
            a: 1.0,
        }
    }

    pub fn to_oklch(self) -> Oklch {
        let [l, a, b] = self.to_oklab();
        Oklch {
            l,
            c: a.hypot(b),
            h: b.atan2(a).to_degrees().rem_euclid(360.0),
        }
    }

    /// Perceptual mix in OKLab (t = 0 → self, 1 → other).
    pub fn mix(self, other: Color, t: f32) -> Color {
        let (x, y) = (self.to_oklab(), other.to_oklab());
        let mut c = Color::from_oklab([
            x[0] + (y[0] - x[0]) * t,
            x[1] + (y[1] - x[1]) * t,
            x[2] + (y[2] - x[2]) * t,
        ]);
        c.a = self.a + (other.a - self.a) * t;
        c
    }
}

impl Oklch {
    /// Convert to sRGB, reducing chroma until the color fits the sRGB gamut.
    pub fn to_color(self) -> Color {
        let mut c = self.c;
        for _ in 0..24 {
            let (a, b) = (c * self.h.to_radians().cos(), c * self.h.to_radians().sin());
            let l = self.l;
            let lin = [
                (l + 0.396_337_78 * a + 0.215_803_76 * b).powi(3),
                (l - 0.105_561_346 * a - 0.063_854_17 * b).powi(3),
                (l - 0.089_484_18 * a - 1.291_485_5 * b).powi(3),
            ];
            let rgb = [
                4.076_741_7 * lin[0] - 3.307_711_6 * lin[1] + 0.230_969_94 * lin[2],
                -1.268_438 * lin[0] + 2.609_757_4 * lin[1] - 0.341_319_38 * lin[2],
                -0.004_196_086_3 * lin[0] - 0.703_418_6 * lin[1] + 1.707_614_7 * lin[2],
            ];
            if rgb.iter().all(|v| (-1e-4..=1.0001).contains(v)) {
                break;
            }
            c *= 0.9;
        }
        Color::from_oklab([
            self.l,
            c * self.h.to_radians().cos(),
            c * self.h.to_radians().sin(),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        for h in ["#000000", "#92aca0", "#3e5d58", "#00aeef", "#ffffff"] {
            assert_eq!(Color::parse(h).unwrap().to_hex(), h);
        }
        assert_eq!(Color::parse("#fff").unwrap().to_hex(), "#ffffff");
        assert_eq!(Color::parse("#11223380").unwrap().to_hex(), "#11223380");
    }

    #[test]
    fn oklch_roundtrip() {
        let c = Color::parse("#92aca0").unwrap();
        let back = c.to_oklch().to_color();
        assert_eq!(back.to_hex(), "#92aca0");
    }

    #[test]
    fn parses_oklch() {
        let c = Color::parse("oklch(0.72 0.05 234)").unwrap();
        let lch = c.to_oklch();
        assert!((lch.l - 0.72).abs() < 0.01 && (lch.h - 234.0).abs() < 1.0);
    }
}
