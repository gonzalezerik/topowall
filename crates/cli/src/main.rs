use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use std::{
    io::{IsTerminal, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use topowall_core::{atomic, fetch, topo};
use topowall_render::{
    palette::{self, BackgroundMode, GenerateOptions, Style},
    spacing, Backend, Framing, GpuOptions, Palette, Renderer, Theme,
};

mod picker;
mod terminal;

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
    /// List built-in color schemes (for --palette) with a color strip and tags.
    Palettes(PalettesArgs),
    /// Draw a palette or theme on a map in the terminal. Without a name, browse
    /// all color schemes with a live preview and pick one with Enter.
    Preview(PreviewArgs),
    /// List the GPUs (and software renderers) topowall can use, best first.
    Gpus {
        #[command(flatten)]
        gpu: GpuArgs,
    },
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

#[derive(Args, Clone)]
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

#[derive(Args, Clone)]
struct GpuArgs {
    /// Graphics API: auto, vulkan, metal, dx12 or gl.
    #[arg(long, env = "TOPOWALL_BACKEND", default_value = "auto")]
    backend: String,
    /// GPU to use: a number from `topowall gpus`, or part of its name (e.g. intel, radeon, nvidia).
    #[arg(long, env = "TOPOWALL_GPU")]
    gpu: Option<String>,
}

impl GpuArgs {
    fn options(&self) -> Result<GpuOptions> {
        Ok(GpuOptions {
            backend: Backend::parse(&self.backend)?,
            gpu: self.gpu.clone(),
        })
    }
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
    #[command(flatten)]
    gpu: GpuArgs,
    /// JPEG quality (1-100) when the output ends in .jpg/.jpeg.
    #[arg(long, default_value_t = 90, value_parser = clap::value_parser!(u8).range(1..=100))]
    quality: u8,
    #[arg(short, long)]
    output: PathBuf,
}

#[derive(Clone, Copy, ValueEnum)]
enum ColorWhen {
    Auto,
    Always,
    Never,
}

#[derive(Args)]
struct PalettesArgs {
    /// Only schemes whose name contains this text.
    search: Option<String>,
    /// Only schemes with all of these tags, e.g. dark,cool. Tags: dark, light,
    /// muted, vivid, mono, duo, multi, warm, cool, neutral, and a hue family
    /// (red, orange, yellow, green, cyan, blue, purple, pink, gray).
    #[arg(long)]
    filter: Option<String>,
    /// Color strips: auto shows them when printing to a terminal (and NO_COLOR is unset).
    #[arg(long, value_enum, default_value_t = ColorWhen::Auto)]
    color: ColorWhen,
}

#[derive(Args)]
struct PreviewArgs {
    /// Color scheme or theme: a built-in name, a file, or "random". Leave it out
    /// to browse all schemes interactively.
    name: Option<String>,
    /// Browse interactively even when a name is given (it's where the list starts).
    #[arg(short, long)]
    interactive: bool,
    #[command(flatten)]
    colors: ColorArgs,
    /// Elevation file to draw instead of the built-in sample (Yosemite Valley).
    #[arg(long)]
    input: Option<PathBuf>,
    /// Size in terminal cells; each cell shows two pixels stacked (default: 60x30).
    /// Browsing always fills the terminal.
    #[arg(long)]
    size: Option<String>,
    /// When browsing: render a wallpaper of --input with the scheme you pick.
    #[arg(short, long, requires = "input")]
    output: Option<PathBuf>,
    /// Wallpaper size for --output, e.g. 3840x2160 (default: the elevation file's size).
    #[arg(long, requires = "output")]
    wallpaper_size: Option<String>,
    #[command(flatten)]
    gpu: GpuArgs,
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

/// Replace `--palette random` with a built-in scheme, and say which one.
fn pick_random(c: &mut ColorArgs) {
    if c.palette.as_deref() == Some("random") {
        let pick = palette::random_builtin();
        eprintln!("palette: {pick} (picked at random)");
        c.palette = Some(pick.to_string());
    }
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
        return Ok((
            palette::to_theme(&palette::from_image(img, 8)?, &opts)?,
            None,
        ));
    }
    if let Some(p) = &c.palette {
        return Ok((palette::to_theme(&Palette::load(p)?, &opts)?, None));
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
        Command::Theme(mut a) => {
            pick_random(&mut a.colors);
            let (mut theme, _) = resolve_theme(&a.colors)?;
            apply_spacing(&mut theme, &a.colors, None)?;
            let text = theme.to_toml()?;
            match a.output {
                Some(p) => write_text(&p, &text)?,
                None => print!("{text}"),
            }
            Ok(())
        }
        Command::Info { input } => cmd_info(&input),
        Command::Themes => {
            Theme::builtin_names().for_each(|n| println!("{n}"));
            Ok(())
        }
        Command::Gpus { gpu } => cmd_gpus(&gpu),
        Command::Palettes(a) => cmd_palettes(&a),
        Command::Preview(a) => cmd_preview(a),
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

fn cmd_render(mut a: RenderArgs) -> Result<()> {
    pick_random(&mut a.colors);
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
        write_text(p, &theme.to_toml()?)?;
    }

    let t = Instant::now();
    let renderer = Renderer::with_options(&a.gpu.options()?)?;
    if renderer.gpu().kind == topowall_render::gpu::GpuKind::Software {
        eprintln!("note: rendering on the CPU (software), which is slower than a GPU");
    }
    let fitted = renderer.fit_heightmap(&hm);
    if let Some(f) = &fitted {
        eprintln!(
            "note: heightmap {}x{} is larger than this GPU allows ({} px); using {}x{}",
            hm.width,
            hm.height,
            renderer.max_texture_size(),
            f.width,
            f.height
        );
    }
    let pixels = renderer.render(fitted.as_ref().unwrap_or(&hm), &resolved, w, h, framing)?;
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

fn cmd_palettes(a: &PalettesArgs) -> Result<()> {
    let wanted = a
        .filter
        .as_deref()
        .map(topowall_render::tags::parse_filter)
        .transpose()?
        .unwrap_or_default();
    // Match ignoring case, dashes and spaces, so "rosepine" finds rose-pine.
    let squash = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let search = a.search.as_deref().map(squash);
    let entries: Vec<_> = topowall_render::tags::catalog()
        .iter()
        .filter(|e| wanted.iter().all(|t| e.tags.contains(t)))
        .filter(|e| {
            search
                .as_deref()
                .is_none_or(|s| squash(&e.name).contains(s) || squash(&e.title).contains(s))
        })
        .collect();
    if entries.is_empty() {
        let hint = a
            .search
            .as_deref()
            .map(|s| topowall_render::suggest::closest(s, palette::builtin_names(), 5))
            .filter(|c| !c.is_empty())
            .map(|c| format!("; did you mean: {}", c.join(", ")))
            .unwrap_or_default();
        bail!("no color schemes match{hint}");
    }
    let color = match a.color {
        ColorWhen::Always => true,
        ColorWhen::Never => false,
        ColorWhen::Auto => {
            std::io::stdout().is_terminal()
                && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
        }
    };
    let width = entries.iter().map(|e| e.name.len()).max().unwrap_or(0);
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for e in &entries {
        let strip = if color {
            let (base, _) = palette::builtin_base16(&e.name).context("built-in scheme")?;
            terminal::swatches(&base) + "  "
        } else {
            String::new()
        };
        // Stop quietly when the reader goes away (e.g. `| head`).
        if writeln!(out, "{:<width$}  {strip}{}", e.name, e.tags.join(" ")).is_err() {
            return Ok(());
        }
    }
    let _ = out.flush();
    Ok(())
}

/// Draws color schemes and themes on one map, small enough for a terminal.
struct PreviewMap {
    renderer: Renderer,
    hm: topowall_core::Heightmap,
    fitted: Option<topowall_core::Heightmap>,
    sample: bool,
}

impl PreviewMap {
    fn new(input: Option<&Path>, gpu: &GpuArgs) -> Result<Self> {
        let hm = match input {
            Some(p) => topowall_core::load(p)?,
            None => topowall_core::sample(),
        };
        let renderer = Renderer::with_options(&gpu.options()?)?;
        let fitted = renderer.fit_heightmap(&hm);
        Ok(Self {
            renderer,
            hm,
            fitted,
            sample: input.is_none(),
        })
    }

    /// Render `colors` at `cols` x `rows` cells. Returns the pixels (two rows per
    /// cell) and the theme as drawn.
    fn draw(&self, colors: &ColorArgs, cols: usize, rows: usize) -> Result<(Vec<[u8; 3]>, Theme)> {
        // Render at twice the resolution with twice the line width, then average
        // each 2x2 block, so lines keep their weight and edges stay smooth.
        const SS: u32 = 2;
        let (w, h) = (cols as u32 * SS, rows as u32 * 2 * SS);
        let hm = &self.hm;
        // A terminal has few pixels: your own map is shown whole, the sample is
        // shown at 2x around Yosemite Valley so its lines stay apart.
        let framing = match (self.sample, hm.m_per_px) {
            (true, Some(cell)) => {
                Framing::MetresPerPixel(cell * Framing::Cover.tex_per_px(hm, w, h)? / 2.0)
            }
            _ => Framing::Cover,
        };
        let (mut theme, base) = resolve_theme(colors)?;
        let tex_per_px = framing.tex_per_px(hm, w, h)?;
        if colors.interval.is_none() {
            let auto = spacing::auto_interval(hm, tex_per_px, 5.0 * SS as f64);
            theme.set_spacing(auto, colors.index_every)?;
        } else {
            apply_spacing(&mut theme, colors, Some((hm, tex_per_px)))?;
        }
        let shown = theme.clone();
        for t in &mut theme.lines {
            t.width *= SS as f64;
        }
        let (lo, hi) = hm.min_max();
        let resolved = theme.resolve(lo, hi, base.as_deref())?;
        let pixels =
            self.renderer
                .render(self.fitted.as_ref().unwrap_or(hm), &resolved, w, h, framing)?;
        Ok((
            terminal::downsample(&pixels, w as usize, h as usize, SS as usize),
            shown,
        ))
    }
}

fn cmd_preview(mut a: PreviewArgs) -> Result<()> {
    let browse = a.interactive
        || (a.name.is_none()
            && a.colors.theme.is_none()
            && a.colors.palette.is_none()
            && a.colors.palette_from_image.is_none()
            && std::io::stdin().is_terminal()
            && std::io::stderr().is_terminal());
    if browse {
        return cmd_preview_browse(a);
    }
    if a.output.is_some() {
        bail!("--output renders the scheme you pick while browsing; for a named scheme use `topowall render`");
    }
    if let Some(name) = a.name.take() {
        if a.colors.theme.is_some()
            || a.colors.palette.is_some()
            || a.colors.palette_from_image.is_some()
        {
            bail!("give the scheme either as a name or with --theme/--palette/--palette-from-image, not both");
        }
        let path = Path::new(&name);
        let is_theme = Theme::builtin_names().any(|n| n == name)
            || (path.is_file()
                && path.extension().is_some_and(|e| e == "toml")
                && std::fs::read_to_string(path).is_ok_and(|t| t.contains("[[lines]]")));
        if is_theme {
            a.colors.theme = Some(name);
        } else {
            a.colors.palette = Some(name);
        }
    }
    pick_random(&mut a.colors);
    let (cols, rows) = parse_size(a.size.as_deref().unwrap_or("60x30"))?;
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        bail!("--size is in terminal cells, e.g. 60x30");
    }
    let map = PreviewMap::new(a.input.as_deref(), &a.gpu)?;
    let (pixels, theme) = map.draw(&a.colors, cols as usize, rows as usize)?;
    let mut out = std::io::stdout().lock();
    let _ =
        out.write_all(terminal::half_blocks(&pixels, cols as usize, rows as usize * 2).as_bytes());
    let _ = out.flush();

    let name = theme.name.as_deref().unwrap_or("theme");
    let every = theme.lines.first().map(|t| t.every).unwrap_or(0.0);
    let how = match (&a.colors.theme, &a.colors.palette) {
        (Some(t), _) => format!(" --theme {t}"),
        (_, Some(p)) => format!(" --palette {p}"),
        _ => String::new(),
    };
    eprintln!(
        "{name} · lines every {every} m · {} · render it: topowall render <map.topo>{how} -o wallpaper.png",
        match &a.input {
            Some(p) => p.display().to_string(),
            None => "Yosemite Valley sample".into(),
        }
    );
    Ok(())
}

/// Color options for a scheme picked while browsing.
fn picked_colors(base: &ColorArgs, choice: &picker::Choice) -> ColorArgs {
    let mut colors = base.clone();
    colors.theme = None;
    colors.palette_from_image = None;
    colors.palette = Some(choice.palette.clone());
    colors.style = match choice.style {
        picker::Style::Subtle => StyleArg::Subtle,
        picker::Style::Vivid => StyleArg::Vivid,
        picker::Style::Mono => StyleArg::Mono,
    };
    colors.background = if choice.black_background {
        BackgroundArg::Black
    } else {
        BackgroundArg::Palette
    };
    colors
}

/// Browse every built-in color scheme with a live preview; Enter picks one.
fn cmd_preview_browse(a: PreviewArgs) -> Result<()> {
    if a.size.is_some() {
        bail!("--size is for a single preview; browsing fills the terminal");
    }
    if let Some(size) = &a.wallpaper_size {
        parse_size(size)?;
    }
    let style = match a.colors.style {
        StyleArg::Subtle => picker::Style::Subtle,
        StyleArg::Vivid => picker::Style::Vivid,
        StyleArg::Mono => picker::Style::Mono,
    };
    let black = matches!(a.colors.background, BackgroundArg::Black);
    let start = a.name.as_deref().or(a.colors.palette.as_deref());
    if let Some(name) = start {
        if palette::builtin_names().all(|n| n != name) {
            bail!("'{name}' isn't a built-in color scheme; browsing starts at one (see `topowall palettes`)");
        }
    }
    eprintln!("Starting the preview…");
    let map = PreviewMap::new(a.input.as_deref(), &a.gpu)?;
    let mut draw = |choice: &picker::Choice, cols: usize, rows: usize| -> Result<Vec<[u8; 3]>> {
        Ok(map.draw(&picked_colors(&a.colors, choice), cols, rows)?.0)
    };
    let Some(choice) = picker::run(start, style, black, &mut draw)? else {
        return Ok(());
    };

    let background = if choice.black_background {
        " --background black"
    } else {
        ""
    };
    let flags = format!(
        "--palette {} --style {}{background}",
        choice.palette,
        choice.style.name()
    );
    match a.output {
        Some(output) => {
            eprintln!(
                "Rendering {} with {flags}",
                a.input.as_ref().unwrap().display()
            );
            let colors = picked_colors(&a.colors, &choice);
            drop(map);
            cmd_render(RenderArgs {
                input: a.input.unwrap(),
                colors,
                size: a.wallpaper_size,
                scale: None,
                save_theme: None,
                gpu: a.gpu,
                quality: 90,
                output,
            })
        }
        None => {
            // The flags go to stdout, so `$(topowall preview)` can feed another command.
            println!("{flags}");
            if std::io::stdout().is_terminal() {
                eprintln!("Render it: topowall render <map.topo> {flags} -o wallpaper.png");
            }
            Ok(())
        }
    }
}

fn cmd_gpus(args: &GpuArgs) -> Result<()> {
    let opts = args.options()?;
    let gpus = topowall_render::gpu::list_gpus(opts.backend);
    if gpus.is_empty() {
        println!("No GPUs found. Install or update your graphics driver.");
    }
    for g in &gpus {
        println!("{:>2}  {}  [{}, {}]", g.index, g.name, g.kind, g.backend);
        if !g.driver.is_empty() {
            println!("    driver: {}", g.driver);
        }
    }
    match Renderer::with_options(&opts) {
        Ok(r) => println!("\ntopowall will use: {}", r.adapter_name()),
        Err(e) => println!("\nNo usable GPU: {e:#}"),
    }
    println!(
        "Choose another with --gpu <number or name> or --backend <auto|vulkan|metal|dx12|gl>."
    );
    Ok(())
}

/// Save as PNG, or JPEG when the extension is .jpg/.jpeg. The image is encoded
/// to a temporary file first, so an existing file is only replaced on success.
fn save_image(path: &Path, w: u32, h: u32, rgba: Vec<u8>, quality: u8) -> Result<()> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let jpeg = match ext.as_str() {
        "png" => false,
        "jpg" | "jpeg" => true,
        _ => bail!(
            "unsupported output '{}': use a .png, .jpg or .jpeg file name",
            path.display()
        ),
    };
    let img = image::RgbaImage::from_raw(w, h, rgba).context("pixel buffer size mismatch")?;
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    atomic::write_file(path, |out| {
        if jpeg {
            rgb.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                out, quality,
            ))?;
        } else {
            rgb.write_with_encoder(image::codecs::png::PngEncoder::new(out))?;
        }
        Ok(())
    })
}

/// Write a text file, replacing an existing one only on success.
fn write_text(path: &Path, text: &str) -> Result<()> {
    atomic::write_file(path, |out| Ok(out.write_all(text.as_bytes())?))
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
