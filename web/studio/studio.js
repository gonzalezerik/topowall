// topowall studio: live theme editing on a real heightmap.

import "../src/color-picker.js";
import { parseTopo } from "../src/topo.js";
import { ContourRenderer } from "../src/renderer-webgl.js";
import { autoInterval, cloneTheme, indexEvery, resolveTheme, setSpacing, themeToToml } from "../src/theme.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "topowall.studio";
const SAMPLE = { url: "assets/yosemite.topo", name: "yosemite.topo" };

const state = {
  hm: null,
  mapName: SAMPLE.name,
  presets: [],
  presetId: null,
  theme: null,
  output: { w: 2880, h: 1800 },
  outputChoice: "screen",
  auto: false,
  actual: false,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

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
      const { presetId, theme, outputChoice, output, auto } = state;
      localStorage.setItem(STORE_KEY, JSON.stringify({ presetId, theme, outputChoice, output, auto }));
    } catch {
      /* storage unavailable */
    }
  },
};

let toastTimer;
function toast(msg, error = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 5000 : 1800);
}

// Interval slider is logarithmic: 0..1000 → 1..1000 m.
const sliderToMetres = (v) => {
  const m = 10 ** ((3 * v) / 1000);
  return m < 10 ? Math.round(m * 2) / 2 : Math.round(m);
};
const metresToSlider = (m) => Math.round((Math.log10(Math.max(1, m)) / 3) * 1000);
const fmt = (m) => (Number.isInteger(m) ? `${m}` : m.toFixed(1));

function screenSize() {
  const dpr = window.devicePixelRatio || 1;
  return { w: Math.round(screen.width * dpr), h: Math.round(screen.height * dpr) };
}

function outputTexPerPx() {
  const { hm, output } = state;
  return Math.min(hm.width / output.w, hm.height / output.h);
}

// ── Rendering ───────────────────────────────────────────────────────────────

let renderer;
let frame = 0;

function scheduleRender() {
  if (!frame) frame = requestAnimationFrame(renderNow);
}

function renderNow() {
  frame = 0;
  if (!state.hm || !state.theme) return;
  const canvas = $("canvas");
  const wrap = $("canvas-wrap");
  const dpr = window.devicePixelRatio || 1;
  const { w: ow, h: oh } = state.output;
  const maxSize = Math.min(renderer.maxTextureSize, 8192);

  let cw, ch;
  if (state.actual) {
    const s = Math.min(1, maxSize / Math.max(ow, oh));
    cw = Math.round(ow * s);
    ch = Math.round(oh * s);
    canvas.style.width = `${cw / dpr}px`;
    canvas.style.height = `${ch / dpr}px`;
  } else {
    const availW = wrap.clientWidth - 32;
    const availH = wrap.clientHeight - 32;
    const s = Math.min(availW / ow, availH / oh);
    const cssW = Math.max(1, Math.floor(ow * s));
    const cssH = Math.max(1, Math.floor(oh * s));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    cw = Math.min(maxSize, Math.round(cssW * dpr));
    ch = Math.min(maxSize, Math.round(cssH * dpr));
  }
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }

  // Preview is the output scaled by k: scale line widths the same way.
  const k = cw / ow;
  const resolved = resolveTheme(state.theme, state.hm.min, state.hm.max);
  for (const t of resolved.tiers) t.width *= k;

  const t0 = performance.now();
  renderer.setTheme(resolved);
  renderer.render();
  const ms = performance.now() - t0;
  $("stage-status").textContent =
    `Preview ${cw}×${ch} · ${Math.round(k * 100)}% of ${ow}×${oh}` + (ms > 1 ? ` · ${ms.toFixed(0)} ms` : "");
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

function tierLabel(i, every) {
  if (i === 0) return `Lines every ${fmt(every)} m`;
  if (i === 1) return `Index lines every ${fmt(every)} m`;
  return `Tier ${i + 1} every ${fmt(every)} m`;
}

function sliderRow(label, min, max, step, value, onInput, format = (v) => v) {
  const row = document.createElement("label");
  row.className = "slider-row";
  const name = document.createElement("span");
  name.textContent = label;
  const input = Object.assign(document.createElement("input"), { type: "range", min, max, step, value });
  const out = document.createElement("output");
  out.textContent = format(+value);
  input.addEventListener("input", () => {
    out.textContent = format(+input.value);
    onInput(+input.value);
  });
  row.append(name, input, out);
  return row;
}

function colorInput(value, onInput) {
  const el = document.createElement("topo-color-input");
  el.setAttribute("alpha", "");
  el.value = value;
  el.addEventListener("input", () => onInput(el.value));
  el.addEventListener("change", () => onInput(el.value));
  return el;
}

