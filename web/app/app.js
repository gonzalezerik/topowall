// topowall in the browser: a live contour map of anywhere on Earth.
//
// Everything runs on the visitor's device. The browser downloads elevation
// tiles from the chosen elevation source and sends place searches to the
// chosen search service; nothing goes anywhere else.

import "../src/color-picker.js";
import { parseTopo } from "../src/topo.js";
import { ContourRenderer } from "../src/renderer-webgl.js";
import { autoInterval, cloneTheme, indexEvery, resolveTheme, setSpacing, themeToToml } from "../src/theme.js";
import { fromBase16, toTheme } from "../src/palette.js";
import { ELEVATION_SOURCES, ENCODINGS, TerrainBuilder, TileCache, loadMosaic, lonLatOf, mercatorPx, plan } from "../src/terrain.js";
import { SEARCH_SOURCES, parseCoordinates, searchPlaces } from "../src/geocode.js";
import { cleanEntry, exportThemes, importThemes, loadThemes, newId, saveThemes } from "../src/library.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "topowall.app";
const DEFAULT_VIEW = { lat: 37.738, lon: -119.575, km: 18 };
const DEFAULT_SMOOTH = 18.75;
const MARGIN = 1.4;              // the heightmap covers this much more than the screen, so small moves need no rebuild
const MAX_CANVAS_PX = 6_000_000; // device pixels drawn live
const MIN_MPP = 0.5, MAX_MPP = 40_000;
const TAG_GROUPS = [
  ["dark", "light"],
  ["muted", "vivid"],
  ["mono", "duo", "multi"],
  ["warm", "cool", "neutral"],
  ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"],
];

const state = {
  view: null,                 // { lat, lon, mpp } — mpp: metres per device pixel at the centre
  scheme: { kind: "palette", name: "rose-pine" },  // kind: "palette" (built-in scheme) or "mine" (saved in this browser)
  style: "subtle",
  background: "palette",
  custom: null,               // a full theme once the visitor edits a built-in scheme's colors
  swatchTarget: "lines",      // what clicking a swatch colors: background, lines or index
  auto: true,
  interval: 20,
  indexEvery: 5,
  smoothM: DEFAULT_SMOOTH,
  output: { choice: "screen", w: 2880, h: 1800 },
  showFrame: true,
  elevation: { id: ELEVATION_SOURCES[0].id },
  search: { id: SEARCH_SOURCES[0].id },
};

let palettes = [];   // catalog entries: { name, title, tags, colors }
let myThemes = [];   // themes made in this browser (see src/library.js)
let renderer, builder, canvas;
const tiles = new TileCache(400);
let built = null;    // { plan, hm, summary, W, H }
let file = null;     // { hm, name } when a .topo file is open

// ── Small helpers ───────────────────────────────────────────────────────────

let toastTimer;
/** Show a short message. Errors stay until dismissed so there's time to read them. */
function toast(msg, error = false) {
  const t = $("toast");
  $("toast-text").textContent = msg;
  $("live").textContent = "";
  // Changing the live region's text on the next frame makes screen readers announce repeats too.
  requestAnimationFrame(() => ($("live").textContent = msg));
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  if (!error) toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

let announceTimer;
/** Describe the map for screen readers after it moves (debounced so pans don't flood). */
function announceView(delay = 700) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    if (file || !state.view) return;
    $("map-status").textContent = describeView(true);
  }, delay);
}

function describeView(withElevation = false) {
  const { lat, lon, mpp } = state.view;
  const km = (mpp * canvas.width) / 1000;
  const ns = lat >= 0 ? "north" : "south", ew = lon >= 0 ? "east" : "west";
  let text = `Map centered on ${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}, ${km < 10 ? km.toFixed(1) : Math.round(km)} kilometres across.`;
  if (withElevation && built) {
    const { cx, cy } = viewInHeightmap();
    const h = builder.elevationAt(built.hm, cx, cy);
    if (h !== null) text += ` Elevation at the center ${Math.round(h)} metres.`;
  }
  text += ` Colors: ${schemeLabel()}${state.custom ? ", changed" : ""}.`;
  return text;
}

const fmt = (m) => (Number.isInteger(m) ? `${m}` : `${+m.toFixed(2)}`);
const squash = (s) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
const sliderToMetres = (v) => {
  const m = 10 ** ((3 * v) / 1000);
  return m < 10 ? Math.round(m * 2) / 2 : Math.round(m);
};
const metresToSlider = (m) => Math.round((Math.log10(Math.max(1, m)) / 3) * 1000);

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

const store = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    } catch {
      return null;
    }
  },
  save() {
    try {
      const { scheme, style, background, custom, swatchTarget, auto, interval, indexEvery: n, smoothM, output, showFrame, elevation, search } = state;
      localStorage.setItem(STORE_KEY, JSON.stringify({ scheme, style, background, custom, swatchTarget, auto, interval, indexEvery: n, smoothM, output, showFrame, elevation, search }));
    } catch {
      /* storage unavailable */
    }
  },
};

function elevationSource() {
  const e = state.elevation;
  if (e.id === "custom") return { name: new URL(e.url).host, url: e.url, encoding: e.encoding, maxZoom: e.maxZoom, custom: true };
  return ELEVATION_SOURCES.find((s) => s.id === e.id) ?? ELEVATION_SOURCES[0];
}

function searchSource() {
  const s = state.search;
  if (s.id === "custom") return { name: new URL(s.url).host, url: s.url, kind: s.kind, custom: true };
  return SEARCH_SOURCES.find((x) => x.id === s.id) ?? SEARCH_SOURCES[0];
}

// ── Theme ───────────────────────────────────────────────────────────────────

const currentPalette = () => palettes.find((x) => x.name === state.scheme.name) ?? palettes[0];
const currentMine = () => (state.scheme.kind === "mine" ? myThemes.find((t) => t.id === state.scheme.name) : null);

function baseTheme() {
  const mine = currentMine();
  if (mine) return cloneTheme(mine.theme);
  return toTheme(fromBase16(currentPalette()), { style: state.style, background: state.background });
}

/** The theme to draw, with spacing applied. `texPerPx` and `summary` give the auto interval. */
function currentTheme(summary, texPerPx = 1) {
  const theme = cloneTheme(state.custom ?? baseTheme());
  const interval = state.auto && summary ? summary.autoInterval(texPerPx, 6) : state.interval;
  setSpacing(theme, interval, (theme.lines?.length ?? 0) >= 2 ? state.indexEvery : undefined);
  return theme;
}

function schemeLabel() {
  return currentMine()?.name ?? currentPalette().title;
}

/** Colors of a theme itself: background, then each line color. */
function themeColors(t) {
  const colors = [t.background];
  for (const l of t.lines ?? []) colors.push(...(Array.isArray(l.color) ? l.color.map((s) => s.color) : [l.color]));
  return colors;
}

/** The colors offered as swatches: the scheme's palette, or a saved theme's own colors. */
function swatchColors() {
  const mine = currentMine();
  if (mine) return mine.swatches;
  return [...new Set(currentPalette().colors.map((c) => c.toLowerCase()))];
}

function schemeStripColors() {
  const mine = currentMine();
  if (mine) return mine.swatches.length ? mine.swatches : themeColors(mine.theme);
  return currentPalette().colors;
}

function fillStrip(strip, colors) {
  strip.replaceChildren(...colors.map((c) => {
    const s = el("span");
    s.style.background = c;
    return s;
  }));
  strip.style.gridTemplateColumns = `repeat(${Math.max(1, colors.length)}, 1fr)`;
}

// ── View math ───────────────────────────────────────────────────────────────

/** Web Mercator pixels (zoom 0) per device pixel for the current view. */
function mercPerDevPx(view = state.view, z = 0) {
  return ((view.mpp / 1000 / (111.32 * Math.cos((view.lat * Math.PI) / 180))) / 360) * 2 ** z * 256;
}

/** Where the view centre falls in the built heightmap, and its scale. */
function viewInHeightmap() {
  const p = built.plan;
  let [mx, my] = mercatorPx(state.view.lon, state.view.lat, p.z);
  const world = 2 ** p.z * 256;
  mx += Math.round(((p.x0 + p.x1) / 2 - mx) / world) * world;
  const cx = ((mx - p.x0) / (p.x1 - p.x0)) * p.w;
  const cy = ((my - p.y0) / (p.y1 - p.y0)) * p.h;
  const texPerPx = mercPerDevPx(state.view, p.z) * (p.w / (p.x1 - p.x0));
  return { cx, cy, texPerPx };
}

