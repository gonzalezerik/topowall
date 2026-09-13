# topowall

Topographic contour wallpapers from real elevation data, rendered on the GPU.

Pick any place on Earth, pick your screen resolution, and pick your colors:
a theme, a terminal color scheme, the dominant colors of a photo, or your own
shader. Use it from the command line or design a theme live in the browser.

![Yosemite Valley in #3f5875 / #87abc0](docs/gallery/yosemite/3f5875-87abc0.jpg)

- [Gallery](#gallery)
- [Install](#install)
- [Quick start](#quick-start)
- [CLI guide](#cli-guide)
- [Colors](#colors)
- [Line spacing](#line-spacing)
- [GUI guide](#gui-guide)
- [The .topo format](#the-topo-format)
- [Development](#development)
- [Data and attribution](#data-and-attribution)

## Gallery

The five most-visited US national parks in 2025, each in five color styles:
three popular color schemes and two hex themes. Every image was made with
`--interval auto` by [`scripts/gallery.sh`](scripts/gallery.sh).

### 1. Great Smoky Mountains — Mount Le Conte and Clingmans Dome

11.5 million visits · 24 km wide · `--center 35.610,-83.470` · auto spacing 50 m

| Solarized Dark | Rosé Pine | Catppuccin Mocha |
|---|---|---|
| ![](docs/gallery/great-smoky-mountains/solarized-dark.jpg) | ![](docs/gallery/great-smoky-mountains/rose-pine.jpg) | ![](docs/gallery/great-smoky-mountains/catppuccin-mocha.jpg) |
| **#3f5875 / #87abc0** | **#3e5d58 / #92aca0** | |
| ![](docs/gallery/great-smoky-mountains/3f5875-87abc0.jpg) | ![](docs/gallery/great-smoky-mountains/3e5d58-92aca0.jpg) | |

### 2. Zion — Zion Canyon and Angels Landing

5.0 million visits · 14 km wide · `--center 37.255,-112.955` · auto spacing 50 m

| Solarized Dark | Rosé Pine | Catppuccin Mocha |
|---|---|---|
| ![](docs/gallery/zion/solarized-dark.jpg) | ![](docs/gallery/zion/rose-pine.jpg) | ![](docs/gallery/zion/catppuccin-mocha.jpg) |
| **#3f5875 / #87abc0** | **#3e5d58 / #92aca0** | |
| ![](docs/gallery/zion/3f5875-87abc0.jpg) | ![](docs/gallery/zion/3e5d58-92aca0.jpg) | |

### 3. Yellowstone — Grand Canyon of the Yellowstone and Mount Washburn

4.8 million visits · 24 km wide · `--center 44.750,-110.470` · auto spacing 25 m

| Solarized Dark | Rosé Pine | Catppuccin Mocha |
|---|---|---|
| ![](docs/gallery/yellowstone/solarized-dark.jpg) | ![](docs/gallery/yellowstone/rose-pine.jpg) | ![](docs/gallery/yellowstone/catppuccin-mocha.jpg) |
| **#3f5875 / #87abc0** | **#3e5d58 / #92aca0** | |
| ![](docs/gallery/yellowstone/3f5875-87abc0.jpg) | ![](docs/gallery/yellowstone/3e5d58-92aca0.jpg) | |

### 4. Grand Canyon — the inner canyon and the Colorado River

4.4 million visits · 24 km wide · `--center 36.120,-112.080` · auto spacing 100 m

| Solarized Dark | Rosé Pine | Catppuccin Mocha |
|---|---|---|
| ![](docs/gallery/grand-canyon/solarized-dark.jpg) | ![](docs/gallery/grand-canyon/rose-pine.jpg) | ![](docs/gallery/grand-canyon/catppuccin-mocha.jpg) |
| **#3f5875 / #87abc0** | **#3e5d58 / #92aca0** | |
| ![](docs/gallery/grand-canyon/3f5875-87abc0.jpg) | ![](docs/gallery/grand-canyon/3e5d58-92aca0.jpg) | |

### 5. Yosemite — Yosemite Valley, El Capitan to Half Dome

4.3 million visits · 18 km wide · `--center 37.738,-119.575` · auto spacing 50 m

| Solarized Dark | Rosé Pine | Catppuccin Mocha |
|---|---|---|
| ![](docs/gallery/yosemite/solarized-dark.jpg) | ![](docs/gallery/yosemite/rose-pine.jpg) | ![](docs/gallery/yosemite/catppuccin-mocha.jpg) |
| **#3f5875 / #87abc0** | **#3e5d58 / #92aca0** | |
| ![](docs/gallery/yosemite/3f5875-87abc0.jpg) | ![](docs/gallery/yosemite/3e5d58-92aca0.jpg) | |

Visitation figures are 2025 recreation visits from the
[National Park Service visitor use statistics](https://irma.nps.gov/Stats/).

## Install

**Nix**

```sh
nix run github:gonzalezerik/topowall -- --help
nix profile install github:gonzalezerik/topowall
```

**From source** — needs Rust 1.88+ and a GPU driver with Vulkan, Metal, DX12 or
OpenGL:

```sh
git clone https://github.com/gonzalezerik/topowall
cd topowall
cargo install --path crates/cli
```

## Quick start

```sh
# 1. Download elevation for an area: its centre, width in km, and your screen size
topowall fetch --center 37.738,-119.575 --width-km 18 --size 2880x1800 -o yosemite.topo

# 2. Render a wallpaper
topowall render yosemite.topo --palette rose-pine -o wallpaper.png
```

Set `wallpaper.png` as your wallpaper however your desktop does it.

## CLI guide

```
topowall fetch     Download elevation for an area into a .topo heightmap
topowall render    Render contours to PNG or JPEG
topowall theme     Write a theme file from a palette or image
topowall info      Show details about an elevation file
topowall themes    List built-in themes
topowall palettes  List built-in color schemes
```

Every command has `--help`.

### `topowall fetch`

Downloads elevation for a rectangle centred on a point and saves it as a
[`.topo`](#the-topo-format) heightmap.

| Option | Meaning |
|---|---|
| `--center LAT,LON` | Centre of the area in decimal degrees, e.g. `37.738,-119.575` (west and south are negative). |
| `--width-km KM` | Width of the area. The height follows from `--size`'s aspect ratio. |
| `--size WxH` | Heightmap size in pixels. Use your screen resolution. |
| `--smooth-m M` | Smoothing in metres (default `18.75`). Higher values give calmer, flowing lines; use roughly 2–3× the metres per pixel. |
| `--zoom Z` | Tile zoom level (default: matched to the resolution). |
| `--max-tiles N` | Refuse areas that need more tiles than this (default `1500`). |
| `-o FILE` | Output `.topo` file. |

**Choosing the area.** Metres per pixel is `width-km × 1000 ÷ width`. Around
5–15 m per pixel gives detailed wallpapers. For a bigger screen, raise both
`--size` and `--width-km` to show more land at the same sharpness rather than
stretching a smaller map:

```sh
topowall fetch --center 37.738,-119.575 --width-km 18   --size 2880x1800 -o laptop.topo   # 6.25 m/px
topowall fetch --center 37.738,-119.575 --width-km 38.4 --size 5120x2160 -o desktop.topo  # 7.5 m/px
```

Find coordinates by right-clicking a spot in most online maps.

### `topowall render`

```sh
topowall render INPUT [color options] [--size WxH] [--scale M] [--interval M|auto] -o OUTPUT
```

`INPUT` can be a `.topo` file, a GeoTIFF (including Cloud Optimized GeoTIFFs
such as Copernicus GLO-30 or USGS 3DEP), an SRTM `.hgt` tile, or a
Terrarium-encoded PNG tile.

| Option | Meaning |
|---|---|
| `--theme NAME\|FILE` | A built-in theme or a theme file. Default: `graphite`. |
| `--palette NAME\|FILE` | Generate colors from a color scheme ([Palettes](#palettes)). |
| `--palette-from-image IMAGE` | Generate colors from an image ([Images](#images)). |
| `--style subtle\|vivid\|mono` | How a palette becomes line colors (default `subtle`). |
| `--accent COLOR` | Which palette color the lines use: `auto`, `blue`, `cyan`, `green`, `red`, `magenta`, `yellow`, `orange`, `0`–`15`, or any color. |
| `--background palette\|black` | Keep the palette's background or use black. |
| `--interval M\|auto` | Metres between lines ([Line spacing](#line-spacing)). |
| `--index-every N` | Every Nth line is an index line. |
| `--size WxH` | Output size (default: the heightmap's size). |
| `--scale M` | Fixed metres per output pixel instead of filling the output. |
| `--save-theme FILE` | Also write the theme that was used. |
| `--quality Q` | JPEG quality 1–100 (default `90`). |
| `-o FILE` | `.png`, `.jpg` or `.jpeg`. |

When the heightmap and output have different aspect ratios, the map is scaled
to cover the output and centred.

### `topowall theme`

Takes the same color and spacing options as `render` but writes a theme file
instead of an image, so you can start from a palette and fine-tune by hand:

```sh
topowall theme --palette nord --style vivid --interval 25 -o nord.toml
```

### `topowall info`

```
$ topowall info yosemite.topo
size       2880 x 1800
elevation  1173.1 .. 3013.1 m
resolution 6.25 m/px (18.00 x 11.25 km)
extent     W -119.67723  S 37.68713  E -119.47277  N 37.78887
source     AWS Terrain Tiles (terrarium) z14
```

## Colors

There are four ways to color a map, from quickest to most control.

### Palettes

339 color schemes are built in (`topowall palettes`), including Solarized,
Rosé Pine, Catppuccin, Gruvbox, Nord, Dracula, Tokyo Night, Everforest and
Kanagawa:

```sh
topowall render yosemite.topo --palette catppuccin-mocha -o out.png
```

You can also point to your terminal's config, and topowall reads its colors:

| Source | Example |
|---|---|
| pywal | `--palette ~/.cache/wal/colors.json` |
| Alacritty | `--palette ~/.config/alacritty/alacritty.toml` |
| Kitty | `--palette ~/.config/kitty/theme.conf` |
| foot | `--palette ~/.config/foot/foot.ini` |
| Ghostty | `--palette ~/.config/ghostty/config` |
| Xresources | `--palette ~/.Xresources` |
| iTerm2 | `--palette Theme.itermcolors` |
| Windows Terminal | `--palette settings.json` |
| base16 / tinted-theming | `--palette scheme.yaml` |

The file needs a background color or ANSI colors. Configs that use the
terminal's default colors have nothing to read.

How palette colors are used:

- **`--style subtle`** (default) keeps the accent's hue but lowers its
  saturation, and sets the lines' lightness relative to the background. The
  result is calm and easy to live with.
- **`--style vivid`** uses the accent color as-is for index lines.
- **`--style mono`** uses the foreground color only.
- **`--accent`** picks the hue. `auto` prefers blue, then cyan, green, magenta,
  yellow and red, skipping colors that are too gray.

### Images

Pull colors from a photo:

```sh
topowall render yosemite.topo --palette-from-image sunset.jpg -o out.png
```

topowall groups the image's pixels into 8 dominant colors (k-means in OKLab).
The darkest becomes the background and the most colorful, common colors become
accents. `--style`, `--accent` and `--background` work the same as with
palettes.

### Themes

A theme is a small TOML file. Built in: `graphite`, `3e5d58-92aca0`,
`3f5875-87abc0`, `hypsometric` ([`themes/`](themes)).

```toml
name = "My theme"
background = "#000000"

[[lines]]              # a tier of contour lines
every = 20             # metres between lines
color = "#3e5d58"      # #rgb, #rrggbb, #rrggbbaa or oklch(L C H)
width = 1.25           # pixels
opacity = 1.0          # optional
offset = 0             # optional: shift lines by this many metres

[[lines]]              # later tiers draw on top of earlier ones
every = 100
width = 1.8
color = [              # a ramp: color changes with elevation
  { at = "0%",   color = "oklch(0.65 0.08 190)" },   # % of the map's elevation range
  { at = 2500,   color = "#92aca0" },                # or metres
  { at = "100%", color = "oklch(0.88 0.07 80)" },
]
```

Colors are sRGB. `oklch()` is handy for adjusting lightness (`L`, 0–1) and
color strength (`C`, about 0–0.37) without changing the hue (`H`, degrees).

### Custom shaders

For complete control, a theme can replace the shading function with WGSL:

```toml
shader = "slope-glow.wgsl"   # relative to the theme file
```

```wgsl
fn shade(s: ShadeInput) -> vec4<f32> {
    // s.elevation  metres
    // s.slope      metres of elevation change per output pixel
    // s.px, s.uv   output pixel position, and position from 0 to 1
    // s.elev_min, s.elev_max
    // Helpers: contour_coverage(h, slope, interval, width), tier_color(i, h),
    // params.background, tiers (from the theme's [[lines]])
    ...
}
```

[`examples/slope-glow.wgsl`](examples/slope-glow.wgsl) adds a glow on steep
terrain. The full shader is
[`crates/render/src/shaders/contour.wgsl`](crates/render/src/shaders/contour.wgsl).
Shader errors are reported with the line and column.

## Line spacing

Spacing is adjustable everywhere:

| Where | How |
|---|---|
| CLI | `--interval 50` sets metres between lines; every tier scales together, so index lines keep their ratio. `--index-every 4` makes every 4th line an index line. |
| CLI | `--interval auto` picks a round interval so lines on typical terrain sit about 6 pixels apart at your output size. |
| Theme files | `every = …` on each `[[lines]]` tier. |
| GUI | The **Spacing** slider, number field and **Auto** button, plus the index-line stepper. |

Steep terrain or small images need wider spacing; otherwise lines merge into
solid bands. `auto` handles this for you: in the gallery it chose 25 m for
Yellowstone's plateau and 100 m for the Grand Canyon.

## GUI guide

The GUI lives in [`web/`](web). It's plain HTML and JavaScript with no build
step and no dependencies. Serve the repository with any static file server:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/web/studio/
```

(Browsers won't load the page's modules from `file://`, so it needs a server.)

### Studio

![topowall studio](docs/studio.jpg)

The studio renders the contour shader live in your browser (WebGL2). It's a
port of the CLI's shader, and its output matches `topowall render` to within
1/255 per channel.

- **Preset:** start from a built-in theme or a palette (subtle or vivid).
- **Output:** choose the resolution you'll render at. "This screen" uses your
  display's native size. The preview keeps that aspect ratio and scales line
  widths to match, so it looks like the final image shrunk to fit.
  **Actual pixels** shows it 1:1.
- **Spacing:** drag the slider (1–1000 m, logarithmic), type an exact value, or
  press **Auto**. The stepper sets how many lines make an index line.
- **Colors:** background, each tier's color (or each color stop of a ramp),
  width and opacity.
- **Open .topo:** open or drag in any heightmap made with `topowall fetch`. A
  Yosemite sample is loaded at start.
- **Export:** copy or download the theme as TOML, and copy the matching
  `topowall fetch` / `topowall render` commands.

Your last theme and output size are remembered in the browser.

### Color picker

Every color control uses topowall's color picker:

<img src="docs/color-picker.jpg" width="290" alt="topowall color picker">

- Drag the **hue ring**, and drag inside the **square** for saturation and
  brightness.
- Type a **hex code** (`#3e5d58`, `3e5d58`, `#fff` or `#3e5d5880`) or an
  **OKLCH** value, and both markers jump to that color's exact position.
- Edit **H/S/B**, **R/G/B** or **A** directly. Up/Down arrows nudge a value,
  and Shift+arrow nudges it by more.
- The **preview square** shows the new color on top and the previous color
  below. Click the previous color to go back.
- With keyboard focus on the wheel, arrows move the markers.
- Use the **eyedropper** to pick from the screen (Chromium-based browsers).
- Recently used colors are kept as swatches.
- **Enter** or **Apply** keeps the color; **Esc**, **Cancel** or clicking
  outside restores the previous one.

The picker is a standalone web component you can use in other pages:

```html
<script type="module" src="web/src/color-picker.js"></script>

<topo-color-input value="#3e5d58" alpha></topo-color-input>   <!-- swatch that opens a popover -->
<topo-color-picker value="#87abc0"></topo-color-picker>        <!-- the panel on its own -->

<script type="module">
  const input = document.querySelector("topo-color-input");
  input.addEventListener("input", (e) => console.log(e.detail.hex));  // live, while dragging
  input.addEventListener("change", (e) => console.log(e.detail.hex)); // committed
</script>
```

Attributes: `value`, `alpha` (show opacity), `theme="light|dark"`, and
`actions` (Apply/Cancel buttons; on by default in the popover). The picker
follows the system light/dark setting. A demo is in
[`web/demo/color-picker.html`](web/demo/color-picker.html).

### Coming next

Browse the whole world on a fluid map, frame an area at your output
resolution (the frame shows how much can be covered at full quality), preview
your colors live, and export without touching the CLI.

## The `.topo` format

A `.topo` file is a 16-bit grayscale PNG (row 0 = north) with an iTXt chunk
named `topowall` holding JSON:

```json
{ "version": 1, "min_m": 1173.13, "range_m": 1839.97, "m_per_px": 6.25,
  "extent": { "west": -119.677, "south": 37.687, "east": -119.473, "north": 37.789 },
  "source": "AWS Terrain Tiles (terrarium) z14" }
```

Elevation in metres = `min_m + value / 65535 × range_m`. Any image viewer can
open the file as a grayscale height image.

## Development

```sh
nix develop                 # or install Rust 1.88+
cargo test --workspace      # Rust tests
cargo clippy --workspace -- -D warnings
node --test web/test/*.test.js   # web color math tests

# Browser tests: serve the repo, then open these pages (the title says PASS/FAIL)
python3 -m http.server 8000
#   http://localhost:8000/web/test/picker.test.html
#   http://localhost:8000/web/test/parity.test.html   (renders for comparison with the CLI)

cargo build --release
scripts/gallery.sh          # regenerate docs/gallery
scripts/web-presets.sh      # regenerate web/studio/presets.json
```

Layout:

```
crates/core      elevation readers, tile fetching, resampling, .topo format
crates/render    wgpu renderer, WGSL shader, themes, palettes, spacing
crates/cli       the topowall command
web/src          color math, color picker, .topo reader, WebGL renderer, theme model
web/studio       the studio app
themes/          built-in themes
```

## Data and attribution

`topowall fetch` uses [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/),
which combine public elevation datasets including USGS 3DEP, SRTM, GMTED2010
and ETOPO1. If you publish images made from this data, follow the
[attribution guidance](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
Resolution varies by region: about 10 m in the United States and roughly
30–90 m elsewhere. Downloaded tiles are cached in
`~/.cache/topowall/`.

Built-in color schemes come from
[tinted-theming/schemes](https://github.com/tinted-theming/schemes) (MIT); see
[`crates/render/palettes`](crates/render/palettes).

## License

[MIT](LICENSE) © Erik Gonzalez
