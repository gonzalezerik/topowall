//! Palettes: color schemes from terminals/editors, pywal, or images.

use crate::color::Color;
use anyhow::{bail, Context, Result};
use std::path::Path;

/// Terminal-style palette: background, foreground and the 16 ANSI colors
/// (0 black, 1 red, 2 green, 3 yellow, 4 blue, 5 magenta, 6 cyan, 7 white, 8–15 bright).
#[derive(Debug, Clone, Default)]
pub struct Palette {
    pub name: Option<String>,
    pub background: Option<Color>,
    pub foreground: Option<Color>,
    pub ansi: [Option<Color>; 16],
    /// Extra candidate accents in priority order (used for image palettes).
    pub accents: Vec<Color>,
}

const BASE16: &[(&str, &str)] = include!(concat!(env!("OUT_DIR"), "/base16.rs"));

pub fn builtin_names() -> impl Iterator<Item = &'static str> {
    BASE16.iter().map(|(n, _)| *n)
}

/// The sixteen colors (`base00`..`base0F`) and display title of a built-in scheme.
pub fn builtin_base16(name: &str) -> Option<([Color; 16], String)> {
    let (_, text) = BASE16.iter().find(|(n, _)| *n == name)?;
    let (base, title) = base16_colors(text).ok()?;
    Some((base, title.unwrap_or_else(|| name.to_string())))
}

/// A built-in scheme picked at random.
pub fn random_builtin() -> &'static str {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default(),
    );
    BASE16[(h.finish() % BASE16.len() as u64) as usize].0
}

impl Palette {
    /// Load a palette from a built-in scheme name or a file. The format is
    /// detected from the file name and contents.
    pub fn load(name_or_path: &str) -> Result<Palette> {
        let path = Path::new(name_or_path);
        if !path.is_file() {
            let wanted = name_or_path.to_ascii_lowercase().replace([' ', '_'], "-");
            if let Some((_, text)) = BASE16.iter().find(|(n, _)| *n == wanted) {
                return parse_base16(text);
            }
            let close = crate::suggest::closest(&wanted, builtin_names(), 5);
            if close.is_empty() {
                bail!("no palette file or built-in scheme named '{name_or_path}' (see `topowall palettes`)");
            }
            bail!(
                "no built-in scheme '{name_or_path}'; did you mean: {}",
                close.join(", ")
            );
        }
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();

        let mut p = if ext == "itermcolors" || text.contains("<plist") {
            parse_iterm(&text)?
        } else if ext == "json" {
            let v: serde_json::Value = serde_json::from_str(&text)?;
            if v.get("special").is_some()
                || v.get("colors").is_some_and(|c| c.get("color0").is_some())
            {
                parse_pywal(&v)?
            } else {
                parse_windows_terminal(&v)?
            }
        } else if (ext == "yaml" || ext == "yml") && text.contains("base00") {
            parse_base16(&text)?
        } else if ext == "toml" && text.contains("[colors") {
            parse_alacritty(&text)?
        } else {
            // Plain-text terminal configs: try each reader and keep the one that finds the most colors.
            let count = |p: &Palette| {
                p.background.is_some() as usize
                    + p.foreground.is_some() as usize
                    + p.ansi.iter().flatten().count()
            };
            [
                parse_foot(&text)?,
                parse_kitty(&text),
                parse_ghostty(&text),
                parse_xresources(&text),
            ]
            .into_iter()
            .max_by_key(count)
            .unwrap_or_default()
        };
        if p.background.is_none() && p.ansi.iter().all(Option::is_none) {
            bail!(
                "{}: no colors found (unrecognised palette format)",
                path.display()
            );
        }
        p.name.get_or_insert_with(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
        Ok(p)
    }
}

fn color_loose(s: &str) -> Option<Color> {
    let s = s.trim().trim_matches(|c| c == '"' || c == '\'' || c == ',');
    let s = s
        .strip_prefix("0x")
        .map(|h| format!("#{h}"))
        .unwrap_or_else(|| s.to_string());
    let s = if !s.starts_with('#') && !s.starts_with("oklch") {
        format!("#{s}")
    } else {
        s
    };
    Color::parse(&s).ok()
}

/// A YAML scalar value without quotes or a trailing `# comment`.
fn yaml_scalar(v: &str) -> &str {
    let v = v.trim();
    for q in ['"', '\''] {
        if let Some(rest) = v.strip_prefix(q) {
            return rest.split(q).next().unwrap_or(rest);
        }
    }
    v.split(" #").next().unwrap_or(v).trim()
}

fn base16_colors(text: &str) -> Result<([Color; 16], Option<String>)> {
    let mut base = [None; 16];
    let mut name = None;
    for line in text.lines() {
        let Some((k, v)) = line.trim().split_once(':') else {
            continue;
        };
        let (k, v) = (k.trim(), yaml_scalar(v));
        if k == "name" {
            name = Some(v.to_string());
        } else if let Some(idx) = k
            .strip_prefix("base0")
            .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            base[idx as usize] = color_loose(v);
        }
    }
    if base.iter().any(Option::is_none) {
        bail!("base16 scheme is missing some of base00..base0F");
    }
    Ok((base.map(|c| c.unwrap()), name))
}