function setView(lat, lon, mpp) {
  const oldLat = state.view?.lat ?? lat;
  lat = Math.max(-84, Math.min(84, lat));
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  // Keep the on-screen zoom steady when moving north or south (Web Mercator).
  if (mpp === undefined) mpp = state.view.mpp * (Math.cos((lat * Math.PI) / 180) / Math.cos((oldLat * Math.PI) / 180));
  state.view = { lat, lon, mpp: Math.max(MIN_MPP, Math.min(MAX_MPP, mpp)) };
  viewChanged();
}

function panBy(dx, dy) {
  const m = mercPerDevPx();
  const [mx, my] = mercatorPx(state.view.lon, state.view.lat, 0);
  const [lon, lat] = lonLatOf(mx - dx * m, my - dy * m, 0);
  setView(lat, lon);
}

/** Zoom by `factor` (>1 zooms out) keeping the point at device pixel (px, py) still. */
function zoomAt(px, py, factor) {
  const W = canvas.width, H = canvas.height;
  const target = Math.max(MIN_MPP, Math.min(MAX_MPP, state.view.mpp * factor));
  factor = target / state.view.mpp;
  const m = mercPerDevPx();
  const [mx, my] = mercatorPx(state.view.lon, state.view.lat, 0);
  const [dx, dy] = [px - W / 2, py - H / 2];
  const [plon, plat] = lonLatOf(mx + dx * m, my + dy * m, 0);
  const [pmx, pmy] = mercatorPx(plon, plat, 0);
  const m2 = m * factor;
  const [lon, lat] = lonLatOf(pmx - dx * m2, pmy - dy * m2, 0);
  state.view.mpp = target;
  setView(lat, lon);
}

function flyToBox([west, south, east, north], lat, lon) {
  const W = canvas.width, H = canvas.height;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const km = Math.max((east - west) * 111.32 * cosLat, ((north - south) * 110.57 * W) / H, 1.5);
  setView(lat, lon, (km * 1000 * 1.25) / W);
}

// ── URL (kept after #, never sent to a server) ──────────────────────────────

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const at = q.get("at")?.split(",").map(Number);
  const out = {};
  if (at?.length === 3 && at.every(Number.isFinite)) out.view = { lat: at[0], lon: at[1], mpp: at[2] };
  const c = q.get("colors");
  if (c) {
    const [kind, name, style, background] = c.split(":");
    if ((kind === "palette" || kind === "mine") && name) out.colors = { kind, name, style, background };
  }
  return out;
}

let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    if (file) return;
    const { lat, lon, mpp } = state.view;
    const q = new URLSearchParams();
    q.set("at", `${lat.toFixed(5)},${lon.toFixed(5)},${+mpp.toPrecision(4)}`);
    const s = state.scheme;
    q.set("colors", s.kind === "palette" ? `palette:${s.name}:${state.style}:${state.background}` : `mine:${s.name}`);
    history.replaceState(null, "", `#${q.toString().replaceAll("%2C", ",").replaceAll("%3A", ":")}`);
    $("map").setAttribute("aria-label", `Contour map. ${describeView()}`);
  }, 250);
}

// ── Building terrain ────────────────────────────────────────────────────────

let buildSeq = 0;
let buildAbort = null;
let rebuildTimer = 0;

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  const scale = Math.min(dpr, Math.sqrt(MAX_CANVAS_PX / Math.max(1, cssW * cssH)));
  const [w, h] = [Math.max(1, Math.round(cssW * scale)), Math.max(1, Math.round(cssH * scale))];
  if (canvas.width !== w || canvas.height !== h) {
    const oldW = canvas.width;
    canvas.width = w;
    canvas.height = h;
    // Keep the same ground width on screen when the canvas resolution changes.
    if (state.view && oldW > 1) state.view.mpp *= oldW / w;
    return true;
  }
  return false;
}

function needsRebuild() {
  if (file) return false;
  if (!built) return true;
  if (built.W !== canvas.width || built.H !== canvas.height) return true;
  const { cx, cy, texPerPx } = viewInHeightmap();
  if (Math.abs(texPerPx - 1) > 1e-3) return true;
  const [hw, hh] = [(canvas.width / 2) * texPerPx, (canvas.height / 2) * texPerPx];
  return cx - hw < 0 || cy - hh < 0 || cx + hw > built.plan.w || cy + hh > built.plan.h;
}

function scheduleRebuild(delay = 220) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    if (needsRebuild()) rebuild();
  }, delay);
}

function setProgress(done, total) {
  const bar = $("progress");
  if (done >= total) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $("progress-bar").style.width = `${Math.round((done / total) * 100)}%`;
}

async function rebuild() {
  const seq = ++buildSeq;
  buildAbort?.abort();
  const abort = (buildAbort = new AbortController());
  const W = canvas.width, H = canvas.height;
  const max = Math.min(builder.maxSize, 16384);
  const w = Math.min(max, Math.round(W * MARGIN)), h = Math.min(max, Math.round(H * MARGIN));
  const { lat, lon, mpp } = state.view;
  const source = elevationSource();
  try {
    let p = plan({ lat, lon, widthKm: (mpp * w) / 1000, widthPx: w, heightPx: h, maxZoom: source.maxZoom ?? 15, maxTiles: 900 });
    // Small GPUs: use coarser tiles if the stitched tiles wouldn't fit in a texture.
    while ((p.cols * 256 > max || p.rows * 256 > max) && p.z > 0) {
      p = plan({ lat, lon, widthKm: (mpp * w) / 1000, widthPx: w, heightPx: h, zoom: p.z - 1, maxTiles: 900 });
    }
    setProgress(0, p.cols * p.rows);
    const mosaic = await loadMosaic(p, source, tiles, { signal: abort.signal, onProgress: setProgress });
    if (seq !== buildSeq) return;
    const hm = builder.build(p, mosaic, state.smoothM);
    const summary = builder.summary(hm);
    if (built && built.hm.texture !== hm.texture) renderer.gl.deleteTexture(built.hm.texture);
    built = { plan: p, hm: { ...hm, min: summary.min, max: summary.max }, summary, W, H };
    renderer.setHeightTexture(built.hm);
    $("map-error").hidden = true;
    thumbs.invalidate();
    draw();
  } catch (err) {
    if (abort.signal.aborted || seq !== buildSeq || err.name === "AbortError") return;
    setProgress(1, 1);
    showMapError(err);
  }
}

function showMapError(err) {
  const box = $("map-error");
  const source = elevationSource();
  box.replaceChildren(
    el("strong", { textContent: "Couldn't load elevation" }),
    el("div", { className: "hint", textContent: err.message }),
    el("div", { className: "hint", textContent: `Source: ${source.name}. Check your connection, or pick another source under Data sources.` }),
  );
  box.hidden = false;
}

// ── Drawing ─────────────────────────────────────────────────────────────────

let frameReq = 0;
function draw() {
  if (!frameReq) frameReq = requestAnimationFrame(drawNow);
}

let lastResolvedKey = "";
function drawNow() {
  frameReq = 0;
  const W = canvas.width, H = canvas.height;
  if (file) {
    if (renderer.hm !== file.hm) renderer.setHeightmap(file.hm);
    const theme = currentTheme(file.summary, renderer.texPerPx(W, H));
    renderer.setTheme(resolveTheme(theme, file.hm.min, file.hm.max));
    renderer.render({ width: W, height: H });
    syncLinesUI(theme);
    updateFrame();
    return;
  }
  if (!built) return;
  const { cx, cy, texPerPx } = viewInHeightmap();
  const theme = currentTheme(built.summary, texPerPx);
  const key = JSON.stringify(theme) + built.hm.min + built.hm.max;
  if (key !== lastResolvedKey) {
    renderer.setTheme(resolveTheme(theme, built.hm.min, built.hm.max));
    lastResolvedKey = key;
  }
  renderer.render({ width: W, height: H, center: [cx, cy], texPerPx, blankOutside: true });
  syncLinesUI(theme);
  updateFrame();
  updateScale();
  if (needsRebuild()) scheduleRebuild();
}

function viewChanged() {
  writeHash();
  draw();
  scheduleRebuild();
}

// ── Wallpaper frame and scale ───────────────────────────────────────────────

function outputSize() {
  const o = state.output;
  if (o.choice === "screen") {
    const dpr = window.devicePixelRatio || 1;
    return { w: Math.round(screen.width * dpr), h: Math.round(screen.height * dpr) };
  }
  return { w: o.w, h: o.h };
}

