//! Palettes (from topowall-kit) and turning them into contour themes.

pub use topowall_kit::palette::{
    builtin_base16, builtin_names, from_image, random_builtin, Palette,
};

use crate::theme::{LineTier, Paint, Theme};
use anyhow::Result;
use topowall_kit::color::{Color, Oklch};

// ── Theme generation ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    /// Low-chroma lines close to the background (the default).
    Subtle,
    /// The palette's accent as-is.
    Vivid,
    /// Foreground only, no hue.
    Mono,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundMode {
    Palette,
    Black,
}

#[derive(Debug, Clone)]
pub struct GenerateOptions {
    /// "auto", an ANSI name (red, green, yellow, blue, magenta, cyan, orange…), or "0".."15".
    pub accent: String,
    pub style: Style,
    pub background: BackgroundMode,
    pub interval_m: f64,
    pub index_every: u32,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self {
            accent: "auto".into(),
            style: Style::Subtle,
            background: BackgroundMode::Palette,
            interval_m: 20.0,
            index_every: 5,
        }
    }
}

/// Turn a palette into a contour theme.
pub fn to_theme(palette: &Palette, opts: &GenerateOptions) -> Result<Theme> {
    let pal_bg = palette
        .background
        .or(palette.ansi[0])
        .unwrap_or(Color::BLACK);
    let bg = match opts.background {
        BackgroundMode::Palette => pal_bg,
        BackgroundMode::Black => Color::BLACK,
    };
    let fg = palette
        .foreground
        .or(palette.ansi[7])
        .unwrap_or(Color::rgb8(0xd0, 0xd0, 0xd0));
    let accent = palette.accent(&opts.accent)?;

    let bg_l = bg.to_oklch().l;
    let dark = bg_l < 0.5;
    // Lightness targets relative to the background, moving toward the far end.
    let toward = |amount: f32| {
        if dark {
            bg_l + (1.0 - bg_l) * amount
        } else {
            bg_l * (1.0 - amount)
        }
    };

    let (minor, major) = match opts.style {
        Style::Subtle => {
            let a = accent.to_oklch();
            let minor = Oklch {
                l: toward(0.40),
                c: a.c.min(0.055),
                h: a.h,
            }
            .to_color();
            let major = Oklch {
                l: toward(0.70),
                c: a.c.min(0.05),
                h: a.h,
            }
            .to_color();
            (minor, major)
        }
        Style::Vivid => {
            let a = accent.to_oklch();
            let minor = Oklch {
                l: toward(0.45)
                    .min(a.l)
                    .max(if dark { bg_l + 0.2 } else { 0.0 }),
                c: a.c * 0.85,
                h: a.h,
            }
            .to_color();
            (minor, accent)
        }
        Style::Mono => (bg.mix(fg, 0.35), bg.mix(fg, 0.75)),
    };

    let name = format!(
        "{} ({})",
        palette.name.clone().unwrap_or_else(|| "palette".into()),
        match opts.style {
            Style::Subtle => "subtle",
            Style::Vivid => "vivid",
            Style::Mono => "mono",
        }
    );
    Ok(Theme {
        name: Some(name),
        background: bg.to_hex(),
        lines: vec![
            LineTier {
                every: opts.interval_m,
                offset: 0.0,
                width: 1.25,
                opacity: 1.0,
                color: Paint::Solid(minor.to_hex()),
            },
            LineTier {
                every: opts.interval_m * opts.index_every as f64,
                offset: 0.0,
                width: 1.8,
                opacity: 1.0,
                color: Paint::Solid(major.to_hex()),
            },
        ],
        shader: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtle_theme_is_dimmer_than_vivid() {
        let p = Palette::load("solarized-dark").unwrap();
        let subtle = to_theme(&p, &GenerateOptions::default()).unwrap();
        let vivid = to_theme(
            &p,
            &GenerateOptions {
                style: Style::Vivid,
                ..Default::default()
            },
        )
        .unwrap();
        let chroma = |t: &Theme| match &t.lines[1].color {
            Paint::Solid(c) => Color::parse(c).unwrap().to_oklch().c,
            _ => unreachable!(),
        };
        assert!(chroma(&subtle) < chroma(&vivid));
    }
}
