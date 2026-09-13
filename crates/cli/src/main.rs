use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};
use topowall_core::{fetch, topo};
use topowall_render::{
    palette::{self, BackgroundMode, GenerateOptions, Style},
    spacing, Framing, Palette, Renderer, Theme,
};

#[derive(Parser)]
#[command(
    name = "topowall",
    version,
    about = "Topographic contour wallpapers from real elevation data"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Download elevation for an area anywhere on Earth into a .topo heightmap.
    Fetch(FetchArgs),
    /// Render contours from an elevation file (.topo, GeoTIFF, .hgt, Terrarium PNG) to PNG or JPEG.
    Render(RenderArgs),
    /// Generate a theme file from a palette or an image without rendering.
    Theme(ThemeArgs),
    /// Show information about an elevation file.
    Info { input: PathBuf },
    /// List built-in themes.
    Themes,
    /// List built-in color schemes (for --palette).
    Palettes,
}

#[derive(Args)]
struct FetchArgs {
    /// Centre of the area as LAT,LON (e.g. 37.738,-119.575).
    #[arg(long, allow_hyphen_values = true)]
    center: String,
    /// Width of the area in kilometres.
    #[arg(long)]
    width_km: f64,
    /// Heightmap size in pixels, e.g. 5120x2160 (usually your screen resolution).
    #[arg(long)]
    size: String,
    /// Tile zoom level (default: matched to the output resolution).
    #[arg(long)]
    zoom: Option<u8>,
    /// Smoothing in metres; higher gives calmer, flowing lines.
    #[arg(long, default_value_t = 18.75)]
    smooth_m: f64,
    /// Refuse areas needing more tiles than this.
    #[arg(long, default_value_t = 1500)]
    max_tiles: usize,
    #[arg(short, long)]
    output: PathBuf,
}

#[derive(Clone, Copy, ValueEnum)]
enum StyleArg {
    Subtle,
    Vivid,
    Mono,
}

#[derive(Clone, Copy, ValueEnum)]
enum BackgroundArg {
    Palette,
    Black,
}

#[derive(Args)]
struct ColorArgs {
    /// Theme file or built-in theme name (see `topowall themes`).
    #[arg(long, conflicts_with_all = ["palette", "palette_from_image"])]
    theme: Option<String>,
    /// Color scheme: a built-in name (rose-pine, solarized-dark, …) or a file:
    /// base16 YAML, pywal colors.json, Alacritty, Kitty, foot, Ghostty,
    /// Xresources, iTerm2 .itermcolors, Windows Terminal JSON.
    #[arg(long, conflicts_with = "palette_from_image")]
    palette: Option<String>,
    /// Build a palette from an image's dominant colors.
    #[arg(long)]
    palette_from_image: Option<PathBuf>,
    /// Accent for palette themes: auto, red, green, yellow, blue, magenta, cyan, orange, 0-15, or a color.
    #[arg(long, default_value = "auto")]
    accent: String,
    /// How palette colors become line colors.
    #[arg(long, value_enum, default_value_t = StyleArg::Subtle)]
    style: StyleArg,
    /// Background for palette themes.
    #[arg(long, value_enum, default_value_t = BackgroundArg::Palette)]
    background: BackgroundArg,
    /// Metres between contour lines, or "auto" to fit the terrain and output size.
    /// Applies to themes too: every line tier scales together.
    #[arg(long)]
    interval: Option<String>,
    /// Every n-th line is an index line (the second tier).
    #[arg(long)]
    index_every: Option<u32>,
}

#[derive(Args)]
struct RenderArgs {
    input: PathBuf,
    #[command(flatten)]
    colors: ColorArgs,
    /// Output size, e.g. 5120x2160 (default: the heightmap's size).
    #[arg(long)]
    size: Option<String>,
    /// Fixed ground scale in metres per output pixel (default: fill the output).
    #[arg(long)]
    scale: Option<f64>,
    /// Also write the theme used to this TOML file.
    #[arg(long)]
    save_theme: Option<PathBuf>,
    /// JPEG quality (1-100) when the output ends in .jpg/.jpeg.
    #[arg(long, default_value_t = 90, value_parser = clap::value_parser!(u8).range(1..=100))]
    quality: u8,
    #[arg(short, long)]
    output: PathBuf,
}