fn parse_base16(text: &str) -> Result<Palette> {
    let (base, name) = base16_colors(text)?;
    let b = |i: usize| Some(base[i]);
    // Standard base16 → ANSI mapping.
    let ansi = [
        b(0x0),
        b(0x8),
        b(0xB),
        b(0xA),
        b(0xD),
        b(0xE),
        b(0xC),
        b(0x5),
        b(0x3),
        b(0x8),
        b(0xB),
        b(0xA),
        b(0xD),
        b(0xE),
        b(0xC),
        b(0x7),
    ];
    Ok(Palette {
        name,
        background: b(0x0),
        foreground: b(0x5),
        ansi,
        accents: vec![],
    })
}

fn parse_pywal(v: &serde_json::Value) -> Result<Palette> {
    let get = |path: &[&str]| {
        path.iter()
            .try_fold(v, |acc, k| acc.get(k))
            .and_then(|x| x.as_str())
            .and_then(color_loose)
    };
    let mut p = Palette {
        name: Some("pywal".into()),
        background: get(&["special", "background"]),
        foreground: get(&["special", "foreground"]),
        ..Default::default()
    };
    for i in 0..16 {
        p.ansi[i] = get(&["colors", &format!("color{i}")]);
    }
    Ok(p)
}

fn parse_windows_terminal(v: &serde_json::Value) -> Result<Palette> {
    // Accept a single scheme object or a settings.json with "schemes": [...]
    let scheme = v.get("schemes").and_then(|s| s.get(0)).unwrap_or(v);
    let get = |k: &str| scheme.get(k).and_then(|x| x.as_str()).and_then(color_loose);
    let names = [
        "black",
        "red",
        "green",
        "yellow",
        "blue",
        "purple",
        "cyan",
        "white",
        "brightBlack",
        "brightRed",
        "brightGreen",
        "brightYellow",
        "brightBlue",
        "brightPurple",
        "brightCyan",
        "brightWhite",
    ];
    let mut p = Palette {
        name: scheme
            .get("name")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        background: get("background"),
        foreground: get("foreground"),
        ..Default::default()
    };
    for (i, n) in names.iter().enumerate() {
        p.ansi[i] = get(n);
    }
    Ok(p)
}

fn parse_alacritty(text: &str) -> Result<Palette> {
    let v: toml::Value = toml::from_str(text)?;
    let colors = v.get("colors").context("no [colors] table")?;
    let get = |sect: &str, k: &str| {
        colors
            .get(sect)
            .and_then(|s| s.get(k))
            .and_then(|x| x.as_str())
            .and_then(color_loose)
    };
    let names = [
        "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    ];
    let mut p = Palette {
        background: get("primary", "background"),
        foreground: get("primary", "foreground"),
        ..Default::default()
    };
    for (i, n) in names.iter().enumerate() {
        p.ansi[i] = get("normal", n);
        p.ansi[i + 8] = get("bright", n);
    }
    Ok(p)
}

fn parse_foot(text: &str) -> Result<Palette> {
    let mut p = Palette::default();
    let mut in_colors = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_colors = line == "[colors]" || line == "[colors-dark]";
            continue;
        }
        if !in_colors {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let (k, v) = (k.trim(), v.split('#').next().unwrap_or("").trim());
        match k {
            "background" => p.background = color_loose(v),
            "foreground" => p.foreground = color_loose(v),
            _ => {
                if let Some(i) = k
                    .strip_prefix("regular")
                    .and_then(|n| n.parse::<usize>().ok())
                    .filter(|i| *i < 8)
                {
                    p.ansi[i] = color_loose(v);
                } else if let Some(i) = k
                    .strip_prefix("bright")
                    .and_then(|n| n.parse::<usize>().ok())
                    .filter(|i| *i < 8)
                {
                    p.ansi[i + 8] = color_loose(v);
                }
            }
        }
    }
    Ok(p)
}

fn parse_kitty(text: &str) -> Palette {
    let mut p = Palette::default();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(k), Some(v)) = (it.next(), it.next()) else {
            continue;
        };
        match k {
            "background" => p.background = color_loose(v),
            "foreground" => p.foreground = color_loose(v),
            _ => {
                if let Some(i) = k
                    .strip_prefix("color")
                    .and_then(|n| n.parse::<usize>().ok())
                    .filter(|i| *i < 16)
                {
                    p.ansi[i] = color_loose(v);
                }
            }
        }
    }
    p
}