/** The part of the screen the wallpaper covers, in device pixels. */
function frameRect() {
  const W = canvas.width, H = canvas.height;
  const { w, h } = outputSize();
  const panel = $("panel").getBoundingClientRect();
  const dpr = W / canvas.clientWidth;
  // Keep clear of the side panel on wide screens.
  const rightInset = window.innerWidth > 760 ? (window.innerWidth - panel.left + 14) * dpr : 0;
  const top = 78 * dpr, bottom = 50 * dpr, left = 24 * dpr;
  const availW = Math.max(50, W - rightInset - left - 24 * dpr), availH = Math.max(50, H - top - bottom);
  const s = Math.min(availW / w, availH / h);
  const fw = w * s, fh = h * s;
  const x = left + (availW - fw) / 2, y = top + (availH - fh) / 2;
  return { x, y, w: fw, h: fh, outW: w, outH: h };
}

function frameCenter(r) {
  const W = canvas.width, H = canvas.height;
  const m = mercPerDevPx();
  const [mx, my] = mercatorPx(state.view.lon, state.view.lat, 0);
  const [lon, lat] = lonLatOf(mx + (r.x + r.w / 2 - W / 2) * m, my + (r.y + r.h / 2 - H / 2) * m, 0);
  const mpp = state.view.mpp * (Math.cos((lat * Math.PI) / 180) / Math.cos((state.view.lat * Math.PI) / 180));
  return { lat, lon, widthKm: (r.w * mpp) / 1000 };
}

function updateFrame() {
  const frame = $("frame");
  if (!state.showFrame || file) {
    frame.hidden = true;
    return;
  }
  const r = frameRect();
  const dpr = canvas.width / canvas.clientWidth;
  Object.assign(frame.style, { left: `${r.x / dpr}px`, top: `${r.y / dpr}px`, width: `${r.w / dpr}px`, height: `${r.h / dpr}px` });
  const { widthKm } = frameCenter(r);
  $("frame-label").textContent = `${r.outW} × ${r.outH} · ${widthKm < 10 ? widthKm.toFixed(2) : widthKm.toFixed(1)} km wide`;
  frame.hidden = false;
}

function updateScale() {
  const dpr = canvas.width / canvas.clientWidth;
  const mPerCss = state.view.mpp * dpr;
  const target = 110 * mPerCss;
  const nice = [1, 2, 5].flatMap((n) => [n, n * 10, n * 100, n * 1000, n * 10_000, n * 100_000, n * 1_000_000]).sort((a, b) => a - b);
  const len = nice.filter((n) => n <= target).pop() ?? 1;
  $("scale-bar").style.width = `${len / mPerCss}px`;
  $("scale-label").textContent = len >= 1000 ? `${len / 1000} km` : `${len} m`;
}

// ── Side panel ──────────────────────────────────────────────────────────────

function setRadio(groupId, value) {
  for (const b of $(groupId).querySelectorAll("button")) {
    const on = b.dataset.value === value;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

/** Arrow keys move between options of a role="radiogroup" and select them (ARIA radio group pattern). */
function wireRadioKeys(group) {
  group.addEventListener("keydown", (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: "first", End: "last" };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const items = [...group.querySelectorAll('[role="radio"]')].filter((b) => !b.hidden);
    const i = items.indexOf(document.activeElement);
    const k = keys[e.key];
    const next = k === "first" ? items[0] : k === "last" ? items.at(-1) : items[(i + k + items.length) % items.length];
    next.focus();
    next.click();
  });
}

function syncColorsUI() {
  const mine = currentMine();
  $("scheme-name").textContent = schemeLabel() + (state.custom ? " (changed)" : "");
  fillStrip($("scheme-strip"), schemeStripColors());
  $("palette-options").hidden = !!mine;
  $("mine-options").hidden = !mine;
  $("palette-save").hidden = !!mine;
  $("swatch-edit-row").hidden = !mine;
  if (mine && document.activeElement !== $("mine-name")) $("mine-name").value = mine.name;
  setRadio("style", state.style);
  setRadio("background-mode", state.background);
  $("reset-colors").hidden = !state.custom;
  const t = editableView();
  $("background").value = t.background ?? "#000000";
  buildTiers(t);
  renderSwatches();
}

/** The colors being shown: a saved theme, or a built-in scheme with any changes. */
function editableView() {
  return currentMine()?.theme ?? state.custom ?? baseTheme();
}

/** After changing colors: save them and redraw. */
function colorsChanged({ rebuildPanel = false } = {}) {
  const mine = currentMine();
  if (mine) {
    mine.theme.name = mine.name;
    persistMine();
  } else {
    store.save();
  }
  $("scheme-name").textContent = schemeLabel() + (state.custom ? " (changed)" : "");
  $("reset-colors").hidden = !state.custom;
  fillStrip($("scheme-strip"), schemeStripColors());
  if (rebuildPanel) syncColorsUI();
  else renderSwatches();
  lastResolvedKey = "";
  draw();
  thumbs.invalidate();
}

function persistMine() {
  if (!saveThemes(myThemes)) toast("This browser didn't save your themes (storage is full or turned off)", true);
}

// ── Swatches ────────────────────────────────────────────────────────────────

const sameColor = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

function targetColor(theme, target) {
  if (target === "background") return theme.background;
  const tier = theme.lines?.[target === "index" ? 1 : 0];
  return tier && !Array.isArray(tier.color) ? tier.color : null;
}

function applySwatch(color) {
  const t = editable();
  const target = state.swatchTarget;
  if (target === "background") {
    t.background = color;
  } else {
    const tier = t.lines[target === "index" ? 1 : 0];
    if (!tier) return;
    tier.color = color;
  }
  colorsChanged({ rebuildPanel: true });
}

let removingSwatches = false;

function renderSwatches() {
  const box = $("swatches");
  const theme = editableView();
  const hasIndex = (theme.lines?.length ?? 0) >= 2;
  if (!hasIndex && state.swatchTarget === "index") state.swatchTarget = "lines";
  $("swatch-target").querySelector('[data-value="index"]').hidden = !hasIndex;
  setRadio("swatch-target", state.swatchTarget);
  const mine = currentMine();
  $("swatch-label").textContent = mine ? "Theme colors" : "Scheme colors";
  box.classList.toggle("removing", !!mine && removingSwatches);
  $("swatch-edit").setAttribute("aria-pressed", String(!!mine && removingSwatches));
  const current = targetColor(theme, state.swatchTarget);
  const colors = swatchColors();
  const targetName = { background: "background", lines: "lines", index: "index lines" }[state.swatchTarget];
  const buttons = colors.map((c) => {
    const removing = !!mine && removingSwatches;
    const b = el("button", { type: "button", className: "swatch", title: c });
    b.style.background = c;
    b.setAttribute("aria-label", removing ? `Remove ${c}` : `Use ${c} for ${targetName}`);
    if (!removing) b.setAttribute("aria-pressed", String(sameColor(c, current)));
    b.addEventListener("click", () => {
      if (mine && removingSwatches) {
        mine.swatches = mine.swatches.filter((x) => !sameColor(x, c));
        colorsChanged();
        return;
      }
      applySwatch(c);
    });
    return b;
  });
  if (!colors.length) buttons.push(el("span", { className: "empty-note", textContent: "No colors yet. Pick one below and press Add." }));
  box.replaceChildren(...buttons);
}

function tierLabel(i) {
  return i === 0 ? "Lines" : i === 1 ? "Index lines" : `Tier ${i + 1}`;
}

let fieldId = 0;
function sliderRow(label, min, max, step, value, onInput, format, accessibleName = label) {
  const id = `field-${++fieldId}`;
  const input = el("input", { type: "range", min, max, step, value, id });
  input.setAttribute("aria-label", accessibleName);
  input.setAttribute("aria-valuetext", format(+value));
  const out = el("output", { textContent: format(+value) });
  out.setAttribute("aria-hidden", "true");
  input.addEventListener("input", () => {
    out.textContent = format(+input.value);
    input.setAttribute("aria-valuetext", format(+input.value));
    onInput(+input.value);
  });
  return el("div", { className: "slider-row" }, el("label", { htmlFor: id, textContent: label }), input, out);
}

/** The theme to edit: a saved theme directly, or a copy of a built-in scheme's colors. */
function editable() {
  const mine = currentMine();
  if (mine) return mine.theme;
  if (!state.custom) state.custom = baseTheme();
  return state.custom;
}

function colorInput(value, onInput, label) {
  const c = el("topo-color-input");
  c.setAttribute("alpha", "");
  if (label) c.setAttribute("label", label);
  c.value = value;
  const handler = () => onInput(c.value);
  c.addEventListener("input", handler);
  c.addEventListener("change", handler);
  return c;
}

function buildTiers(theme) {
  const box = $("tiers");
  box.replaceChildren();
  (theme.lines ?? []).forEach((tier, i) => {
    const name = tierLabel(i);
    const card = el("div", { className: "tier", role: "group" }, el("h3", { className: "tier-title", textContent: name }));
    card.setAttribute("aria-label", name);
    const update = (fn) => {
      fn(editable().lines[i]);
      colorsChanged();
    };
    if (Array.isArray(tier.color)) {
      tier.color.forEach((stop, si) => {
        const at = el("input", { type: "text", value: stop.at, className: "at", title: "Elevation in metres, or a percentage like 50%" });
        at.setAttribute("aria-label", `${name} color stop ${si + 1} position, in metres or a percentage`);
        at.addEventListener("change", () => {
          const v = at.value.trim();
          const parsed = /%$/.test(v) ? v : Number.isFinite(parseFloat(v)) ? parseFloat(v) : null;
          if (parsed === null) {
            at.value = stop.at;
            return;
          }
          update((t) => (t.color[si].at = parsed));
        });
        card.append(el("div", { className: "stop" }, colorInput(stop.color, (v) => update((t) => (t.color[si].color = v)), `${name} color stop ${si + 1}`), at));
      });
    } else {
      card.append(el("div", { className: "field-head" }, el("span", { className: "dim", textContent: "Color" }),
        colorInput(tier.color, (v) => update((t) => (t.color = v)), `${name} color`)));
    }
    card.append(
      sliderRow("Width", 0.25, 6, 0.05, tier.width ?? 1.25, (v) => update((t) => (t.width = v)), (v) => `${v.toFixed(2)} px`, `${name} width`),
      sliderRow("Opacity", 0, 1, 0.01, tier.opacity ?? 1, (v) => update((t) => (t.opacity = v)), (v) => `${Math.round(v * 100)}%`, `${name} opacity`),
    );
    box.append(card);
  });
}

function syncLinesUI(theme) {
  const base = theme.lines?.[0]?.every ?? state.interval;
  if (document.activeElement !== $("interval")) $("interval").value = metresToSlider(base);
  $("interval").setAttribute("aria-valuetext", `${fmt(base)} metres${state.auto ? ", automatic" : ""}`);
  if (document.activeElement !== $("interval-num")) $("interval-num").value = fmt(base);
  $("auto").setAttribute("aria-pressed", String(state.auto));
  const n = indexEvery(theme);
  for (const id of ["index-every", "index-dec", "index-inc"]) $(id).disabled = n === null;
  if (document.activeElement !== $("index-every")) $("index-every").value = n ?? "";
}

function selectScheme(kind, name) {
  state.scheme = { kind, name };
  state.custom = null;
  removingSwatches = false;
  const base = baseTheme();
  if (base.lines?.length >= 2) state.indexEvery = indexEvery(base) ?? state.indexEvery;
  syncColorsUI();
  store.save();
  writeHash();
  draw();
  thumbs.markCurrent();
}

/** Save the colors on screen as a new theme in this browser, and switch to it. */
function saveAsMine() {
  const theme = cloneTheme(editableView());
  const base = currentMine() ? null : currentPalette();
  const name = currentMine() ? `${currentMine().name} copy` : `${base.title}${state.custom ? " (mine)" : ` ${state.style}`}`;
  const swatches = [...new Set([...swatchColors(), ...themeColors(theme)].map((c) => c.toLowerCase()))].slice(0, 32);
  const entry = cleanEntry({ id: newId(), name, theme, swatches });
  if (!entry) {
    toast("These colors can't be saved as a theme", true);
    return null;
  }
  myThemes.unshift(entry);
  persistMine();
  thumbs.refreshMine();
  selectScheme("mine", entry.id);
  toast(`Saved "${entry.name}" in this browser`);
  return entry;
}

function renderSources() {
  const e = elevationSource(), s = searchSource();
  const link = (text, href) => (href
    ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, text, el("span", { className: "sr-only", textContent: " (opens in a new tab)" }))
    : el("span", { textContent: text }));
  $("source-summary").replaceChildren(
    el("div", { className: "source-line" }, el("b", { textContent: "Elevation" }),
      el("span", {}, link(e.name, e.about), e.custom ? ` (${ENCODINGS[e.encoding].name})` : "", e.datasets ? el("span", { className: "dim", textContent: ` · ${e.datasets}` }) : "")),
    el("div", { className: "source-line" }, el("b", { textContent: "Search" }), el("span", {}, link(s.name, s.about))),
  );
  const attribution = [
    link(e.custom ? `Elevation: ${e.name}` : e.attribution, e.about),
  ];
  if (s.kind !== "off") {
    attribution.push(el("span", {}, "Search: ", link(s.name, s.about), " · © ", link("OpenStreetMap", "https://www.openstreetmap.org/copyright"), " contributors"));
  }
  attribution.push(el("span", {}, "Color schemes: ", link("tinted-theming", "https://github.com/tinted-theming/schemes")));
  $("attribution").replaceChildren(...attribution);
}

