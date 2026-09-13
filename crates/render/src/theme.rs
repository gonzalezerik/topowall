//! Themes: how contours are colored.
//!
//! ```toml
//! name = "My theme"
//! background = "#000000"
//!
//! [[lines]]              # a tier of contour lines
//! every = 20             # metres between lines
//! color = "#3e5d58"      # hex or oklch(L C H)
//! width = 1.25           # output pixels
//!
//! [[lines]]              # later tiers draw on top (index lines)
//! every = 100
//! width = 1.8
//! color = [              # or a ramp over elevation
//!   { at = "0%",   color = "#3e5d58" },
//!   { at = 2500,   color = "#92aca0" },   # metres
//! ]
//! ```
//!
//! Optional: `shader = "my-shade.wgsl"` replaces the shading function
//! (see `shaders/contour.wgsl`, `fn shade`).

use crate::color::Color;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Theme {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default = "default_background")]
    pub background: String,
    #[serde(default)]
    pub lines: Vec<LineTier>,
    /// Path to a WGSL file defining `fn shade(s: ShadeInput) -> vec4<f32>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shader: Option<PathBuf>,
}

fn default_background() -> String {
    "#000000".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LineTier {
    /// Metres between lines.
    pub every: f64,
    /// Shift lines by this many metres.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub offset: f64,
    /// Line width in output pixels.
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_opacity", skip_serializing_if = "is_one")]
    pub opacity: f64,
    pub color: Paint,
}

fn default_width() -> f64 {
    1.25
}
fn default_opacity() -> f64 {
    1.0
}
fn is_zero(v: &f64) -> bool {
    *v == 0.0
}
fn is_one(v: &f64) -> bool {
    *v == 1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Paint {
    Solid(String),
    Ramp(Vec<Stop>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stop {
    pub at: At,
    pub color: String,
}

/// A ramp position: metres (`2500`) or a percentage of the map's elevation range (`"40%"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum At {
    Metres(f64),
    Relative(String),
}

impl At {
    pub fn resolve(&self, min_m: f32, max_m: f32) -> Result<f32> {
        match self {
            At::Metres(m) => Ok(*m as f32),
            At::Relative(s) => {
                let pct: f32 = s
                    .trim()
                    .strip_suffix('%')
                    .and_then(|p| p.trim().parse().ok())
                    .with_context(|| {
                        format!("ramp position '{s}' must be metres or a percentage like \"40%\"")
                    })?;
                Ok(min_m + (max_m - min_m) * pct / 100.0)
            }
        }
    }
}

/// A theme with colors parsed and ramp positions resolved to metres.
#[derive(Debug, Clone)]
pub struct ResolvedTheme {
    pub background: Color,
    pub tiers: Vec<ResolvedTier>,
    pub shader: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedTier {
    pub every: f32,
    pub offset: f32,
    pub width: f32,
    pub opacity: f32,
    /// (elevation in metres, color), sorted by elevation; one entry = solid.
    pub stops: Vec<(f32, Color)>,
}

const BUILTIN: &[(&str, &str)] = include!(concat!(env!("OUT_DIR"), "/themes.rs"));

impl Theme {
    pub fn builtin_names() -> impl Iterator<Item = &'static str> {
        BUILTIN.iter().map(|(n, _)| *n)
    }

    /// Load a theme from a file path, or a built-in theme by name.
    /// Returns the theme and the directory relative paths resolve against.
    pub fn load(name_or_path: &str) -> Result<(Theme, Option<PathBuf>)> {
        let path = Path::new(name_or_path);
        if path.is_file() {
            let text = std::fs::read_to_string(path)?;
            let theme =
                Self::from_toml(&text).with_context(|| format!("in theme {}", path.display()))?;
            return Ok((theme, path.parent().map(Path::to_path_buf)));
        }
        match BUILTIN.iter().find(|(n, _)| *n == name_or_path) {
            Some((_, text)) => Ok((Self::from_toml(text)?, None)),
            None => bail!(
                "no theme file or built-in theme named '{name_or_path}' (built-in: {})",
                Self::builtin_names().collect::<Vec<_>>().join(", ")
            ),
        }
    }

    pub fn from_toml(text: &str) -> Result<Theme> {
        Ok(toml::from_str(text)?)
    }

    pub fn to_toml(&self) -> Result<String> {
        Ok(toml::to_string_pretty(self)?)
    }

    pub fn resolve(
        &self,
        min_m: f32,
        max_m: f32,
        base_dir: Option<&Path>,
    ) -> Result<ResolvedTheme> {
        let background = Color::parse(&self.background).context("background")?;
        let mut tiers = Vec::with_capacity(self.lines.len());
        for (i, t) in self.lines.iter().enumerate() {
            if t.every <= 0.0 {
                bail!("lines[{i}].every must be > 0");
            }
            let mut stops = match &t.color {
                Paint::Solid(c) => vec![(
                    0.0,
                    Color::parse(c).with_context(|| format!("lines[{i}].color"))?,
                )],
                Paint::Ramp(stops) => {
                    if stops.is_empty() {
                        bail!("lines[{i}].color ramp is empty");
                    }
                    stops
                        .iter()
                        .map(|s| Ok((s.at.resolve(min_m, max_m)?, Color::parse(&s.color)?)))
                        .collect::<Result<Vec<_>>>()
                        .with_context(|| format!("lines[{i}].color"))?
                }
            };
            stops.sort_by(|a, b| a.0.total_cmp(&b.0));
            tiers.push(ResolvedTier {
                every: t.every as f32,
                offset: t.offset as f32,
                width: t.width as f32,
                opacity: t.opacity as f32,
                stops,
            });
        }
        let shader = match &self.shader {
            None => None,
            Some(p) => {
                let full = match base_dir {
                    Some(d) if p.is_relative() => d.join(p),
                    _ => p.clone(),
                };
                Some(
                    std::fs::read_to_string(&full)
                        .with_context(|| format!("reading shader {}", full.display()))?,
                )
            }
        };
        Ok(ResolvedTheme {
            background,
            tiers,
            shader,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_themes_parse() {
        for name in Theme::builtin_names() {
            let (t, _) = Theme::load(name).unwrap();
            t.resolve(0.0, 1000.0, None).unwrap();
        }
    }

    #[test]
    fn ramp_percentages() {
        let t = Theme::from_toml(
            "[[lines]]\nevery = 50\ncolor = [{ at = \"50%\", color = \"#fff\" }, { at = 100, color = \"#000\" }]\n",
        )
        .unwrap();
        let r = t.resolve(0.0, 1000.0, None).unwrap();
        assert_eq!(r.tiers[0].stops[0].0, 100.0);
        assert_eq!(r.tiers[0].stops[1].0, 500.0);
    }
}