function buildTiers() {
  const box = $("tiers");
  box.replaceChildren();
  state.theme.lines.forEach((tier, i) => {
    const card = document.createElement("div");
    card.className = "tier";
    const title = document.createElement("div");
    title.className = "tier-title";
    title.textContent = tierLabel(i, tier.every);
    title.dataset.tier = i;
    card.append(title);

    if (Array.isArray(tier.color)) {
      tier.color.forEach((stop) => {
        const row = document.createElement("div");
        row.className = "stop";
        const at = Object.assign(document.createElement("input"), {
          type: "text", value: stop.at, className: "at", title: "Elevation in metres, or a percentage like 50%",
        });
        at.setAttribute("aria-label", "Stop position");
        at.style.cssText = "font:12px ui-monospace,monospace;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:5px 6px";
        at.addEventListener("change", () => {
          const v = at.value.trim();
          stop.at = /%$/.test(v) ? v : Number.isFinite(parseFloat(v)) ? parseFloat(v) : stop.at;
          at.value = stop.at;
          changed();
        });
        row.append(colorInput(stop.color, (v) => { stop.color = v; changed(false); }), at);
        card.append(row);
      });
    } else {
      const row = document.createElement("div");
      row.className = "field-head";
      const label = document.createElement("span");
      label.className = "dim";
      label.textContent = "Color";
      row.append(label, colorInput(tier.color, (v) => { tier.color = v; changed(false); }));
      card.append(row);
    }

    card.append(
      sliderRow("Width", 0.25, 6, 0.05, tier.width ?? 1.25, (v) => { tier.width = v; changed(false); }, (v) => `${v.toFixed(2)}px`),
      sliderRow("Opacity", 0, 1, 0.01, tier.opacity ?? 1, (v) => { tier.opacity = v; changed(false); }, (v) => `${Math.round(v * 100)}%`),
    );
    box.append(card);
  });
}

function syncSpacingUI() {
  const lines = state.theme.lines;
  const base = lines[0]?.every ?? 20;
  $("interval").value = metresToSlider(base);
  if (document.activeElement !== $("interval-num")) $("interval-num").value = fmt(base);
  $("auto").setAttribute("aria-pressed", String(state.auto));
  const n = indexEvery(state.theme);
  const hasIndex = n !== null;
  for (const id of ["index-every", "index-dec", "index-inc"]) $(id).disabled = !hasIndex;
  $("index-every").value = hasIndex ? n : "";
  $("index-hint").textContent = hasIndex ? `Every ${n}th line is drawn as an index line (${fmt(lines[1].every)} m).` : "This theme has a single line tier.";
  document.querySelectorAll(".tier-title").forEach((el) => {
    const i = +el.dataset.tier;
    el.textContent = tierLabel(i, lines[i].every);
  });
}

function syncExport() {
  const toml = themeToToml(state.theme);
  $("toml").textContent = toml;
  const { w, h } = state.output;
  const lines = [];
  const e = state.hm?.extent;
  if (e) {
    const lat = (e.north + e.south) / 2;
    const lon = (e.east + e.west) / 2;
    const widthKm = (e.east - e.west) * 111.32 * Math.cos((lat * Math.PI) / 180);
    const mapW = Math.round(widthKm * 100) / 100;
    lines.push(`topowall fetch --center ${lat.toFixed(4)},${lon.toFixed(4)} --width-km ${mapW} --size ${w}x${h} -o map.topo`);
  }
  lines.push(`topowall render ${e ? "map.topo" : state.mapName} --theme theme.toml --size ${w}x${h} -o wallpaper.png`);
  $("cli").textContent = lines.join("\n");
}

/** Call after any theme change. `structural` rebuilds the tier cards. */
function changed(structural = false) {
  if (structural) buildTiers();
  syncSpacingUI();
  syncExport();
  store.save();
  scheduleRender();
}

function applyInterval(m, { fromAuto = false } = {}) {
  if (!(m > 0)) return;
  if (!fromAuto) state.auto = false;
  setSpacing(state.theme, Math.min(1000, Math.max(0.5, m)));
  changed();
}

function applyAuto() {
  if (!state.auto || !state.hm) return;
  applyInterval(autoInterval(state.hm, outputTexPerPx(), 6), { fromAuto: true });
}

function loadPreset(id) {
  const p = state.presets.find((x) => x.id === id) ?? state.presets[0];
  state.presetId = p.id;
  state.theme = cloneTheme(p.theme);
  $("preset").value = p.id;
  $("background").value = state.theme.background ?? "#000000";
  if (state.auto) applyAuto();
  changed(true);
}

function setOutput(choice) {
  state.outputChoice = choice;
  $("custom-size").hidden = choice !== "custom";
  if (choice === "screen") state.output = screenSize();
  else if (choice === "custom") state.output = { w: +$("out-w").value || 2880, h: +$("out-h").value || 1800 };
  else {
    const [w, h] = choice.split("x").map(Number);
    state.output = { w, h };
  }
  applyAuto();
  syncExport();
  store.save();
  scheduleRender();
}