// ── Scheme browser with live thumbnails ─────────────────────────────────────

const thumbs = (() => {
  const TW = 256, TH = 160;
  let fbo, tex, pixels, image;
  let generation = 0;
  const queue = new Set();
  const visible = new Set();
  let observer, raf = 0, tab = "palettes", makeCard = null;
  const cards = new Map();
  const filter = { text: "", tags: new Set() };

  function target(gl) {
    if (fbo) return;
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TW, TH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    pixels = new Uint8Array(TW * TH * 4);
    image = new ImageData(TW, TH);
  }

  function themeFor(card) {
    if (card.kind === "palette") {
      return toTheme(fromBase16(card.palette), { style: state.style, background: state.background });
    }
    return cloneTheme(myThemes.find((t) => t.id === card.key)?.theme ?? card.theme);
  }

  function paint(card) {
    const gl = renderer.gl;
    target(gl);
    let hm, center, texPerPx;
    if (file) {
      hm = file.hm;
      texPerPx = renderer.texPerPx(TW, TH);
      center = [hm.width / 2, hm.height / 2];
    } else if (built) {
      const v = viewInHeightmap();
      hm = built.hm;
      center = [v.cx, v.cy];
      texPerPx = v.texPerPx * Math.max(canvas.width / TW, canvas.height / TH);
    } else {
      return false;
    }
    const theme = themeFor(card);
    const summary = file ? file.summary : built.summary;
    const interval = state.auto ? summary.autoInterval(texPerPx, 6) : state.interval;
    setSpacing(theme, interval, (theme.lines?.length ?? 0) >= 2 ? indexEvery(theme) : undefined);
    renderer.setTheme(resolveTheme(theme, hm.min, hm.max));
    renderer.render({ target: fbo, width: TW, height: TH, center, texPerPx, blankOutside: !file });
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, TW, TH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL rows run bottom-up.
    for (let y = 0; y < TH; y++) image.data.set(pixels.subarray((TH - 1 - y) * TW * 4, (TH - y) * TW * 4), y * TW * 4);
    card.canvas.getContext("2d").putImageData(image, 0, 0);
    card.painted = generation;
    return true;
  }

  function pump() {
    raf = 0;
    if (!$("schemes").open) return;
    const start = performance.now();
    for (const card of queue) {
      queue.delete(card);
      if (card.painted === generation || !visible.has(card)) continue;
      if (!paint(card)) break;
      if (performance.now() - start > 12) break;
    }
    lastResolvedKey = ""; // the main view's theme was replaced while painting
    if (queue.size) raf = requestAnimationFrame(pump);
    else draw();
  }

  function request(card) {
    queue.add(card);
    if (!raf) raf = requestAnimationFrame(pump);
  }

  function build() {
    const grid = $("scheme-grid");
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const card = cards.get(e.target);
        if (e.isIntersecting) {
          visible.add(card);
          if (card.painted !== generation) request(card);
        } else {
          visible.delete(card);
        }
      }
    }, { root: grid, rootMargin: "300px" });

    const make = (kind, key, title, tags, colors, extra) => {
      const c = el("canvas", { width: TW, height: TH });
      c.setAttribute("aria-hidden", "true");
      const strip = el("span", { className: "strip small" });
      strip.setAttribute("aria-hidden", "true");
      fillStrip(strip, colors);
      const button = el("button", { type: "button", className: "scheme-card", title: `Use ${title}` },
        c, strip,
        el("span", { className: "meta" },
          el("span", { className: "name", textContent: key }),
          el("span", { className: "title", textContent: title }),
          el("span", { className: "tags", textContent: tags.join(" · ") })));
      button.setAttribute("aria-label", kind === "palette" ? `${key}, ${title}. Tags: ${tags.join(", ")}` : `${title}, saved theme`);
      const card = { kind, key, title, tags, canvas: c, button, painted: -1, ...extra };
      button.addEventListener("click", () => {
        selectScheme(kind, key);
        $("schemes").close();
      });
      cards.set(button, card);
      observer.observe(button);
      return button;
    };
    makeCard = make;
    grid.replaceChildren(
      ...palettes.map((p) => make("palette", p.name, p.title, p.tags, p.colors, { palette: p })),
      el("div", { className: "empty", id: "scheme-empty", hidden: true }),
    );
    addMineCards();

    const groups = $("tag-groups");
    for (const group of TAG_GROUPS) {
      const g = el("div", { className: "tag-group" });
      for (const tag of group) {
        const chip = el("button", { type: "button", className: "chip" });
        chip.dataset.tag = tag;
        if (group.length === 9) chip.append(el("span", { className: `dot dot-${tag}` }));
        chip.append(tag);
        chip.addEventListener("click", () => {
          const on = filter.tags.has(tag);
          group.forEach((t) => filter.tags.delete(t));
          if (!on) filter.tags.add(tag);
          applyFilter();
        });
        g.append(chip);
      }
      groups.append(g);
    }
    $("scheme-search").addEventListener("input", (e) => {
      filter.text = e.target.value;
      applyFilter();
    });
    for (const [id, name] of [["tab-palettes", "palettes"], ["tab-themes", "themes"]]) {
      $(id).addEventListener("click", () => {
        tab = name;
        applyFilter();
      });
    }
    // Tabs: Left/Right switch tabs (ARIA tabs pattern, automatic activation).
    $("tab-palettes").parentElement.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const next = tab === "palettes" ? $("tab-themes") : $("tab-palettes");
      const target = e.key === "Home" ? $("tab-palettes") : e.key === "End" ? $("tab-themes") : next;
      target.focus();
      target.click();
    });
  }

  function addMineCards() {
    for (const [button, card] of cards) {
      if (card.kind === "mine") {
        observer.unobserve(button);
        visible.delete(card);
        queue.delete(card);
        cards.delete(button);
        button.remove();
      }
    }
    const empty = $("scheme-empty");
    for (const t of myThemes) {
      const b = makeCard("mine", t.id, t.name, [], t.swatches.length ? t.swatches : themeColors(t.theme), { theme: t.theme });
      // Saved themes are named by the visitor: show the name, not the id.
      b.querySelector(".name").textContent = t.name;
      b.querySelector(".title").textContent = `${t.swatches.length} colors`;
      b.querySelector(".tags").textContent = "saved in this browser";
      b.setAttribute("aria-label", `${t.name}, saved theme with ${t.swatches.length} colors`);
      empty.before(b);
    }
  }

  function applyFilter() {
    const q = squash(filter.text);
    let shown = 0, total = 0;
    for (const card of cards.values()) {
      const inTab = (card.kind === "palette") === (tab === "palettes");
      const title = card.kind === "mine" ? myThemes.find((t) => t.id === card.key)?.name ?? card.title : card.title;
      const match = inTab && [...filter.tags].every((t) => card.tags.includes(t)) &&
        (!q || (card.kind === "palette" && squash(card.key).includes(q)) || squash(title).includes(q));
      card.button.hidden = !match;
      if (inTab) total++;
      if (match) shown++;
    }
    for (const [id, name] of [["tab-palettes", "palettes"], ["tab-themes", "themes"]]) {
      $(id).setAttribute("aria-selected", String(tab === name));
      $(id).tabIndex = tab === name ? 0 : -1;
    }
    $("scheme-panel").setAttribute("aria-labelledby", tab === "palettes" ? "tab-palettes" : "tab-themes");
    $("tag-groups").hidden = tab !== "palettes";
    $("mine-tools").hidden = tab !== "themes";
    $("scheme-count").textContent = `${shown} of ${total}`;
    $("scheme-empty").textContent = tab === "themes" && !total
      ? "You haven't saved any themes yet. Pick a color scheme, change its colors if you like, and choose Save as my theme."
      : "Nothing matches.";
    $("scheme-empty").hidden = shown > 0;
    for (const c of $("tag-groups").querySelectorAll(".chip")) c.setAttribute("aria-pressed", String(filter.tags.has(c.dataset.tag)));
  }

  return {
    open() {
      if (!observer) build();
      tab = state.scheme.kind === "mine" ? "themes" : "palettes";
      applyFilter();
      this.markCurrent();
      $("schemes").showModal();
      for (const card of visible) if (card.painted !== generation) request(card);
      const current = [...cards.values()].find((c) => c.button.getAttribute("aria-current") === "true");
      current?.button.scrollIntoView({ block: "center" });
    },
    invalidate() {
      generation++;
      for (const card of visible) request(card);
    },
    refreshMine() {
      if (!observer) return;
      addMineCards();
      applyFilter();
      this.markCurrent();
    },
    showTab(name) {
      tab = name;
      applyFilter();
    },
    markCurrent() {
      for (const card of cards.values()) {
        card.button.setAttribute("aria-current", String(card.kind === state.scheme.kind && card.key === state.scheme.name));
      }
    },
  };
})();