#[derive(Args)]
struct ThemeArgs {
    #[command(flatten)]
    colors: ColorArgs,
    /// Where to write the theme (default: stdout).
    #[arg(short, long)]
    output: Option<PathBuf>,
}

fn parse_size(s: &str) -> Result<(u32, u32)> {
    let (w, h) = s
        .split_once(['x', 'X'])
        .with_context(|| format!("size '{s}' must look like 2880x1800"))?;
    Ok((w.trim().parse()?, h.trim().parse()?))
}

fn parse_center(s: &str) -> Result<(f64, f64)> {
    let (lat, lon) = s
        .split_once(',')
        .with_context(|| format!("center '{s}' must be LAT,LON"))?;
    let (lat, lon): (f64, f64) = (lat.trim().parse()?, lon.trim().parse()?);
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        bail!("center out of range: latitude {lat}, longitude {lon}");
    }
    Ok((lat, lon))
}

fn cache_dir() -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(std::env::temp_dir)
        .join("topowall/terrarium")
}

/// Pick the theme from --theme / --palette / --palette-from-image (default: graphite).
fn resolve_theme(c: &ColorArgs) -> Result<(Theme, Option<PathBuf>)> {
    let opts = GenerateOptions {
        accent: c.accent.clone(),
        style: match c.style {
            StyleArg::Subtle => Style::Subtle,
            StyleArg::Vivid => Style::Vivid,
            StyleArg::Mono => Style::Mono,
        },
        background: match c.background {
            BackgroundArg::Palette => BackgroundMode::Palette,
            BackgroundArg::Black => BackgroundMode::Black,
        },
        interval_m: 20.0,
        index_every: 5,
    };
    if let Some(img) = &c.palette_from_image {
        return Ok((palette::from_image(img, 8)?.to_theme(&opts)?, None));
    }
    if let Some(p) = &c.palette {
        return Ok((Palette::load(p)?.to_theme(&opts)?, None));
    }
    Theme::load(c.theme.as_deref().unwrap_or("graphite"))
}

/// Apply --interval / --index-every. `auto` needs the heightmap and framing.
fn apply_spacing(
    theme: &mut Theme,
    c: &ColorArgs,
    auto: Option<(&topowall_core::Heightmap, f64)>,
) -> Result<Option<f64>> {
    let interval = match c.interval.as_deref() {
        None => None,
        Some("auto") => {
            let (hm, tex_per_px) =
                auto.context("--interval auto needs an elevation file (use it with `render`)")?;
            Some(spacing::auto_interval(hm, tex_per_px, 6.0))
        }
        Some(v) => Some(
            v.parse::<f64>()
                .with_context(|| format!("--interval '{v}' must be metres or \"auto\""))?,
        ),
    };
    match (interval, c.index_every) {
        (Some(i), n) => theme.set_spacing(i, n)?,
        (None, Some(n)) => {
            let base = theme.lines.first().map(|t| t.every).unwrap_or(20.0);
            theme.set_spacing(base, Some(n))?
        }
        (None, None) => {}
    }
    Ok(interval)
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Fetch(a) => cmd_fetch(a),
        Command::Render(a) => cmd_render(a),
        Command::Theme(a) => {
            let (mut theme, _) = resolve_theme(&a.colors)?;
            apply_spacing(&mut theme, &a.colors, None)?;
            let text = theme.to_toml()?;
            match a.output {
                Some(p) => {
                    std::fs::write(&p, text).with_context(|| format!("writing {}", p.display()))?
                }
                None => print!("{text}"),
            }
            Ok(())
        }
        Command::Info { input } => cmd_info(&input),
        Command::Themes => {
            Theme::builtin_names().for_each(|n| println!("{n}"));
            Ok(())
        }
        Command::Palettes => {
            palette::builtin_names().for_each(|n| println!("{n}"));
            Ok(())
        }
    }
}

