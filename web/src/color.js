// Color math for the topowall web UI. Mirrors crates/render/src/color.rs so
// colors picked in the browser mean exactly the same thing to the renderer.
//
// RGBA objects: { r, g, b } in 0..255 (floats allowed), a in 0..1.
// HSV objects:  { h } degrees 0..360, { s, v } in 0..1.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── Hex ─────────────────────────────────────────────────────────────────────

/** Parse #rgb, #rgba, #rrggbb or #rrggbbaa (the # is optional). Returns null if invalid. */
export function hexToRgba(input) {
  const hex = String(input).trim().replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  let r, g, b, a = 255;
  if (hex.length === 3 || hex.length === 4) {
    [r, g, b] = [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16));
    if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 6 || hex.length === 8) {
    [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16);
  } else {
    return null;
  }
  return { r, g, b, a: a / 255 };
}

const byteHex = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");

/** Format as #rrggbb, or #rrggbbaa when alpha < 1. */
export function rgbaToHex({ r, g, b, a = 1 }) {
  const alpha = Math.round(clamp(a, 0, 1) * 255);
  return "#" + byteHex(r) + byteHex(g) + byteHex(b) + (alpha < 255 ? byteHex(alpha) : "");
}

// ── HSV ─────────────────────────────────────────────────────────────────────

/** RGB → HSV. Hue is NaN for grays and saturation is NaN for black, so callers can keep their previous values. */
export function rgbToHsv({ r, g, b }) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = NaN;
  if (d > 1e-9) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const s = max > 1e-9 ? d / max : NaN;
  return { h, s, v: max };
}

export function hsvToRgb({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 };
}

// ── OKLab / OKLCH ───────────────────────────────────────────────────────────

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function linearFromOklab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function rgbToOklch({ r, g, b }) {
  const [lr, lg, lb] = [r, g, b].map((c) => toLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/** OKLCH → RGB, reducing chroma until the color fits sRGB (same as the renderer). */
export function oklchToRgb({ l, c, h }) {
  const rad = (h * Math.PI) / 180;
  let chroma = c;
  let lin;
  for (let i = 0; i < 24; i++) {
    lin = linearFromOklab(l, chroma * Math.cos(rad), chroma * Math.sin(rad));
    if (lin.every((v) => v >= -1e-4 && v <= 1.0001)) break;
    chroma *= 0.9;
  }
  const [r, g, b] = lin.map((v) => toSrgb(clamp(v, 0, 1)) * 255);
  return { r, g, b };
}

export function formatOklch({ l, c, h }) {
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
}

// ── Parsing any supported string ────────────────────────────────────────────

/** Parse hex, oklch(L C H [/ A]) or rgb()/rgba(). Returns RGBA or null. */
export function parseColor(input) {
  const s = String(input).trim().toLowerCase();
  const fn = s.match(/^(oklch|rgba?)\((.*)\)$/);
  if (!fn) return hexToRgba(s);
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  const num = (p, scale = 1) => (p.endsWith("%") ? (parseFloat(p) / 100) * scale : parseFloat(p));
  if (parts.length < 3 || parts.slice(0, 3).some((p) => Number.isNaN(parseFloat(p)))) return null;
  const alpha = parts[3] !== undefined ? clamp(num(parts[3]), 0, 1) : 1;
  if (fn[1] === "oklch") {
    const rgb = oklchToRgb({ l: num(parts[0]), c: num(parts[1], 0.4), h: parseFloat(parts[2]) });
    return { ...rgb, a: alpha };
  }
  const [r, g, b] = parts.slice(0, 3).map((p) => clamp(num(p, 255), 0, 255));
  return { r, g, b, a: alpha };
}
