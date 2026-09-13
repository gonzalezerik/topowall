// Themes in the browser: the same model as crates/render/src/theme.rs,
// plus spacing (crates/render/src/spacing.rs) and TOML export.
//
// Theme: { name?, background: "#000000", lines: [{ every, offset?, width, opacity?, color }] }
// color: "#hex" | "oklch(...)" | [{ at: number | "40%", color }]

import { parseColor, clamp } from "./color.js";

const NICE = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

export const cloneTheme = (t) => JSON.parse(JSON.stringify(t));

/** Resolve colors to 0..1 sRGB arrays and ramp positions to metres. Throws on invalid colors. */
export function resolveTheme(theme, minM, maxM) {
  const rgba = (s) => {
    const c = parseColor(s);
    if (!c) throw new Error(`invalid color '${s}'`);
    return [c.r / 255, c.g / 255, c.b / 255, c.a];
  };
  const at = (v) => {
    if (typeof v === "number") return v;
    const m = String(v).trim().match(/^(-?[\d.]+)\s*%$/);
    if (!m) throw new Error(`ramp position '${v}' must be metres or a percentage`);
    return minM + ((maxM - minM) * parseFloat(m[1])) / 100;
  };
  return {
    background: rgba(theme.background ?? "#000000"),
    tiers: (theme.lines ?? []).map((t) => ({
      every: t.every,
      offset: t.offset ?? 0,
      width: t.width ?? 1.25,
      opacity: t.opacity ?? 1,
      stops: (Array.isArray(t.color) ? t.color.map((s) => [at(s.at), rgba(s.color)]) : [[0, rgba(t.color)]])
        .sort((a, b) => a[0] - b[0]),
    })),
  };
}

/** Set the base interval; all tiers scale together. `indexEvery` sets the second tier. */
export function setSpacing(theme, interval, indexEvery) {
  if (!(interval > 0)) throw new Error("interval must be positive");
  const lines = theme.lines ?? [];
  if (!lines.length) return theme;
  const factor = interval / lines[0].every;
  for (const t of lines) {
    t.every *= factor;
    if (t.offset) t.offset *= factor;
  }
  if (indexEvery && lines.length >= 2) {
    const ratio = (interval * indexEvery) / lines[1].every;
    for (const t of lines.slice(1)) t.every *= ratio;
  }
  return theme;
}

/** Index-line ratio of a theme (second tier / first tier), or null. */
export function indexEvery(theme) {
  const l = theme.lines ?? [];
  return l.length >= 2 ? Math.round(l[1].every / l[0].every) : null;
}

/** Same algorithm as the CLI's `--interval auto`: lines ~targetPx apart on typical terrain. */
export function autoInterval(hm, texPerPx, targetPx = 6) {
  const { width: w, height: h, data } = hm;
  if (w < 3 || h < 3) return 20;
  const step = Math.max(1, Math.floor(Math.max(w, h) / 256));
  const slopes = [];
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const dx = (data[y * w + x + 1] - data[y * w + x - 1]) * 0.5;
      const dy = (data[(y + 1) * w + x] - data[(y - 1) * w + x]) * 0.5;
      slopes.push(Math.hypot(dx, dy) * texPerPx);
    }
  }
  slopes.sort((a, b) => a - b);
  const slope = Math.max(slopes[Math.floor(slopes.length * 0.7)], 1e-3);
  const ideal = slope * targetPx;
  return NICE.reduce((best, n) => (Math.abs(Math.log(n / ideal)) < Math.abs(Math.log(best / ideal)) ? n : best));
}

const tomlString = (s) => JSON.stringify(String(s));
const tomlNumber = (n) => (Number.isInteger(n) ? `${n}` : `${+n.toFixed(4)}`);

/** Serialise a theme as TOML readable by `topowall render --theme`. */
export function themeToToml(theme) {
  const out = [];
  if (theme.name) out.push(`name = ${tomlString(theme.name)}`);
  out.push(`background = ${tomlString(theme.background ?? "#000000")}`);
  for (const t of theme.lines ?? []) {
    out.push("", "[[lines]]", `every = ${tomlNumber(t.every)}`);
    if (t.offset) out.push(`offset = ${tomlNumber(t.offset)}`);
    out.push(`width = ${tomlNumber(t.width ?? 1.25)}`);
    if (t.opacity !== undefined && t.opacity !== 1) out.push(`opacity = ${tomlNumber(clamp(t.opacity, 0, 1))}`);
    if (Array.isArray(t.color)) {
      out.push("color = [");
      for (const s of t.color) {
        const pos = typeof s.at === "number" ? tomlNumber(s.at) : tomlString(s.at);
        out.push(`  { at = ${pos}, color = ${tomlString(s.color)} },`);
      }
      out.push("]");
    } else {
      out.push(`color = ${tomlString(t.color)}`);
    }
  }
  return out.join("\n") + "\n";
}