// ── Search ──────────────────────────────────────────────────────────────────

let searchAbort = null;
let results = [];
let activeResult = -1;

function showResults(items, note) {
  const list = $("results");
  results = items;
  activeResult = -1;
  const lis = items.map((r, i) => {
    const li = el("li", { role: "option", id: `result-${i}` },
      el("span", { className: "r-name", textContent: r.name }),
      el("span", { className: "r-detail", textContent: r.detail || r.kind || "" }));
    li.setAttribute("aria-selected", "false");
    li.addEventListener("click", () => chooseResult(i));
    return li;
  });
  list.replaceChildren(...lis);
  list.hidden = lis.length === 0;
  $("results-note").textContent = note ?? "";
  $("search").setAttribute("aria-expanded", String(!list.hidden));
  $("search").removeAttribute("aria-activedescendant");
}

function chooseResult(i) {
  const r = results[i];
  if (!r) return;
  if (r.bbox) flyToBox(r.bbox, r.lat, r.lon);
  else setView(r.lat, r.lon, state.view.mpp);
  showResults([]);
  $("map-status").textContent = `Showing ${r.name}${r.detail ? `, ${r.detail}` : ""}. ${describeView()}`;
  $("search").blur();
  $("map").focus({ preventScroll: true });
}

async function runSearch() {
  const q = $("search").value.trim();
  if (!q) return;
  const coords = parseCoordinates(q);
  if (coords) {
    setView(coords.lat, coords.lon, state.view.mpp);
    showResults([]);
    announceView(300);
    return;
  }
  if (file) closeFile();
  const source = searchSource();
  if (source.kind === "off") {
    showResults([], "Place search is off. Enter coordinates like 37.738, -119.575, or pick a search service under Data sources.");
    return;
  }
  searchAbort?.abort();
  searchAbort = new AbortController();
  showResults([], `Searching ${source.name}…`);
  try {
    const items = await searchPlaces(q, source, { signal: searchAbort.signal, language: navigator.language });
    showResults(items, items.length
      ? `${items.length} result${items.length === 1 ? "" : "s"} from ${source.name}. Use the arrow keys and Enter to choose.`
      : `No places found by ${source.name}`);
  } catch (err) {
    if (err.name !== "AbortError") showResults([], `Search failed (${source.name}): ${err.message}`);
  }
}

// ── Export ──────────────────────────────────────────────────────────────────

let exportUrl = null;
let exportBlob = null;
let exportTheme = null;

