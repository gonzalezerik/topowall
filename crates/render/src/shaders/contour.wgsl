// topowall contour shader.
//
// The heightmap is an r32float texture of elevations in metres (row 0 = north).
// Each output pixel samples it with Catmull-Rom interpolation, measures the
// local slope in metres per output pixel, and draws anti-aliased lines at
// every tier's interval. Colors and line settings come from the theme as
// storage buffers, so changing a theme never recompiles the shader.

struct Params {
    size_origin: vec4<f32>,   // output width, output height, tile x, tile y (px)
    map: vec4<f32>,           // map centre x, y (texels), texels per output px, 0
    background: vec4<f32>,    // sRGB-encoded RGBA
    elev_range: vec4<f32>,    // heightmap min, max (metres), 0, 0
}

struct Tier {
    a: vec4<f32>,             // every (m), offset (m), width (px), opacity
    b: vec4<f32>,             // first stop index, stop count, 0, 0
}

struct Stop {
    color: vec4<f32>,         // sRGB-encoded RGBA
    elev: vec4<f32>,          // elevation (m), 0, 0, 0
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var dem: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> tiers: array<Tier>;
@group(0) @binding(3) var<storage, read> stops: array<Stop>;

// Everything a shading function can use.
struct ShadeInput {
    elevation: f32,           // metres
    slope: f32,               // metres of elevation change per output pixel
    px: vec2<f32>,            // output pixel position (0,0 = top-left)
    uv: vec2<f32>,            // px / output size
    elev_min: f32,
    elev_max: f32,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);
}

fn texel(p: vec2<i32>) -> f32 {
    let size = vec2<i32>(textureDimensions(dem));
    return textureLoad(dem, clamp(p, vec2<i32>(0), size - 1), 0).r;
}

fn cubic_weights(t: f32) -> vec4<f32> {
    let t2 = t * t;
    let t3 = t2 * t;
    return vec4<f32>(
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    );
}

// Catmull-Rom elevation at texel coordinate g (texel centres at integer + 0.5).
fn elevation(g_in: vec2<f32>) -> f32 {
    let g = g_in - 0.5;
    let i = floor(g);
    let wx = cubic_weights(g.x - i.x);
    let wy = cubic_weights(g.y - i.y);
    let b = vec2<i32>(i) - 1;
    var h = 0.0;
    for (var y = 0; y < 4; y++) {
        var row = 0.0;
        for (var x = 0; x < 4; x++) {
            row += wx[x] * texel(b + vec2<i32>(x, y));
        }
        h += wy[y] * row;
    }
    return h;
}

// Coverage (0..1) of the nearest contour line at `interval` metres.
fn contour_coverage(h: f32, slope: f32, interval: f32, width_px: f32) -> f32 {
    let spacing_px = interval / max(slope, 1e-4);          // px between neighbouring lines
    let dist_px = abs(fract(h / interval + 0.5) - 0.5) * spacing_px;
    let line = clamp(0.5 * width_px + 0.5 - dist_px, 0.0, 1.0);
    let average = min(1.0, width_px / spacing_px);          // lines packed tighter than pixels
    return mix(line, average, smoothstep(3.0, 1.2, spacing_px));
}

// Color of tier `i` at elevation `h` (ramps interpolate between stops).
fn tier_color(i: u32, h: f32) -> vec4<f32> {
    let first = u32(tiers[i].b.x);
    let count = u32(tiers[i].b.y);
    if (count <= 1u || h <= stops[first].elev.x) {
        return stops[first].color;
    }
    for (var s = first + 1u; s < first + count; s++) {
        if (h <= stops[s].elev.x) {
            let e0 = stops[s - 1u].elev.x;
            let e1 = stops[s].elev.x;
            let t = (h - e0) / max(e1 - e0, 1e-3);
            return mix(stops[s - 1u].color, stops[s].color, t);
        }
    }
    return stops[first + count - 1u].color;
}

//@shade-begin
fn shade(s: ShadeInput) -> vec4<f32> {
    var col = params.background;
    for (var i = 0u; i < arrayLength(&tiers); i++) {
        let t = tiers[i];
        let cov = contour_coverage(s.elevation - t.a.y, s.slope, t.a.x, t.a.z) * t.a.w;
        let c = tier_color(i, s.elevation);
        col = vec4<f32>(mix(col.rgb, c.rgb, cov * c.a), col.a);
    }
    return col;
}
//@shade-end

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let out_size = params.size_origin.xy;
    let px = pos.xy + params.size_origin.zw;
    let tex_per_px = params.map.z;
    let g = params.map.xy + (px - 0.5 * out_size) * tex_per_px;

    let h = elevation(g);
    let hx = elevation(g + vec2<f32>(tex_per_px, 0.0));
    let hy = elevation(g + vec2<f32>(0.0, tex_per_px));

    var s: ShadeInput;
    s.elevation = h;
    s.slope = length(vec2<f32>(hx - h, hy - h));
    s.px = px;
    s.uv = px / out_size;
    s.elev_min = params.elev_range.x;
    s.elev_max = params.elev_range.y;
    return shade(s);
}
