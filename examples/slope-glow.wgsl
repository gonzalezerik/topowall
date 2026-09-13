// Example custom shading: the theme's lines, plus a faint glow on steep terrain.
// Everything from contour.wgsl is available: params, tiers, tier_color,
// contour_coverage, and ShadeInput (elevation, slope, px, uv, elev_min, elev_max).
fn shade(s: ShadeInput) -> vec4<f32> {
    var col = params.background;
    let steep = smoothstep(0.5, 4.0, s.slope);           // metres per pixel
    col = vec4<f32>(col.rgb + vec3<f32>(0.02, 0.05, 0.06) * steep, col.a);
    for (var i = 0u; i < arrayLength(&tiers); i++) {
        let t = tiers[i];
        let cov = contour_coverage(s.elevation - t.a.y, s.slope, t.a.x, t.a.z) * t.a.w;
        let c = tier_color(i, s.elevation);
        col = vec4<f32>(mix(col.rgb, c.rgb, cov * c.a), col.a);
    }
    return col;
}