fn cmd_fetch(a: FetchArgs) -> Result<()> {
    let (lat, lon) = parse_center(&a.center)?;
    let (w, h) = parse_size(&a.size)?;
    let req = fetch::Request {
        center_lat: lat,
        center_lon: lon,
        width_km: a.width_km,
        width_px: w as usize,
        height_px: h as usize,
        zoom: a.zoom,
        smooth_m: a.smooth_m,
        max_tiles: a.max_tiles,
        cache_dir: cache_dir(),
    };
    let t = Instant::now();
    eprintln!(
        "area {:.2} x {:.2} km, {:.2} m/px, zoom {}",
        a.width_km,
        a.width_km * h as f64 / w as f64,
        req.m_per_px(),
        a.zoom.unwrap_or_else(|| req.auto_zoom())
    );
    let hm = fetch::fetch(&req, |done, total| {
        eprint!("\rtiles {done}/{total}");
        let _ = std::io::stderr().flush();
    })?;
    eprintln!();
    topo::write(&hm, &a.output)?;
    let (lo, hi) = hm.min_max();
    eprintln!(
        "wrote {} ({}x{}, elevation {lo:.0}..{hi:.0} m) in {:.1}s",
        a.output.display(),
        hm.width,
        hm.height,
        t.elapsed().as_secs_f32()
    );
    Ok(())
}

fn cmd_render(a: RenderArgs) -> Result<()> {
    let hm = topowall_core::load(&a.input)?;
    let (w, h) = match &a.size {
        Some(s) => parse_size(s)?,
        None => (hm.width as u32, hm.height as u32),
    };
    let framing = a
        .scale
        .map(Framing::MetresPerPixel)
        .unwrap_or(Framing::Cover);
    let (mut theme, base) = resolve_theme(&a.colors)?;
    if let Some(i) = apply_spacing(
        &mut theme,
        &a.colors,
        Some((&hm, framing.tex_per_px(&hm, w, h)?)),
    )? {
        if a.colors.interval.as_deref() == Some("auto") {
            eprintln!("interval: {i} m");
        }
    }
    let (lo, hi) = hm.min_max();
    let resolved = theme.resolve(lo, hi, base.as_deref())?;
    if let Some(p) = &a.save_theme {
        std::fs::write(p, theme.to_toml()?).with_context(|| format!("writing {}", p.display()))?;
    }

    let t = Instant::now();
    let renderer = Renderer::new()?;
    let pixels = renderer.render(&hm, &resolved, w, h, framing)?;
    save_image(&a.output, w, h, pixels, a.quality)?;
    eprintln!(
        "rendered {}x{} with '{}' on {} in {:.2}s → {}",
        w,
        h,
        theme.name.as_deref().unwrap_or("theme"),
        renderer.adapter_name(),
        t.elapsed().as_secs_f32(),
        a.output.display()
    );
    Ok(())
}

/// Save as PNG, or JPEG when the extension is .jpg/.jpeg.
fn save_image(path: &Path, w: u32, h: u32, rgba: Vec<u8>, quality: u8) -> Result<()> {
    let img = image::RgbaImage::from_raw(w, h, rgba).context("pixel buffer size mismatch")?;
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let result = if ext == "jpg" || ext == "jpeg" {
        let file = std::fs::File::create(path)?;
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(
            std::io::BufWriter::new(file),
            quality,
        );
        rgb.write_with_encoder(enc)
    } else {
        rgb.save(path)
    };
    result.with_context(|| format!("writing {}", path.display()))
}

fn cmd_info(input: &Path) -> Result<()> {
    let hm = topowall_core::load(input)?;
    let (lo, hi) = hm.min_max();
    println!("size       {} x {}", hm.width, hm.height);
    println!("elevation  {lo:.1} .. {hi:.1} m");
    if let Some(m) = hm.m_per_px {
        println!(
            "resolution {m:.2} m/px ({:.2} x {:.2} km)",
            hm.width as f64 * m / 1000.0,
            hm.height as f64 * m / 1000.0
        );
    }
    if let Some(e) = hm.extent {
        println!(
            "extent     W {:.5}  S {:.5}  E {:.5}  N {:.5}",
            e.west, e.south, e.east, e.north
        );
    }
    if let Some(s) = &hm.source {
        println!("source     {s}");
    }
    Ok(())
}