function cliCommands(center, outW, outH, theme) {
  const lines = [];
  const input = file ? file.name : "map.topo";
  if (!file) {
    const km = +center.widthKm.toPrecision(7);
    const smooth = state.smoothM === DEFAULT_SMOOTH ? "" : ` --smooth-m ${state.smoothM}`;
    const src = elevationSource();
    const note = src.custom ? "  # the command-line app downloads from AWS Terrain Tiles" : "";
    lines.push(`topowall fetch --center ${center.lat.toFixed(6)},${center.lon.toFixed(6)} --width-km ${km} --size ${outW}x${outH}${smooth} -o map.topo${note}`);
  }
  const spacing = state.auto ? " --interval auto" : ` --interval ${fmt(theme.lines[0].every)}`;
  const index = theme.lines.length >= 2 ? ` --index-every ${indexEvery(theme)}` : "";
  const size = file ? ` --size ${outW}x${outH}` : "";
  if (!state.custom && state.scheme.kind === "palette") {
    const bg = state.background === "black" ? " --background black" : "";
    lines.push(`topowall render ${input} --palette ${state.scheme.name} --style ${state.style}${bg}${spacing}${index}${size} -o wallpaper.png`);
  } else {
    lines.push(`topowall render ${input} --theme theme.toml${size} -o wallpaper.png   # theme.toml: download it above`);
  }
  return lines.join("\n");
}

async function createWallpaper() {
  const dialog = $("export");
  const status = $("export-status");
  const preview = $("export-preview");
  preview.replaceChildren();
  status.textContent = "Downloading elevation…";
  $("download-png").hidden = true;
  $("export-info").textContent = "";
  $("export-cli").textContent = "";
  dialog.showModal();

  const r = frameRect();
  const { outW: w, outH: h } = r;
  const gl = renderer.gl;
  const maxTex = builder.maxSize;
  try {
    if (w > maxTex || h > maxTex) throw new Error(`this browser's GPU allows images up to ${maxTex} px wide; choose a smaller size`);
    let hm, center = null;
    if (file) {
      hm = file.hm;
      renderer.setHeightmap(hm);
    } else {
      center = frameCenter(r);
      const source = elevationSource();
      const p = plan({ lat: center.lat, lon: center.lon, widthKm: center.widthKm, widthPx: w, heightPx: h, maxZoom: source.maxZoom ?? 15 });
      const mosaic = await loadMosaic(p, source, tiles, {
        onProgress: (d, t) => (status.textContent = `Downloading elevation… ${d}/${t} tiles`),
      });
      status.textContent = "Drawing…";
      await new Promise((res) => requestAnimationFrame(res));
      const gpu = builder.build(p, mosaic, state.smoothM);
      const summary = builder.summary(gpu);
      let { min, max } = summary;
      const theme0 = currentTheme(summary, 1);
      // Exact range for elevation ramps, like the command-line app.
      if ((theme0.lines ?? []).some((l) => Array.isArray(l.color))) {
        const data = builder.read(gpu);
        [min, max] = data.reduce(([lo, hi], v) => [Math.min(lo, v), Math.max(hi, v)], [Infinity, -Infinity]);
      }
      hm = { ...gpu, min, max, summary };
      renderer.setHeightTexture(hm);
    }
    const summary = file ? file.summary : hm.summary;
    const texPerPx = file ? renderer.texPerPx(w, h) : 1;
    const theme = currentTheme(summary, texPerPx);
    renderer.setTheme(resolveTheme(theme, hm.min, hm.max));

    // Draw in tiles so large wallpapers fit the GPU's framebuffer limit.
    const T = Math.min(4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, T, T, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const buf = new Uint8Array(T * T * 4);
    for (let oy = 0; oy < h; oy += T) {
      for (let ox = 0; ox < w; ox += T) {
        const tw = Math.min(T, w - ox), th = Math.min(T, h - oy);
        renderer.render({ target: fbo, width: tw, height: th, fullWidth: w, fullHeight: h, originX: ox, originY: oy, texPerPx });
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const img = ctx.createImageData(tw, th);
        for (let y = 0; y < th; y++) img.data.set(buf.subarray((th - 1 - y) * tw * 4, (th - y) * tw * 4), y * tw * 4);
        ctx.putImageData(img, ox, oy);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    if (!file) gl.deleteTexture(hm.texture);

    // Put the live map back.
    if (file) renderer.setHeightmap(file.hm);
    else if (built) renderer.setHeightTexture(built.hm);
    lastResolvedKey = "";
    draw();

    const blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("the browser couldn't encode the PNG"))), "image/png"));
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(blob);
    exportBlob = blob;
    exportTheme = theme;
    const img = el("img", { src: exportUrl, alt: `Preview of the ${w} by ${h} pixel wallpaper: contour lines in ${schemeLabel()} colors` });
    preview.replaceChildren(img);
    status.textContent = "Your wallpaper is ready to download.";
    const label = currentMine()?.name ?? (state.custom ? "custom" : state.scheme.name);
    const name = `topowall-${label.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "theme"}-${w}x${h}.png`;
    Object.assign($("download-png"), { href: exportUrl, download: name, hidden: false });
    const where = file ? file.name : `${center.lat.toFixed(4)}, ${center.lon.toFixed(4)} · ${center.widthKm.toFixed(2)} km wide`;
    $("export-info").textContent = `${w} × ${h} · ${where} · lines every ${fmt(theme.lines[0].every)} m · ${(blob.size / 1e6).toFixed(1)} MB`;
    $("export-cli").textContent = cliCommands(center, w, h, theme);
  } catch (err) {
    if (file) renderer.setHeightmap(file.hm);
    else if (built) renderer.setHeightTexture(built.hm);
    lastResolvedKey = "";
    draw();
    status.textContent = `Couldn't create the wallpaper: ${err.message}`;
  }
}

// ── .topo files ─────────────────────────────────────────────────────────────

async function openFile(f) {
  try {
    const hm = await parseTopo(await f.arrayBuffer());
    renderer.setHeightmap(hm);
    file = { hm, name: f.name, summary: { min: hm.min, max: hm.max, autoInterval: (tpp, target) => autoInterval(hm, tpp, target) } };
    $("file-name").textContent = `${f.name} · ${hm.width}×${hm.height} · ${Math.round(hm.min)}–${Math.round(hm.max)} m`;
    $("file-banner").hidden = false;
    $("zoom").hidden = true;
    $("map").classList.add("file");
    thumbs.invalidate();
    draw();
  } catch (err) {
    toast(`Couldn't open ${f.name}: ${err.message}`, true);
  }
}

function closeFile() {
  file = null;
  $("file-banner").hidden = true;
  $("zoom").hidden = false;
  if (built) renderer.setHeightTexture(built.hm);
  lastResolvedKey = "";
  thumbs.invalidate();
  viewChanged();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function wireMap() {
  const map = $("map");
  const pointers = new Map();
  let pinch = null;
  const devXY = (e) => {
    const rect = canvas.getBoundingClientRect();
    const k = canvas.width / rect.width;
    return [(e.clientX - rect.left) * k, (e.clientY - rect.top) * k];
  };

  map.addEventListener("pointerdown", (e) => {
    if (file || e.button > 0) return;
    map.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, devXY(e));
    map.classList.add("dragging");
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    }
  });
  map.addEventListener("pointermove", (e) => {
    if (!file) updateCursor(e);
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const now = devXY(e);
    pointers.set(e.pointerId, now);
    if (pointers.size === 1) {
      panBy(now[0] - prev[0], now[1] - prev[1]);
    } else if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      panBy(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1]);
      if (dist > 0) zoomAt(mid[0], mid[1], pinch.dist / dist);
      pinch = { dist, mid };
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) map.classList.remove("dragging");
  };
  map.addEventListener("pointerup", end);
  map.addEventListener("pointercancel", end);
  map.addEventListener("wheel", (e) => {
    if (file) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const [x, y] = devXY(e);
    zoomAt(x, y, Math.exp(px * 0.0018));
  }, { passive: false });
  map.addEventListener("dblclick", (e) => {
    if (file) return;
    const [x, y] = devXY(e);
    zoomAt(x, y, e.shiftKey ? 2 : 0.5);
  });
  map.addEventListener("keydown", (e) => {
    if (file) return;
    const step = 120 * (canvas.width / canvas.clientWidth);
    const keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (keys[e.key]) {
      e.preventDefault();
      panBy(-keys[e.key][0], -keys[e.key][1]);
      announceView();
    } else if (e.key === "+" || e.key === "=") {
      zoomAt(canvas.width / 2, canvas.height / 2, 0.7);
      announceView();
    } else if (e.key === "-" || e.key === "_") {
      zoomAt(canvas.width / 2, canvas.height / 2, 1 / 0.7);
      announceView();
    }
  });
  $("zoom-in").addEventListener("click", () => {
    zoomAt(canvas.width / 2, canvas.height / 2, 0.5);
    announceView();
  });
  $("zoom-out").addEventListener("click", () => {
    zoomAt(canvas.width / 2, canvas.height / 2, 2);
    announceView();
  });
  // Buttons that move the map, so it can be panned without dragging.
  for (const b of document.querySelectorAll("[data-pan]")) {
    b.addEventListener("click", () => {
      const [x, y] = b.dataset.pan.split(",").map(Number);
      const step = Math.min(canvas.width, canvas.height) * 0.25;
      panBy(-x * step, -y * step);
      announceView();
    });
  }
  new ResizeObserver(() => {
    if (sizeCanvas()) scheduleRebuild(120);
    draw();
  }).observe(canvas);
}