fn parse_ghostty(text: &str) -> Palette {
    let mut p = Palette::default();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k.trim() {
            "background" => p.background = color_loose(v),
            "foreground" => p.foreground = color_loose(v),
            "palette" => {
                if let Some((i, c)) = v.trim().split_once('=') {
                    if let Ok(i) = i.trim().parse::<usize>() {
                        if i < 16 {
                            p.ansi[i] = color_loose(c);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    p
}

fn parse_xresources(text: &str) -> Palette {
    let mut p = Palette::default();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('!') {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let k = k.trim().trim_start_matches(['*', '.']);
        let k = k.rsplit(['.', '*']).next().unwrap_or(k);
        match k {
            "background" => p.background = color_loose(v),
            "foreground" => p.foreground = color_loose(v),
            _ => {
                if let Some(i) = k
                    .strip_prefix("color")
                    .and_then(|n| n.parse::<usize>().ok())
                    .filter(|i| *i < 16)
                {
                    p.ansi[i] = color_loose(v);
                }
            }
        }
    }
    p
}

fn parse_iterm(text: &str) -> Result<Palette> {
    // Minimal plist scan: <key>Ansi 4 Color</key><dict>…<key>Red Component</key><real>0.1</real>…</dict>
    let mut p = Palette::default();
    let mut rest = text;
    while let Some(start) = rest.find("<key>") {
        rest = &rest[start + 5..];
        let Some(end) = rest.find("</key>") else {
            break;
        };
        let key = rest[..end].to_string();
        rest = &rest[end..];
        let Some(dict_end) = rest.find("</dict>") else {
            break;
        };
        let body = &rest[..dict_end];
        if !body
            .trim_start_matches("</key>")
            .trim_start()
            .starts_with("<dict>")
        {
            continue;
        }
        let comp = |name: &str| -> Option<f32> {
            let i = body.find(&format!("<key>{name}</key>"))?;
            let after = &body[i..];
            let s = after.find("<real>")? + 6;
            let e = after[s..].find("</real>")? + s;
            after[s..e].trim().parse().ok()
        };
        if let (Some(r), Some(g), Some(b)) = (
            comp("Red Component"),
            comp("Green Component"),
            comp("Blue Component"),
        ) {
            let c = Some(Color { r, g, b, a: 1.0 });
            match key.as_str() {
                "Background Color" => p.background = c,
                "Foreground Color" => p.foreground = c,
                k => {
                    if let Some(i) = k
                        .strip_prefix("Ansi ")
                        .and_then(|x| x.strip_suffix(" Color"))
                        .and_then(|n| n.parse::<usize>().ok())
                    {
                        if i < 16 {
                            p.ansi[i] = c;
                        }
                    }
                }
            }
            rest = &rest[dict_end..];
        }
    }
    Ok(p)
}

impl Palette {
    /// Resolve an accent choice: "auto", an ANSI name (red, green, yellow, blue,
    /// magenta, cyan, orange), an index "0".."15", or any color string.
    pub fn accent(&self, accent: &str) -> Result<Color> {
        let p = self;
        let named = |i: usize| p.ansi[i].or(p.ansi[i + 8]);
        let pick = match accent.to_ascii_lowercase().as_str() {
            "auto" => {
                let mut cands: Vec<Color> = p.accents.clone();
                cands.extend([4, 6, 2, 5, 3, 1].iter().filter_map(|&i| named(i)));
                // Prefer the first reasonably colorful candidate (image accents come first, then blue, cyan…).
                cands
                    .iter()
                    .copied()
                    .find(|c| c.to_oklch().c > 0.04)
                    .or_else(|| cands.first().copied())
            }
            "red" => named(1),
            "green" => named(2),
            "yellow" => named(3),
            "blue" => named(4),
            "magenta" | "purple" => named(5),
            "cyan" => named(6),
            "orange" => p.ansi.iter().flatten().copied().min_by(|a, b| {
                let d = |c: &Color| (c.to_oklch().h - 55.0).abs();
                d(a).total_cmp(&d(b))
            }),
            other => match other.parse::<usize>() {
                Ok(i) if i < 16 => p.ansi[i],
                _ => Some(
                    Color::parse(other).with_context(|| format!("unknown accent '{accent}'"))?,
                ),
            },
        };
        pick.or(p.foreground)
            .context("palette has no usable accent or foreground color")
    }
}

// ── Image palettes ──────────────────────────────────────────────────────────

/// Extract a palette from an image's dominant colors (k-means in OKLab).
pub fn from_image(path: &Path, k: usize) -> Result<Palette> {
    let img = image::open(path).with_context(|| format!("opening image {}", path.display()))?;
    let small = img.thumbnail(160, 160).to_rgb8();
    let pixels: Vec<[f32; 3]> = small
        .pixels()
        .map(|p| Color::rgb8(p[0], p[1], p[2]).to_oklab())
        .collect();
    if pixels.is_empty() {
        bail!("image {} has no pixels", path.display());
    }

    // Deterministic k-means++-style init: start from the darkest pixel, then farthest points.
    let dist = |a: &[f32; 3], b: &[f32; 3]| {
        (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)
    };
    let mut centers = vec![*pixels.iter().min_by(|a, b| a[0].total_cmp(&b[0])).unwrap()];
    while centers.len() < k.min(pixels.len()) {
        let far = pixels
            .iter()
            .max_by(|a, b| {
                let da = centers.iter().map(|c| dist(a, c)).fold(f32::MAX, f32::min);
                let db = centers.iter().map(|c| dist(b, c)).fold(f32::MAX, f32::min);
                da.total_cmp(&db)
            })
            .unwrap();
        centers.push(*far);
    }
    let mut counts = vec![0usize; centers.len()];
    for _ in 0..20 {
        let mut sums = vec![[0f32; 3]; centers.len()];
        counts.iter_mut().for_each(|c| *c = 0);
        for p in &pixels {
            let i = (0..centers.len())
                .min_by(|&a, &b| dist(p, &centers[a]).total_cmp(&dist(p, &centers[b])))
                .unwrap();
            counts[i] += 1;
            for d in 0..3 {
                sums[i][d] += p[d];
            }
        }
        for i in 0..centers.len() {
            if counts[i] > 0 {
                centers[i] = sums[i].map(|s| s / counts[i] as f32);
            }
        }
    }

    let total = pixels.len() as f32;
    let clusters: Vec<(Color, f32)> = centers
        .iter()
        .zip(&counts)
        .filter(|(_, &n)| n > 0)
        .map(|(c, &n)| (Color::from_oklab(*c), n as f32 / total))
        .collect();

    let background = clusters
        .iter()
        .min_by(|a, b| a.0.to_oklch().l.total_cmp(&b.0.to_oklch().l))
        .map(|c| c.0);
    let foreground = clusters
        .iter()
        .max_by(|a, b| a.0.to_oklch().l.total_cmp(&b.0.to_oklch().l))
        .map(|c| c.0);
    // Accents: colorful and common first.
    let mut accents: Vec<(Color, f32)> = clusters
        .iter()
        .map(|(c, w)| (*c, c.to_oklch().c * w.sqrt()))
        .collect();
    accents.sort_by(|a, b| b.1.total_cmp(&a.1));

    Ok(Palette {
        name: Some(
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        ),
        background,
        foreground,
        ansi: [None; 16],
        accents: accents.into_iter().map(|a| a.0).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_builtin_schemes_parse() {
        for (name, text) in BASE16 {
            parse_base16(text).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }

    #[test]
    fn rose_pine_values() {
        let p = Palette::load("rose-pine").unwrap();
        assert_eq!(p.background.unwrap().to_hex(), "#191724");
        assert_eq!(p.ansi[4].unwrap().to_hex(), "#c4a7e7");
    }

    #[test]
    fn foot_config() {
        let p = parse_foot("[main]\nfont=x\n[colors]\nbackground=282828\nforeground=ebdbb2\nregular4=458588 # blue\n").unwrap();
        assert_eq!(p.background.unwrap().to_hex(), "#282828");
        assert_eq!(p.ansi[4].unwrap().to_hex(), "#458588");
    }

    #[test]
    fn ghostty_without_palette_lines() {
        let dir = std::env::temp_dir().join(format!("topowall-ghostty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config");
        std::fs::write(
            &path,
            "font-size = 12\nbackground = #1a1b26\nforeground = #c0caf5\n",
        )
        .unwrap();
        let p = Palette::load(path.to_str().unwrap()).unwrap();
        assert_eq!(p.background.unwrap().to_hex(), "#1a1b26");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn kitty_and_xresources() {
        let k = parse_kitty("background #1e1e2e\ncolor4 #89b4fa\n");
        assert_eq!(k.ansi[4].unwrap().to_hex(), "#89b4fa");
        let x = parse_xresources("*.background: #002b36\n*color4: #268bd2\n");
        assert_eq!(x.background.unwrap().to_hex(), "#002b36");
        assert_eq!(x.ansi[4].unwrap().to_hex(), "#268bd2");
    }
}
