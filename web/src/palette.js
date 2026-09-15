// Color schemes → contour themes in the browser. A port of
// crates/kit/src/palette.rs (base16 → ANSI, accent choice) and
// crates/render/src/palette.rs (`to_theme`), computed in 32-bit floats with the
// same constants so every scheme gives the same colors as `topowall theme`.

const f = Math.fround;

const toLinear = (c) => (c <= f(0.04045) ? f(c / f(12.92)) : f(f((c + f(0.055)) / f(1.055)) ** f(2.4)));
const toSrgb = (c) => {
  c = Math.min(1, Math.max(0, c));
  return c <= f(0.0031308) ? f(f(12.92) * c) : f(f(1.055) * f(c ** f(1 / 2.4)) - f(0.055));
};

/** sRGB color with components in 0..1 (32-bit floats). */
const rgb = (r, g, b) => ({ r: f(r), g: f(g), b: f(b) });

function parseHex(hex) {
  const h = hex.replace(/^#/, "");
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

export function toHex({ r, g, b }) {
  const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${q(r)}${q(g)}${q(b)}`;
}

function toOklab({ r, g, b }) {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = f(Math.cbrt(f(f(f(0.41222146) * lr) + f(f(0.53633255) * lg)) + f(f(0.051445995) * lb)));
  const m = f(Math.cbrt(f(f(f(0.2119035) * lr) + f(f(0.6806995) * lg)) + f(f(0.10739696) * lb)));
  const s = f(Math.cbrt(f(f(f(0.08830246) * lr) + f(f(0.28171885) * lg)) + f(f(0.6299787) * lb)));
  return [
    f(f(f(f(0.21045426) * l) + f(f(0.7936178) * m)) - f(f(0.004072047) * s)),
    f(f(f(f(1.9779985) * l) - f(f(2.4285922) * m)) + f(f(0.4505937) * s)),
    f(f(f(f(0.025904037) * l) + f(f(0.78277177) * m)) - f(f(0.80867577) * s)),
  ];
}

const cube = (v) => f(f(v * v) * v);

function lmsCubed(ll, a, b) {
  return [
    cube(f(f(ll + f(f(0.39633778) * a)) + f(f(0.21580376) * b))),
    cube(f(f(ll - f(f(0.105561346) * a)) - f(f(0.06385417) * b))),
    cube(f(f(ll - f(f(0.08948418) * a)) - f(f(1.2914855) * b))),
  ];
}

function linearRgb([l, m, s]) {
  return [
    f(f(f(f(4.0767417) * l) - f(f(3.3077116) * m)) + f(f(0.23096994) * s)),
    f(f(f(f(-1.268438) * l) + f(f(2.6097574) * m)) - f(f(0.34131938) * s)),
    f(f(f(f(-0.0041960863) * l) - f(f(0.7034186) * m)) + f(f(1.7076147) * s)),
  ];
}

function fromOklab([ll, a, b]) {
  const [r, g, bl] = linearRgb(lmsCubed(ll, a, b));
  return rgb(toSrgb(r), toSrgb(g), toSrgb(bl));
}

export function toOklch(c) {
  const [l, a, b] = toOklab(c);
  let h = f((Math.atan2(b, a) * 180) / Math.PI);
  h = f(((h % 360) + 360) % 360);
  return { l, c: f(Math.hypot(a, b)), h };
}

/** OKLCH → sRGB, reducing chroma until the color fits (same loop as the renderer). */
export function oklchToColor({ l, c, h }) {
  const rad = f((h * Math.PI) / 180);
  const [cos, sin] = [f(Math.cos(rad)), f(Math.sin(rad))];
  let chroma = f(c);
  for (let i = 0; i < 24; i++) {
    const lin = linearRgb(lmsCubed(f(l), f(chroma * cos), f(chroma * sin)));
    if (lin.every((v) => v >= f(-1e-4) && v <= f(1.0001))) break;
    chroma = f(chroma * f(0.9));
  }
  return fromOklab([f(l), f(chroma * cos), f(chroma * sin)]);
}

/** Perceptual mix in OKLab (t = 0 → a, 1 → b). */
function mix(a, b, t) {
  const [x, y] = [toOklab(a), toOklab(b)];
  return fromOklab(x.map((v, i) => f(v + f(f(y[i] - v) * f(t)))));
}

// ── Schemes ─────────────────────────────────────────────────────────────────

/**
 * A terminal-style palette from a base16 scheme (sixteen hex colors).
 * @param {{title?:string,name?:string,colors:string[]}} scheme
 */
export function fromBase16(scheme) {
  const b = scheme.colors.map(parseHex);
  // Standard base16 → ANSI mapping.
  const order = [0x0, 0x8, 0xb, 0xa, 0xd, 0xe, 0xc, 0x5, 0x3, 0x8, 0xb, 0xa, 0xd, 0xe, 0xc, 0x7];
  return { name: scheme.title ?? scheme.name, background: b[0], foreground: b[5], ansi: order.map((i) => b[i]) };
}

/** The accent for "auto" or an ANSI color name. */
export function accent(p, choice = "auto") {
  const named = (i) => p.ansi[i] ?? p.ansi[i + 8];
  const byName = { red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, purple: 5, cyan: 6 };
  let pick;
  if (choice === "auto") {
    const cands = [4, 6, 2, 5, 3, 1].map(named).filter(Boolean);
    pick = cands.find((c) => toOklch(c).c > f(0.04)) ?? cands[0];
  } else if (choice in byName) {
    pick = named(byName[choice]);
  } else {
    throw new Error(`unknown accent '${choice}'`);
  }
  return pick ?? p.foreground;
}

export const STYLES = ["subtle", "vivid", "mono"];

/**
 * Turn a palette into a theme, like `topowall theme --palette … --style …`.
 * @param {ReturnType<typeof fromBase16>} p
 * @param {{style?:"subtle"|"vivid"|"mono", background?:"palette"|"black", accent?:string, interval?:number, indexEvery?:number}} opts
 */
export function toTheme(p, { style = "subtle", background = "palette", accent: accentChoice = "auto", interval = 20, indexEvery = 5 } = {}) {
  const palBg = p.background ?? p.ansi[0] ?? rgb(0, 0, 0);
  const bg = background === "black" ? rgb(0, 0, 0) : palBg;
  const fg = p.foreground ?? p.ansi[7] ?? rgb(0xd0 / 255, 0xd0 / 255, 0xd0 / 255);
  const acc = accent(p, accentChoice);

  const bgL = toOklch(bg).l;
  const dark = bgL < 0.5;
  const toward = (amount) => (dark ? f(bgL + f(f(1 - bgL) * f(amount))) : f(bgL * f(1 - f(amount))));

  let minor, major;
  if (style === "subtle") {
    const a = toOklch(acc);
    minor = oklchToColor({ l: toward(0.4), c: Math.min(a.c, f(0.055)), h: a.h });
    major = oklchToColor({ l: toward(0.7), c: Math.min(a.c, f(0.05)), h: a.h });
  } else if (style === "vivid") {
    const a = toOklch(acc);
    const l = Math.max(Math.min(toward(0.45), a.l), dark ? f(bgL + f(0.2)) : 0);
    minor = oklchToColor({ l, c: f(a.c * f(0.85)), h: a.h });
    major = acc;
  } else if (style === "mono") {
    minor = mix(bg, fg, 0.35);
    major = mix(bg, fg, 0.75);
  } else {
    throw new Error(`unknown style '${style}'`);
  }
  return {
    name: `${p.name ?? "palette"} (${style})`,
    background: toHex(bg),
    lines: [
      { every: interval, width: 1.25, color: toHex(minor) },
      { every: interval * indexEvery, width: 1.8, color: toHex(major) },
    ],
  };
}