let cursorTimer = 0;
function updateCursor(e) {
  if (cursorTimer || !built) return;
  cursorTimer = setTimeout(() => (cursorTimer = 0), 60);
  const rect = canvas.getBoundingClientRect();
  const k = canvas.width / rect.width;
  const [dx, dy] = [(e.clientX - rect.left) * k - canvas.width / 2, (e.clientY - rect.top) * k - canvas.height / 2];
  const { cx, cy, texPerPx } = viewInHeightmap();
  const elev = builder.elevationAt(built.hm, cx + dx * texPerPx, cy + dy * texPerPx);
  const m = mercPerDevPx();
  const [mx, my] = mercatorPx(state.view.lon, state.view.lat, 0);
  const [lon, lat] = lonLatOf(mx + dx * m, my + dy * m, 0);
  $("cursor").textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}${elev === null ? "" : ` · ${Math.round(elev)} m`}`;
}

function wirePanel() {
  $("panel-toggle").addEventListener("click", () => {
    const collapsed = $("panel").classList.toggle("collapsed");
    $("panel-toggle").setAttribute("aria-expanded", String(!collapsed));
  });
  if (window.innerWidth <= 760) $("panel").classList.add("collapsed");

  for (const id of ["style", "background-mode", "swatch-target"]) wireRadioKeys($(id));
  $("open-file").addEventListener("click", () => $("file").click());
  $("mine-restore").addEventListener("click", () => $("mine-import").click());
  $("toast-close").addEventListener("click", () => ($("toast").hidden = true));
  document.querySelector(".skip-link").addEventListener("click", (e) => {
    // Handled here: following the link would replace the map's place in the address.
    e.preventDefault();
    $("panel").classList.remove("collapsed");
    $("panel-toggle").setAttribute("aria-expanded", "true");
    $("panel-start").focus();
  });
  $("scheme-button").addEventListener("click", () => thumbs.open());
  $("schemes-close").addEventListener("click", () => $("schemes").close());
  $("schemes").addEventListener("click", (e) => {
    if (e.target === $("schemes")) $("schemes").close();
  });

  for (const [id, key] of [["style", "style"], ["background-mode", "background"]]) {
    for (const b of $(id).querySelectorAll("button")) {
      b.addEventListener("click", () => {
        state[key] = b.dataset.value;
        state.custom = null;
        syncColorsUI();
        store.save();
        writeHash();
        thumbs.invalidate();
        draw();
      });
    }
  }
  $("background").addEventListener("input", (e) => {
    editable().background = e.target.value;
    colorsChanged();
  });
  $("reset-colors").addEventListener("click", () => {
    state.custom = null;
    colorsChanged({ rebuildPanel: true });
  });
  for (const b of $("swatch-target").querySelectorAll("button")) {
    b.addEventListener("click", () => {
      state.swatchTarget = b.dataset.value;
      store.save();
      renderSwatches();
    });
  }
  $("save-mine").addEventListener("click", saveAsMine);
  $("swatch-add-btn").addEventListener("click", () => {
    const mine = currentMine();
    const c = $("swatch-add").value?.toLowerCase();
    if (!mine || !c) return;
    if (mine.swatches.some((x) => sameColor(x, c))) {
      toast("That color is already in this theme");
      return;
    }
    if (mine.swatches.length >= 32) {
      toast("A theme can hold up to 32 colors", true);
      return;
    }
    mine.swatches.push(c);
    removingSwatches = false;
    colorsChanged();
  });
  $("swatch-edit").addEventListener("click", () => {
    removingSwatches = !removingSwatches;
    renderSwatches();
  });
  $("mine-name").addEventListener("input", (e) => {
    const mine = currentMine();
    if (!mine) return;
    mine.name = e.target.value.trim().slice(0, 60) || "Untitled";
    colorsChanged();
    thumbs.refreshMine();
  });
  let deleteArmed = 0;
  $("mine-delete").addEventListener("click", () => {
    const mine = currentMine();
    if (!mine) return;
    if (Date.now() - deleteArmed > 4000) {
      deleteArmed = Date.now();
      $("mine-delete").textContent = "Click again to delete";
      setTimeout(() => ($("mine-delete").textContent = "Delete theme"), 4000);
      return;
    }
    myThemes = myThemes.filter((t) => t.id !== mine.id);
    persistMine();
    $("mine-delete").textContent = "Delete theme";
    selectScheme("palette", palettes.some((p) => p.name === "rose-pine") ? "rose-pine" : palettes[0].name);
    thumbs.refreshMine();
    toast(`Deleted "${mine.name}"`);
  });
  $("mine-new").addEventListener("click", () => {
    if (saveAsMine()) $("schemes").close();
  });
  $("mine-export").addEventListener("click", () => {
    if (!myThemes.length) {
      toast("There are no saved themes to back up");
      return;
    }
    const url = URL.createObjectURL(new Blob([exportThemes(myThemes)], { type: "application/json" }));
    el("a", { href: url, download: "topowall-themes.json" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("mine-import").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      if (f.size > 2_000_000) throw new Error("the file is too large for a theme backup");
      const { themes: added, skipped } = importThemes(await f.text());
      const names = new Set(myThemes.map((t) => t.name));
      for (const t of added) {
        if (names.has(t.name)) t.name = t.theme.name = `${t.name} (restored)`.slice(0, 60);
      }
      myThemes = [...added, ...myThemes].slice(0, 200);
      persistMine();
      thumbs.refreshMine();
      toast(`Restored ${added.length} theme${added.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}`);
    } catch (err) {
      toast(`Couldn't restore: ${err.message}`, true);
    }
  });

  const setInterval_ = (m) => {
    if (!(m > 0)) return;
    state.auto = false;
    state.interval = Math.min(1000, Math.max(0.5, m));
    store.save();
    thumbs.invalidate();
    draw();
  };
  $("interval").addEventListener("input", (e) => setInterval_(sliderToMetres(+e.target.value)));
  $("interval-num").addEventListener("change", (e) => setInterval_(parseFloat(e.target.value)));
  $("auto").addEventListener("click", () => {
    state.auto = !state.auto;
    if (!state.auto) state.interval = parseFloat($("interval-num").value) || state.interval;
    store.save();
    thumbs.invalidate();
    draw();
  });
  const setIndex = (n) => {
    if (!(n >= 1)) return;
    state.indexEvery = Math.min(50, Math.round(n));
    store.save();
    thumbs.invalidate();
    draw();
  };
  $("index-every").addEventListener("change", (e) => setIndex(+e.target.value));
  $("index-dec").addEventListener("click", () => setIndex(state.indexEvery - 1));
  $("index-inc").addEventListener("click", () => setIndex(state.indexEvery + 1));

  const smooth = $("smooth");
  const smoothOut = () => {
    $("smooth-out").textContent = `${fmt(state.smoothM)} m`;
    smooth.setAttribute("aria-valuetext", `${fmt(state.smoothM)} metres`);
  };
  smooth.value = state.smoothM;
  smoothOut();
  smooth.addEventListener("input", () => {
    state.smoothM = +smooth.value;
    smoothOut();
  });
  smooth.addEventListener("change", () => {
    store.save();
    if (!file) rebuild();
  });

  const size = $("output-size");
  size.value = state.output.choice;
  $("custom-size").hidden = state.output.choice !== "custom";
  $("out-w").value = state.output.w;
  $("out-h").value = state.output.h;
  const setOutput = () => {
    state.output = { choice: size.value, w: +$("out-w").value || 2880, h: +$("out-h").value || 1800 };
    $("custom-size").hidden = size.value !== "custom";
    store.save();
    updateFrame();
  };
  size.addEventListener("change", setOutput);
  $("out-w").addEventListener("change", setOutput);
  $("out-h").addEventListener("change", setOutput);
  $("show-frame").checked = state.showFrame;
  $("show-frame").addEventListener("change", (e) => {
    state.showFrame = e.target.checked;
    store.save();
    updateFrame();
  });
  $("create").addEventListener("click", createWallpaper);
  $("export-close").addEventListener("click", () => $("export").close());
  $("download-theme").addEventListener("click", () => {
    if (!exportTheme) return;
    const url = URL.createObjectURL(new Blob([themeToToml(exportTheme)], { type: "application/toml" }));
    el("a", { href: url, download: "theme.toml" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("copy-cli").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("export-cli").textContent);
      toast("Copied the commands");
    } catch {
      toast("Clipboard unavailable: select the text and copy it", true);
    }
  });

  $("file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) await openFile(f);
    e.target.value = "";
  });
  $("file-close").addEventListener("click", closeFile);
  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
    e.preventDefault();
    depth++;
    $("drop-hint").hidden = false;
  });
  document.addEventListener("dragleave", () => {
    if (--depth <= 0) $("drop-hint").hidden = true;
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    $("drop-hint").hidden = true;
    const f = e.dataTransfer.files[0];
    if (f) await openFile(f);
  });

  wireSources();

  $("forget").addEventListener("click", () => {
    try {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem("topowall.recentColors");
    } catch {
      /* nothing stored */
    }
    toast("Settings forgotten. They'll stay forgotten unless you change something.");
  });
}