async function loadMap(buffer, name) {
  try {
    const hm = await parseTopo(buffer);
    renderer.setHeightmap(hm);
    state.hm = hm;
    state.mapName = name;
    const km = hm.mPerPx ? ` · ${((hm.width * hm.mPerPx) / 1000).toFixed(1)} × ${((hm.height * hm.mPerPx) / 1000).toFixed(1)} km` : "";
    $("map-info").textContent = `${name} · ${hm.width}×${hm.height}${km} · ${Math.round(hm.min)}–${Math.round(hm.max)} m` +
      (hm.source ? ` · ${hm.source}` : "");
    applyAuto();
    syncExport();
    scheduleRender();
  } catch (err) {
    toast(`Couldn't open ${name}: ${err.message}`, true);
  }
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`);
  } catch {
    toast("Clipboard unavailable — select the text and copy it", true);
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

async function init() {
  try {
    renderer = new ContourRenderer($("canvas"));
  } catch (err) {
    $("map-info").textContent = err.message;
    return;
  }

  state.presets = await (await fetch("presets.json")).json();
  const select = $("preset");
  for (const group of ["Themes", "Palettes"]) {
    const og = document.createElement("optgroup");
    og.label = group;
    for (const p of state.presets.filter((x) => x.group === group)) {
      og.append(new Option(p.label, p.id));
    }
    select.append(og);
  }

  const saved = store.load();
  await customElements.whenDefined("topo-color-input");
  if (saved?.theme?.lines?.length) {
    state.presetId = saved.presetId;
    state.theme = saved.theme;
    state.auto = !!saved.auto;
    select.value = saved.presetId ?? "";
    $("background").value = state.theme.background ?? "#000000";
  } else {
    loadPreset("theme--3e5d58-92aca0");
  }
  if (saved?.outputChoice) {
    $("output-size").value = saved.outputChoice;
    if (saved.outputChoice === "custom") {
      $("out-w").value = saved.output.w;
      $("out-h").value = saved.output.h;
    }
  }
  setOutput($("output-size").value);
  changed(true);

  select.addEventListener("change", () => loadPreset(select.value));
  $("output-size").addEventListener("change", (e) => setOutput(e.target.value));
  for (const id of ["out-w", "out-h"]) $(id).addEventListener("change", () => setOutput("custom"));

  $("interval").addEventListener("input", (e) => applyInterval(sliderToMetres(+e.target.value)));
  $("interval-num").addEventListener("change", (e) => applyInterval(parseFloat(e.target.value)));
  $("interval-num").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyInterval(parseFloat(e.target.value));
  });
  $("auto").addEventListener("click", () => {
    state.auto = !state.auto;
    if (state.auto) applyAuto();
    else changed();
  });

  const setIndex = (n) => {
    if (!(n >= 1)) return;
    setSpacing(state.theme, state.theme.lines[0].every, Math.min(50, Math.round(n)));
    changed();
  };
  $("index-every").addEventListener("change", (e) => setIndex(+e.target.value));
  $("index-dec").addEventListener("click", () => setIndex((indexEvery(state.theme) ?? 2) - 1));
  $("index-inc").addEventListener("click", () => setIndex((indexEvery(state.theme) ?? 0) + 1));

  $("background").addEventListener("input", (e) => {
    state.theme.background = e.target.value;
    changed();
  });

  $("actual").addEventListener("change", (e) => {
    state.actual = e.target.checked;
    $("canvas-wrap").classList.toggle("actual", state.actual);
    scheduleRender();
  });

  $("copy-toml").addEventListener("click", () => copy(themeToToml(state.theme), "theme"));
  $("copy-cli").addEventListener("click", () => copy($("cli").textContent, "command"));
  $("download-toml").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([themeToToml(state.theme)], { type: "application/toml" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "theme.toml" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $("file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) await loadMap(await f.arrayBuffer(), f.name);
    e.target.value = "";
  });
  const stage = $("stage");
  let depth = 0;
  stage.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    $("drop-hint").hidden = false;
  });
  stage.addEventListener("dragleave", () => {
    if (--depth <= 0) $("drop-hint").hidden = true;
  });
  stage.addEventListener("dragover", (e) => e.preventDefault());
  stage.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    $("drop-hint").hidden = true;
    const f = e.dataTransfer.files[0];
    if (f) await loadMap(await f.arrayBuffer(), f.name);
  });

  new ResizeObserver(scheduleRender).observe($("canvas-wrap"));
  window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.("change", scheduleRender);

  await loadMap(await (await fetch(SAMPLE.url)).arrayBuffer(), SAMPLE.name);

  // Test hooks: ?preset=<id>&interval=<m>&index=<n>&auto=1&output=<WxH>
  const q = new URLSearchParams(location.search);
  if (q.get("output")) {
    $("output-size").value = q.get("output");
    setOutput(q.get("output"));
  }
  if (q.get("preset")) loadPreset(q.get("preset"));
  if (q.get("interval")) applyInterval(+q.get("interval"));
  if (q.get("index")) setIndex(+q.get("index"));
  if (q.get("auto")) $("auto").click();
  window.__studio = { state, renderNow };
}

init();
