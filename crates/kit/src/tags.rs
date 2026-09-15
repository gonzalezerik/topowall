//! Tags for the built-in color schemes, computed from their colors:
//! dark/light, muted/vivid, mono/duo/multi, a hue family and warm/cool, describing
//! the map each scheme draws.
//!
//! The tags ship in `palettes/palettes.json` (written by the `palette-catalog`
//! example); a test keeps the file in sync with [`compute`].

use crate::color::Color;
use anyhow::{bail, Context, Result};
use std::sync::OnceLock;

/// Hue families in OKLCH degrees: (name, hue where the family starts).
const FAMILIES: &[(&str, f32)] = &[
    ("red", 10.0),
    ("orange", 45.0),
    ("yellow", 80.0),
    ("green", 125.0),
    ("cyan", 170.0),
    ("blue", 225.0),
    ("purple", 290.0),
    ("pink", 335.0),
];

/// Every tag [`compute`] can produce, in the order they are listed.
pub const ALL: &[&str] = &[
    "dark", "light", "muted", "vivid", "mono", "duo", "multi", "warm", "cool", "neutral", "red",
    "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray",
];

/// Below this OKLCH chroma a color counts as gray.
const GRAY: f32 = 0.035;
/// A line color with at least this OKLCH chroma is "vivid".
const VIVID: f32 = 0.125;
/// Hues at least this many degrees apart start a new group.
const HUE_GAP: f32 = 50.0;

fn family(h: f32) -> &'static str {
    FAMILIES
        .iter()
        .rev()
        .find(|(_, start)| h >= *start)
        .map(|(n, _)| *n)
        .unwrap_or("pink")
}

/// Tags for a base16 scheme (`base00`..`base0F`), in this order:
/// dark|light, muted|vivid, mono|duo|multi, warm|cool|neutral, hue family.
///
/// Tone, saturation and hue describe the map a palette draws: the background,
/// and the accent color its contour lines are made from (the one `--accent auto`
/// picks). Variety describes the scheme's whole set of accent colors.
pub fn compute(base: &[Color; 16]) -> Vec<&'static str> {
    let lch = base.map(|c| c.to_oklch());
    let mut tags = Vec::with_capacity(5);

    // Tone: the background.
    tags.push(if lch[0x0].l < 0.5 { "dark" } else { "light" });

    // Saturation and hue: the line color.
    let accent = crate::palette::Palette::from_base16(base)
        .accent("auto")
        .map(|c| c.to_oklch())
        .unwrap_or(lch[0x5]);
    tags.push(if accent.c >= VIVID { "vivid" } else { "muted" });

    // Hue variety: how far the colorful accents spread around the hue circle,
    // and how many separate groups they form.
    let accents = &lch[0x8..=0xE];
    let mut hues: Vec<f32> = accents
        .iter()
        .filter(|c| c.c >= GRAY)
        .map(|c| c.h)
        .collect();
    hues.sort_by(f32::total_cmp);
    tags.push(if hues.len() < 2 {
        "mono"
    } else {
        let gaps: Vec<f32> = (0..hues.len())
            .map(|i| (hues[(i + 1) % hues.len()] - hues[i]).rem_euclid(360.0))
            .collect();
        let spread = 360.0 - gaps.iter().copied().fold(0.0, f32::max);
        let groups = gaps.iter().filter(|g| **g >= HUE_GAP).count();
        if spread < 75.0 {
            "mono"
        } else if groups == 2 || spread < 150.0 {
            "duo"
        } else {
            "multi"
        }
    });

    let hue = if accent.c < GRAY {
        "gray"
    } else {
        family(accent.h)
    };
    tags.push(match hue {
        "red" | "orange" | "yellow" | "pink" => "warm",
        "gray" => "neutral",
        _ => "cool",
    });
    tags.push(hue);
    tags
}

/// A built-in scheme in the shipped catalog.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub title: String,
    pub tags: Vec<String>,
}

const CATALOG_JSON: &str = include_str!("../palettes/palettes.json");

/// The shipped catalog (`palettes/palettes.json`), sorted by name.
pub fn catalog() -> &'static [Entry] {
    static CATALOG: OnceLock<Vec<Entry>> = OnceLock::new();
    CATALOG.get_or_init(|| parse_catalog(CATALOG_JSON).expect("palettes.json is valid"))
}

pub fn parse_catalog(text: &str) -> Result<Vec<Entry>> {
    let v: serde_json::Value = serde_json::from_str(text)?;
    let list = v
        .get("palettes")
        .and_then(|p| p.as_array())
        .context("palettes.json needs a \"palettes\" array")?;
    list.iter()
        .map(|p| {
            let s = |k: &str| {
                p.get(k)
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
                    .with_context(|| format!("palette entry without \"{k}\""))
            };
            Ok(Entry {
                name: s("name")?,
                title: s("title")?,
                tags: p
                    .get("tags")
                    .and_then(|t| t.as_array())
                    .map(|t| {
                        t.iter()
                            .filter_map(|x| x.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// Parse a `--filter` value like `dark,cool` into known tags.
pub fn parse_filter(filter: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for t in filter.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        let t = t.to_ascii_lowercase();
        let t = match t.as_str() {
            "grey" => "gray".to_string(),
            "magenta" | "violet" => "purple".to_string(),
            _ => t,
        };
        if !ALL.contains(&t.as_str()) {
            bail!("unknown tag '{t}'; tags are: {}", ALL.join(", "));
        }
        out.push(t);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hue_families() {
        let fam = |hex: &str| family(Color::parse(hex).unwrap().to_oklch().h);
        assert_eq!(fam("#ff0000"), "red");
        assert_eq!(fam("#ff8000"), "orange");
        assert_eq!(fam("#ffff00"), "yellow");
        assert_eq!(fam("#00ff00"), "green");
        assert_eq!(fam("#00ffff"), "cyan");
        assert_eq!(fam("#0000ff"), "blue");
        assert_eq!(fam("#8000ff"), "purple");
        assert_eq!(fam("#ff60b0"), "pink");
    }

    #[test]
    fn shipped_catalog_matches_computed_tags() {
        let names: Vec<&str> = crate::palette::builtin_names().collect();
        let fix = "palettes.json is out of date; run `cargo run -p topowall-kit --example palette-catalog`";
        assert_eq!(catalog().len(), names.len(), "{fix}");
        for (entry, name) in catalog().iter().zip(names) {
            let (base, _) = crate::palette::builtin_base16(name).unwrap();
            assert_eq!(entry.name, name, "{fix}");
            assert_eq!(entry.tags, compute(&base), "{name}: {fix}");
        }
    }

    #[test]
    fn filter_accepts_known_tags_only() {
        assert_eq!(parse_filter("Dark, cool").unwrap(), ["dark", "cool"]);
        assert!(parse_filter("dark,spooky").is_err());
    }
}