function wireSources() {
  const eSel = $("elevation-source"), sSel = $("search-source");
  eSel.replaceChildren(...ELEVATION_SOURCES.map((s) => new Option(s.name, s.id)), new Option("Custom tile URL…", "custom"));
  sSel.replaceChildren(...SEARCH_SOURCES.map((s) => new Option(s.name, s.id)), new Option("Custom service…", "custom"));
  $("elevation-encoding").replaceChildren(...Object.entries(ENCODINGS).map(([k, v]) => new Option(v.name, k)));
  eSel.value = state.elevation.id;
  sSel.value = state.search.id;
  if (state.elevation.id === "custom") {
    $("elevation-url").value = state.elevation.url;
    $("elevation-encoding").value = state.elevation.encoding;
    $("elevation-maxzoom").value = state.elevation.maxZoom;
  }
  if (state.search.id === "custom") {
    $("search-url").value = state.search.url;
    $("search-kind").value = state.search.kind;
  }
  $("elevation-custom").hidden = eSel.value !== "custom";
  $("search-custom").hidden = sSel.value !== "custom";

  const httpsUrl = (value) => {
    const u = new URL(value);
    if (u.protocol !== "https:") throw new Error("the address must start with https://");
    return u;
  };
  eSel.addEventListener("change", () => {
    $("elevation-custom").hidden = eSel.value !== "custom";
    if (eSel.value === "custom") return;
    state.elevation = { id: eSel.value };
    sourcesChanged();
  });
  $("elevation-apply").addEventListener("click", () => {
    const err = $("elevation-error");
    try {
      const url = $("elevation-url").value.trim();
      httpsUrl(url.replace(/\{[xyz]\}/g, "0"));
      if (!["{z}", "{x}", "{y}"].every((k) => url.includes(k))) throw new Error("the URL needs {z}, {x} and {y}");
      const maxZoom = Math.max(0, Math.min(20, Math.round(+$("elevation-maxzoom").value || 15)));
      state.elevation = { id: "custom", url, encoding: $("elevation-encoding").value, maxZoom };
      err.hidden = true;
      $("elevation-url").removeAttribute("aria-invalid");
      sourcesChanged();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      $("elevation-url").setAttribute("aria-invalid", "true");
    }
  });
  sSel.addEventListener("change", () => {
    $("search-custom").hidden = sSel.value !== "custom";
    if (sSel.value === "custom") return;
    state.search = { id: sSel.value };
    sourcesChanged();
  });
  $("search-apply").addEventListener("click", () => {
    const err = $("search-error");
    try {
      const url = $("search-url").value.trim();
      httpsUrl(url);
      state.search = { id: "custom", url, kind: $("search-kind").value };
      err.hidden = true;
      $("search-url").removeAttribute("aria-invalid");
      sourcesChanged();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      $("search-url").setAttribute("aria-invalid", "true");
    }
  });
}

function sourcesChanged() {
  store.save();
  renderSources();
  tiles.clear();
  built = null;
  if (!file) rebuild();
}

function wireSearch() {
  const input = $("search");
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (activeResult >= 0) chooseResult(activeResult);
    else runSearch();
  });
  $("search-go").addEventListener("click", runSearch);
  input.addEventListener("keydown", (e) => {
    if (!results.length) {
      if (e.key === "Escape") showResults([]);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      activeResult = (activeResult + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      [...$("results").children].forEach((li, i) => li.setAttribute("aria-selected", String(i === activeResult)));
      input.setAttribute("aria-activedescendant", `result-${activeResult}`);
    } else if (e.key === "Escape") {
      showResults([]);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".searchbar")) showResults([]);
  });
}

async function init() {
  canvas = $("canvas");
  try {
    renderer = new ContourRenderer(canvas);
    builder = new TerrainBuilder(renderer.gl);
  } catch (err) {
    const box = $("map-error");
    box.replaceChildren(el("strong", { textContent: "This browser can't draw the map" }), el("div", { className: "hint", textContent: err.message }));
    box.hidden = false;
    return;
  }

  palettes = (await fetch("data/palettes.json").then((r) => r.json())).palettes;
  myThemes = loadThemes();

  const saved = store.load();
  if (saved) {
    for (const k of ["scheme", "style", "background", "custom", "swatchTarget", "auto", "interval", "indexEvery", "smoothM", "output", "showFrame", "elevation", "search"]) {
      if (saved[k] !== undefined && saved[k] !== null) state[k] = saved[k];
    }
    if (saved.custom === null) state.custom = null;
  }
  // Drop settings that no longer make sense.
  if (state.elevation.id !== "custom" && !ELEVATION_SOURCES.some((s) => s.id === state.elevation.id)) state.elevation = { id: ELEVATION_SOURCES[0].id };
  if (state.search.id !== "custom" && !SEARCH_SOURCES.some((s) => s.id === state.search.id)) state.search = { id: SEARCH_SOURCES[0].id };

  const hash = readHash();
  if (hash.colors) {
    const { kind, name, style, background } = hash.colors;
    const exists = kind === "palette" ? palettes.some((p) => p.name === name) : myThemes.some((t) => t.id === name);
    if (exists) {
      state.scheme = { kind, name };
      if (style && ["subtle", "vivid", "mono"].includes(style)) state.style = style;
      if (background && ["palette", "black"].includes(background)) state.background = background;
      state.custom = null;
    }
  }
  if (hash.colors?.kind === "mine" && !myThemes.some((t) => t.id === hash.colors.name)) {
    toast("That link uses a theme saved in someone else's browser, so its colors can't be shown here");
  }
  if (state.scheme.kind === "palette" ? !palettes.some((p) => p.name === state.scheme.name) : !myThemes.some((t) => t.id === state.scheme.name)) {
    state.scheme = { kind: "palette", name: palettes.some((p) => p.name === "rose-pine") ? "rose-pine" : palettes[0].name };
    state.custom = null;
  }
  if (!["background", "lines", "index"].includes(state.swatchTarget)) state.swatchTarget = "lines";

  sizeCanvas();
  const v = hash.view;
  state.view = v && Math.abs(v.lat) <= 85 && Math.abs(v.lon) <= 180 && v.mpp > 0
    ? { lat: v.lat, lon: v.lon, mpp: Math.max(MIN_MPP, Math.min(MAX_MPP, v.mpp)) }
    : { lat: DEFAULT_VIEW.lat, lon: DEFAULT_VIEW.lon, mpp: (DEFAULT_VIEW.km * 1000) / canvas.width };

  syncColorsUI();
  renderSources();
  wireMap();
  wirePanel();
  wireSearch();
  window.addEventListener("hashchange", () => {
    const h = readHash();
    if (h.view && Math.abs(h.view.lat - state.view.lat) + Math.abs(h.view.lon - state.view.lon) > 1e-4) {
      setView(h.view.lat, h.view.lon, h.view.mpp);
    }
  });
  rebuild();
  $("map").focus({ preventScroll: true });
  // Hooks for the browser tests (web/test).
  window.__topowall = { state, get built() { return built; }, get exportBlob() { return exportBlob; }, rebuild, draw: drawNow };
}

init();
