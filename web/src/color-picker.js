// <topo-color-picker> and <topo-color-input>: a dependency-free color picker.
//
//   <topo-color-input value="#3e5d58" alpha></topo-color-input>
//
// <topo-color-input> is a swatch button that opens the picker in a popover.
// <topo-color-picker> is the panel itself, for embedding directly.
//
// Both expose `.value` (hex string, #rrggbb or #rrggbbaa) and fire:
//   "input"  – continuously while the color changes (drag, typing)
//   "change" – when a color is committed (release, Enter, Apply)
// event.detail = { hex, rgba, hsv, oklch }

import {
  clamp, hexToRgba, rgbaToHex, rgbToHsv, hsvToRgb, rgbToOklch, formatOklch, parseColor,
} from "./color.js";

// Styles are attached as constructed style sheets rather than <style> elements,
// so pages with a strict Content-Security-Policy (no inline styles) can use the picker.
const sheets = new Map();
function sheet(css) {
  if (!sheets.has(css)) {
    const s = new CSSStyleSheet();
    s.replaceSync(css);
    sheets.set(css, s);
  }
  return sheets.get(css);
}

const RECENT_KEY = "topowall.recentColors";
const RECENT_MAX = 12;

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((c) => hexToRgba(c)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(hex) {
  try {
    const list = [hex, ...loadRecent().filter((c) => c !== hex)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: recent colors just aren't remembered */
  }
}

const WHEEL = 232;        // wheel diameter (px)
const RING = 22;          // hue ring thickness (px)
const GAP = 8;            // space between ring and square (px)
const SQUARE = Math.floor((WHEEL - 2 * RING - 2 * GAP) / Math.SQRT2);

const STYLE = `
:host {
  --tp-bg: #16181d;
  --tp-surface: #1f2229;
  --tp-border: rgba(255, 255, 255, 0.09);
  --tp-text: #e6e8ec;
  --tp-muted: #8b919c;
  --tp-accent: #7aa2f7;
  --tp-radius: 14px;
  color-scheme: dark;
  font: 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--tp-text);
  display: inline-block;
}
@media (prefers-color-scheme: light) {
  :host(:not([theme="dark"])) {
    --tp-bg: #ffffff; --tp-surface: #f2f3f5; --tp-border: rgba(0, 0, 0, 0.1);
    --tp-text: #1d2025; --tp-muted: #626873; --tp-accent: #2f6fe4;
    color-scheme: light;
  }
}
:host([theme="light"]) {
  --tp-bg: #ffffff; --tp-surface: #f2f3f5; --tp-border: rgba(0, 0, 0, 0.1);
  --tp-text: #1d2025; --tp-muted: #626873; --tp-accent: #2f6fe4;
  color-scheme: light;
}
.panel {
  width: ${WHEEL + 32}px;
  box-sizing: border-box;
  padding: 16px;
  background: var(--tp-bg);
  border: 1px solid var(--tp-border);
  border-radius: var(--tp-radius);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.25);
  display: grid;
  gap: 12px;
  user-select: none;
}
.checker {
  background-image:
    linear-gradient(45deg, #8884 25%, transparent 25%, transparent 75%, #8884 75%),
    linear-gradient(45deg, #8884 25%, transparent 25%, transparent 75%, #8884 75%);
  background-size: 10px 10px;
  background-position: 0 0, 5px 5px;
  background-color: #fff;
}

/* Wheel: hue ring with a saturation/brightness square inside */
.wheel { position: relative; width: ${WHEEL}px; height: ${WHEEL}px; margin: 0 auto; touch-action: none; }
.ring {
  position: absolute; inset: 0; border-radius: 50%;
  background: conic-gradient(from 0deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  -webkit-mask: radial-gradient(circle, transparent ${WHEEL / 2 - RING}px, #000 ${WHEEL / 2 - RING + 0.5}px);
          mask: radial-gradient(circle, transparent ${WHEEL / 2 - RING}px, #000 ${WHEEL / 2 - RING + 0.5}px);
  cursor: crosshair;
}
.square {
  position: absolute; width: ${SQUARE}px; height: ${SQUARE}px;
  left: ${(WHEEL - SQUARE) / 2}px; top: ${(WHEEL - SQUARE) / 2}px;
  border-radius: 4px; cursor: crosshair;
  background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, var(--hue-color));
  outline: none;
}
.handle {
  position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px;
  border-radius: 50%; box-sizing: border-box; pointer-events: none;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(0, 0, 0, 0.35);
  background: var(--handle-color);
}
.ring-handle { width: ${RING - 2}px; height: ${RING - 2}px; margin: ${-(RING - 2) / 2}px 0 0 ${-(RING - 2) / 2}px; }
.focus-target { position: absolute; outline: none; }
.focus-target:focus-visible + .handle, .square:focus-visible .handle {
  box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 0 0 4px var(--tp-accent);
}

/* Alpha slider */
.alpha { position: relative; height: 14px; border-radius: 7px; cursor: pointer; touch-action: none; outline: none; }
.alpha-fill { position: absolute; inset: 0; border-radius: 7px; background: linear-gradient(to right, transparent, var(--opaque-color)); }
.alpha .handle { top: 7px; }
.alpha:focus-visible .handle { box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 0 0 4px var(--tp-accent); }

/* Preview + hex row */
.row { display: flex; align-items: center; gap: 8px; }
.preview {
  width: 44px; height: 44px; flex: none; border-radius: 8px; overflow: hidden;
  border: 1px solid var(--tp-border); display: grid; grid-template-rows: 1fr 1fr;
}
.preview > div { position: relative; }
.preview > div > span { position: absolute; inset: 0; }
.preview .current { cursor: pointer; }
.preview .current[hidden] { display: none; }
.preview.single { grid-template-rows: 1fr; }
.hex-wrap { flex: 1; display: grid; gap: 4px; }
label, .label { color: var(--tp-muted); font-size: 10.5px; letter-spacing: 0.02em; }
input {
  width: 100%; box-sizing: border-box; min-width: 0;
  font: 12px/1 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  color: var(--tp-text); background: var(--tp-surface);
  border: 1px solid var(--tp-border); border-radius: 7px; padding: 7px 8px;
  outline: none; transition: border-color .12s, box-shadow .12s;
}
input:focus { border-color: var(--tp-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-accent) 25%, transparent); }
input.invalid { border-color: #e5484d; box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.2); }
.icon-btn {
  width: 32px; height: 32px; flex: none; display: grid; place-items: center;
  border-radius: 8px; border: 1px solid var(--tp-border); background: var(--tp-surface);
  color: var(--tp-text); cursor: pointer; padding: 0;
}
.icon-btn:hover { border-color: var(--tp-accent); }
.icon-btn:focus-visible { outline: 2px solid var(--tp-accent); outline-offset: 1px; }
.icon-btn[hidden] { display: none; }

/* Numeric fields */
.fields { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.field { display: grid; gap: 3px; text-align: center; }
.field input { text-align: center; padding: 6px 2px; }
.field.empty { visibility: hidden; }

/* Swatches */
.swatches { display: flex; flex-wrap: wrap; gap: 6px; min-height: 18px; }
.swatches[hidden] { display: none; }
.swatch {
  width: 18px; height: 18px; border-radius: 5px; padding: 0; cursor: pointer; position: relative; overflow: hidden;
  border: 1px solid var(--tp-border);
}
.swatch > span { position: absolute; inset: 0; }
.swatch:focus-visible { outline: 2px solid var(--tp-accent); outline-offset: 1px; }

.actions { display: flex; justify-content: flex-end; gap: 8px; }
.actions[hidden] { display: none; }
.btn {
  font: 500 12px system-ui, sans-serif; padding: 7px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--tp-border); background: var(--tp-surface); color: var(--tp-text);
}
.btn.primary { background: var(--tp-accent); border-color: transparent; color: #fff; }
.btn:focus-visible { outline: 2px solid var(--tp-accent); outline-offset: 1px; }
.focus-target.ring-focus { width: 1px; height: 1px; opacity: 0; padding: 0; border: 0; }
`;

const TEMPLATE = `
<div class="panel" part="panel" role="group" aria-label="Color picker">
  <div class="wheel">
    <div class="ring" part="ring"></div>
    <button class="focus-target ring-focus" role="slider" aria-label="Hue" aria-valuemin="0" aria-valuemax="360"></button>
    <div class="handle ring-handle"></div>
    <div class="square" part="square" tabindex="0" role="slider" aria-label="Saturation and brightness">
      <div class="handle sv-handle"></div>
    </div>
  </div>

  <div class="alpha checker" tabindex="0" role="slider" aria-label="Opacity" aria-valuemin="0" aria-valuemax="100">
    <div class="alpha-fill"></div>
    <div class="handle alpha-handle"></div>
  </div>

  <div class="row">
    <div class="preview" part="preview" title="New color (top) / current color (bottom, click to restore)">
      <div class="checker"><span class="new"></span></div>
      <div class="checker current-wrap"><span class="current"></span></div>
    </div>
    <div class="hex-wrap">
      <label for="hex">Hex</label>
      <input id="hex" class="hex" spellcheck="false" autocomplete="off" maxlength="9" aria-label="Hex color">
    </div>
    <button class="icon-btn eyedropper" type="button" title="Pick a color from the screen" aria-label="Eyedropper" hidden>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>
    </button>
  </div>

  <div class="fields">
    <div class="field"><label for="h">H°</label><input id="h" data-ch="h" inputmode="numeric"></div>
    <div class="field"><label for="s">S%</label><input id="s" data-ch="s" inputmode="numeric"></div>
    <div class="field"><label for="v">B%</label><input id="v" data-ch="v" inputmode="numeric"></div>
    <div class="field alpha-field"><label for="a">A%</label><input id="a" data-ch="a" inputmode="numeric"></div>
    <div class="field"><label for="r">R</label><input id="r" data-ch="r" inputmode="numeric"></div>
    <div class="field"><label for="g">G</label><input id="g" data-ch="g" inputmode="numeric"></div>
    <div class="field"><label for="b">B</label><input id="b" data-ch="b" inputmode="numeric"></div>
    <div class="field empty"></div>
  </div>

  <div class="hex-wrap">
    <label for="oklch">OKLCH</label>
    <input id="oklch" class="oklch" spellcheck="false" autocomplete="off" aria-label="OKLCH color">
  </div>

  <div class="swatches" aria-label="Recent colors"></div>

  <div class="actions">
    <button class="btn cancel" type="button">Cancel</button>
    <button class="btn primary apply" type="button">Apply</button>
  </div>
</div>
`;

const CHANNELS = {
  h: { max: 360, step: 1, big: 15 },
  s: { max: 100, step: 1, big: 10 },
  v: { max: 100, step: 1, big: 10 },
  a: { max: 100, step: 1, big: 10 },
  r: { max: 255, step: 1, big: 16 },
  g: { max: 255, step: 1, big: 16 },
  b: { max: 255, step: 1, big: 16 },
};

export class TopoColorPicker extends HTMLElement {
  static observedAttributes = ["value", "alpha", "actions", "theme"];

  #hsv = { h: 0, s: 0, v: 0 };
  #alpha = 1;
  #initial = "#000000";
  #els = {};

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [sheet(STYLE)];
    root.innerHTML = TEMPLATE;
    const $ = (sel) => root.querySelector(sel);
    this.#els = {
      wheel: $(".wheel"), ring: $(".ring"), ringFocus: $(".ring-focus"), ringHandle: $(".ring-handle"),
      square: $(".square"), svHandle: $(".sv-handle"),
      alpha: $(".alpha"), alphaHandle: $(".alpha-handle"), alphaField: $(".alpha-field"),
      preview: $(".preview"), newSwatch: $(".new"), current: $(".current"), currentWrap: $(".current-wrap"),
      hex: $(".hex"), oklch: $(".oklch"), eyedropper: $(".eyedropper"),
      fields: [...root.querySelectorAll("[data-ch]")],
      swatches: $(".swatches"), actions: $(".actions"), apply: $(".apply"), cancel: $(".cancel"),
    };
    this.#wire();
    this.#setFromHex(this.getAttribute("value") || "#3e5d58", { emit: false, initial: true });
  }

  connectedCallback() {
    this.#applyAttributes();
    this.#renderSwatches();
  }

  attributeChangedCallback(name, _old, val) {
    if (name === "value" && val && val.toLowerCase() !== this.value) {
      this.#setFromHex(val, { emit: false, initial: true });
    }
    this.#applyAttributes();
  }

  // ── Public API ──

  get value() {
    return rgbaToHex({ ...hsvToRgb(this.#hsv), a: this.hasAttribute("alpha") ? this.#alpha : 1 });
  }

  set value(hex) {
    this.#setFromHex(hex, { emit: false, initial: true });
  }

  /** Mark the current value as committed (becomes the "current" preview). */
  commit() {
    this.#initial = this.value;
    saveRecent(this.value);
    this.#renderSwatches();
    this.#update();
    this.#emit("change");
  }

  /** Restore the last committed value. */
  revert() {
    this.#setFromHex(this.#initial, { emit: true });
  }

  focusWheel() {
    this.#els.square.focus();
  }

  // ── State ──

  #applyAttributes() {
    const alpha = this.hasAttribute("alpha");
    this.#els.alpha.hidden = !alpha;
    this.#els.alpha.style.display = alpha ? "" : "none";
    this.#els.alphaField.classList.toggle("empty", !alpha);
    this.#els.actions.hidden = !this.hasAttribute("actions");
    this.#els.eyedropper.hidden = !("EyeDropper" in window);
  }

  /** Set from any color string. Keeps hue for grays and saturation for black so handles don't jump. */
  #setFromHex(str, { emit, initial = false }) {
    const rgba = parseColor(str);
    if (!rgba) return false;
    const hsv = rgbToHsv(rgba);
    this.#hsv = {
      h: Number.isNaN(hsv.h) ? this.#hsv.h : hsv.h,
      s: Number.isNaN(hsv.s) ? this.#hsv.s : hsv.s,
      v: hsv.v,
    };
    this.#alpha = rgba.a;
    if (initial) this.#initial = this.value;
    this.#update();
    if (emit) this.#emit("input");
    return true;
  }

  #setHsv(patch, emit = true) {
    this.#hsv = { ...this.#hsv, ...patch };
    this.#update();
    if (emit) this.#emit("input");
  }

  #emit(type) {
    const rgb = hsvToRgb(this.#hsv);
    const detail = {
      hex: this.value,
      rgba: { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b), a: this.#alpha },
      hsv: { ...this.#hsv },
      oklch: formatOklch(rgbToOklch(rgb)),
    };
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  // ── Rendering ──

  #update(skip) {
    const { h, s, v } = this.#hsv;
    const rgb = hsvToRgb(this.#hsv);
    const opaque = rgbaToHex(rgb);
    const hex = this.value;
    const e = this.#els;

    // Hue ring handle: hue 0 at the top, increasing clockwise (matches the conic gradient).
    const r = WHEEL / 2 - RING / 2;
    const rad = (h * Math.PI) / 180;
    const hx = WHEEL / 2 + r * Math.sin(rad);
    const hy = WHEEL / 2 - r * Math.cos(rad);
    e.ringHandle.style.left = `${hx}px`;
    e.ringHandle.style.top = `${hy}px`;
    e.ringHandle.style.setProperty("--handle-color", `hsl(${h} 100% 50%)`);
    e.ringFocus.style.left = `${hx}px`;
    e.ringFocus.style.top = `${hy}px`;
    e.ringFocus.setAttribute("aria-valuenow", Math.round(h));

    // Saturation / brightness square.
    e.square.style.setProperty("--hue-color", `hsl(${h} 100% 50%)`);
    e.svHandle.style.left = `${s * SQUARE}px`;
    e.svHandle.style.top = `${(1 - v) * SQUARE}px`;
    e.svHandle.style.setProperty("--handle-color", opaque);
    e.square.setAttribute("aria-valuetext", `saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`);

    // Alpha.
    e.alpha.style.setProperty("--opaque-color", opaque);
    const aw = e.alpha.clientWidth || WHEEL;
    e.alphaHandle.style.left = `${this.#alpha * aw}px`;
    e.alphaHandle.style.setProperty("--handle-color", hex);
    e.alpha.setAttribute("aria-valuenow", Math.round(this.#alpha * 100));

    // Preview: new on top, committed below (hidden when identical).
    e.newSwatch.style.background = hex;
    e.current.style.background = this.#initial;
    const same = hex === this.#initial;
    e.currentWrap.hidden = same;
    e.currentWrap.style.display = same ? "none" : "";
    e.preview.classList.toggle("single", same);

    // Text fields (don't overwrite the one being typed in).
    const vals = {
      h: Math.round(h) % 360, s: Math.round(s * 100), v: Math.round(v * 100), a: Math.round(this.#alpha * 100),
      r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b),
    };
    for (const f of e.fields) {
      if (f !== skip) f.value = vals[f.dataset.ch];
      f.classList.remove("invalid");
    }
    if (e.hex !== skip) {
      e.hex.value = hex;
      e.hex.classList.remove("invalid");
    }
    if (e.oklch !== skip) {
      e.oklch.value = formatOklch(rgbToOklch(rgb));
      e.oklch.classList.remove("invalid");
    }
  }

  #renderSwatches() {
    const list = loadRecent();
    const box = this.#els.swatches;
    box.hidden = list.length === 0;
    box.replaceChildren(
      ...list.map((hex) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "swatch checker";
        b.title = hex;
        b.setAttribute("aria-label", `Use ${hex}`);
        const fill = document.createElement("span");
        fill.style.background = hex;
        b.append(fill);
        b.addEventListener("click", () => this.#setFromHex(hex, { emit: true }));
        return b;
      }),
    );
  }

  // ── Interaction ──

  #wire() {
    const e = this.#els;

    // Drag on the wheel: the ring sets hue, the square sets saturation/brightness.
    let mode = null;
    const center = WHEEL / 2;
    const local = (ev) => {
      const rect = e.wheel.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const dragTo = (ev) => {
      const { x, y } = local(ev);
      if (mode === "hue") {
        const deg = (Math.atan2(x - center, -(y - center)) * 180) / Math.PI;
        this.#setHsv({ h: (deg + 360) % 360 });
      } else if (mode === "sv") {
        const off = (WHEEL - SQUARE) / 2;
        this.#setHsv({ s: clamp((x - off) / SQUARE, 0, 1), v: clamp(1 - (y - off) / SQUARE, 0, 1) });
      }
    };
    e.wheel.addEventListener("pointerdown", (ev) => {
      const { x, y } = local(ev);
      const dist = Math.hypot(x - center, y - center);
      const off = (WHEEL - SQUARE) / 2;
      if (dist >= center - RING - 2 && dist <= center + 1) {
        mode = "hue";
        e.ringFocus.focus({ preventScroll: true });
      } else if (x >= off - 6 && x <= off + SQUARE + 6 && y >= off - 6 && y <= off + SQUARE + 6) {
        mode = "sv";
        e.square.focus({ preventScroll: true });
      } else {
        return;
      }
      ev.preventDefault();
      e.wheel.setPointerCapture(ev.pointerId);
      dragTo(ev);
    });
    e.wheel.addEventListener("pointermove", (ev) => mode && dragTo(ev));
    const endDrag = () => {
      if (mode) {
        mode = null;
        this.#emit("change");
      }
    };
    e.wheel.addEventListener("pointerup", endDrag);
    e.wheel.addEventListener("pointercancel", endDrag);

    // Alpha slider drag.
    let alphaDrag = false;
    const alphaTo = (ev) => {
      const rect = e.alpha.getBoundingClientRect();
      this.#alpha = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
      this.#update();
      this.#emit("input");
    };
    e.alpha.addEventListener("pointerdown", (ev) => {
      alphaDrag = true;
      e.alpha.setPointerCapture(ev.pointerId);
      e.alpha.focus({ preventScroll: true });
      alphaTo(ev);
    });
    e.alpha.addEventListener("pointermove", (ev) => alphaDrag && alphaTo(ev));
    e.alpha.addEventListener("pointerup", () => {
      alphaDrag = false;
      this.#emit("change");
    });

    // Keyboard: arrows on the square, ring and alpha (Shift = bigger steps).
    const keyStep = (ev) => (ev.shiftKey ? 10 : 1);
    e.square.addEventListener("keydown", (ev) => {
      const d = keyStep(ev) / 100;
      const { s, v } = this.#hsv;
      const moves = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
      if (!moves[ev.key]) return;
      ev.preventDefault();
      this.#setHsv({ s: clamp(s + moves[ev.key][0], 0, 1), v: clamp(v + moves[ev.key][1], 0, 1) });
    });
    e.ringFocus.addEventListener("keydown", (ev) => {
      const d = ev.shiftKey ? 15 : 1;
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[ev.key];
      if (!dir) return;
      ev.preventDefault();
      this.#setHsv({ h: (this.#hsv.h + dir * d + 360) % 360 });
    });
    e.alpha.addEventListener("keydown", (ev) => {
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[ev.key];
      if (!dir) return;
      ev.preventDefault();
      this.#alpha = clamp(this.#alpha + (dir * keyStep(ev)) / 100, 0, 1);
      this.#update();
      this.#emit("input");
    });

    // Hex and OKLCH text inputs: apply as soon as the text is a valid color.
    for (const input of [e.hex, e.oklch]) {
      input.addEventListener("input", () => {
        const ok = this.#setFromHexKeepField(input);
        input.classList.toggle("invalid", !ok && input.value.trim() !== "");
      });
      input.addEventListener("blur", () => this.#update());
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          this.#update();
          this.#emit("change");
        }
      });
    }

    // Numeric channel fields.
    for (const f of e.fields) {
      const ch = f.dataset.ch;
      const spec = CHANNELS[ch];
      const applyChannel = (num) => {
        if (Number.isNaN(num)) return false;
        const n = ch === "h" ? ((num % 360) + 360) % 360 : clamp(num, 0, spec.max);
        if (ch === "h" || ch === "s" || ch === "v") {
          this.#hsv = { ...this.#hsv, [ch]: ch === "h" ? n : n / 100 };
        } else if (ch === "a") {
          this.#alpha = n / 100;
        } else {
          const rgb = hsvToRgb(this.#hsv);
          rgb[ch] = n;
          const hsv = rgbToHsv(rgb);
          this.#hsv = {
            h: Number.isNaN(hsv.h) ? this.#hsv.h : hsv.h,
            s: Number.isNaN(hsv.s) ? this.#hsv.s : hsv.s,
            v: hsv.v,
          };
        }
        this.#update(f);
        this.#emit("input");
        return true;
      };
      f.addEventListener("input", () => {
        const ok = f.value.trim() === "" || applyChannel(parseFloat(f.value));
        f.classList.toggle("invalid", !ok);
      });
      f.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
          ev.preventDefault();
          const cur = parseFloat(f.value) || 0;
          const d = (ev.shiftKey ? spec.big : spec.step) * (ev.key === "ArrowUp" ? 1 : -1);
          applyChannel(ch === "h" ? cur + d : clamp(cur + d, 0, spec.max));
          this.#update();
        } else if (ev.key === "Enter") {
          this.#update();
          this.#emit("change");
        }
      });
      f.addEventListener("blur", () => this.#update());
      f.addEventListener("focus", () => f.select());
    }

    // Preview: click the "current" half to restore it.
    e.currentWrap.addEventListener("click", () => this.revert());

    // Eyedropper (Chromium-based browsers).
    e.eyedropper.addEventListener("click", async () => {
      try {
        const { sRGBHex } = await new window.EyeDropper().open();
        this.#setFromHex(sRGBHex, { emit: true });
        this.#emit("change");
      } catch {
        /* cancelled */
      }
    });

    e.apply.addEventListener("click", () => this.commit());
    e.cancel.addEventListener("click", () => {
      this.revert();
      this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    });
  }

  #setFromHexKeepField(input) {
    const rgba = parseColor(input.value);
    if (!rgba) return false;
    // A hex without alpha keeps the current opacity only when alpha editing is off.
    const hsv = rgbToHsv(rgba);
    this.#hsv = {
      h: Number.isNaN(hsv.h) ? this.#hsv.h : hsv.h,
      s: Number.isNaN(hsv.s) ? this.#hsv.s : hsv.s,
      v: hsv.v,
    };
    this.#alpha = rgba.a;
    this.#update(input);
    this.#emit("input");
    return true;
  }
}

// ── <topo-color-input>: swatch button + popover ─────────────────────────────

const INPUT_STYLE = `
:host { display: inline-flex; align-items: center; gap: 8px; font: 12px system-ui, sans-serif; }
.trigger {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  padding: 4px 10px 4px 4px; border-radius: 9px;
  border: 1px solid var(--tp-border, rgba(127,127,127,.35));
  background: var(--tp-surface, transparent); color: inherit;
  font: 12px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
}
.trigger:focus-visible { outline: 2px solid var(--tp-accent, #7aa2f7); outline-offset: 2px; }
.chip { width: 22px; height: 22px; border-radius: 6px; position: relative; overflow: hidden; box-shadow: inset 0 0 0 1px rgba(127,127,127,.4);
  background-image: linear-gradient(45deg,#8884 25%,transparent 25%,transparent 75%,#8884 75%),linear-gradient(45deg,#8884 25%,transparent 25%,transparent 75%,#8884 75%);
  background-size: 8px 8px; background-position: 0 0,4px 4px; background-color: #fff; }
.chip > span { position: absolute; inset: 0; }
.pop { position: fixed; z-index: 2147483000; }
.pop[hidden] { display: none; }
`;

export class TopoColorInput extends HTMLElement {
  static observedAttributes = ["value", "alpha", "theme"];

  #els = {};
  #onDocPointer = (ev) => {
    if (!this.#els.pop.hidden && !ev.composedPath().includes(this)) this.close(false);
  };
  #onKey = (ev) => {
    if (this.#els.pop.hidden) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.close(false);
    } else if (ev.key === "Enter" && !(ev.composedPath()[0] instanceof HTMLButtonElement)) {
      this.close(true);
    }
  };
  #reposition = () => this.#place();

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [sheet(INPUT_STYLE)];
    root.innerHTML = `
      <button class="trigger" type="button" aria-haspopup="dialog" aria-expanded="false">
        <span class="chip"><span class="fill"></span></span><span class="text"></span>
      </button>
      <div class="pop" role="dialog" aria-label="Choose color" hidden>
        <topo-color-picker actions></topo-color-picker>
      </div>`;
    const $ = (s) => root.querySelector(s);
    this.#els = { trigger: $(".trigger"), fill: $(".fill"), text: $(".text"), pop: $(".pop"), picker: $("topo-color-picker") };

    const { trigger, picker } = this.#els;
    picker.value = this.getAttribute("value") || "#3e5d58";
    this.#sync();
    trigger.addEventListener("click", () => (this.#els.pop.hidden ? this.open() : this.close(false)));
    picker.addEventListener("input", (ev) => {
      ev.stopPropagation();
      this.#sync();
      this.#emit("input", ev.detail);
    });
    picker.addEventListener("change", (ev) => {
      ev.stopPropagation();
      this.#sync();
    });
    picker.addEventListener("cancel", (ev) => {
      ev.stopPropagation();
      this.close(false);
    });
    root.querySelector(".pop").addEventListener("click", (ev) => {
      if (ev.composedPath().some((n) => n.classList?.contains("apply"))) this.close(true);
    });
  }

  get value() {
    return this.#els.picker.value;
  }

  set value(v) {
    this.#els.picker.value = v;
    this.#sync();
  }

  attributeChangedCallback(name, _old, val) {
    if (name === "value" && val) this.value = val;
    if (name === "alpha") this.#els.picker.toggleAttribute("alpha", val !== null);
    if (name === "theme") val === null ? this.#els.picker.removeAttribute("theme") : this.#els.picker.setAttribute("theme", val);
  }

  open() {
    const { pop, trigger, picker } = this.#els;
    this.#committed = picker.value;
    pop.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    this.#place();
    picker.focusWheel();
    document.addEventListener("pointerdown", this.#onDocPointer, true);
    document.addEventListener("keydown", this.#onKey, true);
    window.addEventListener("resize", this.#reposition);
    window.addEventListener("scroll", this.#reposition, true);
  }

  #committed = null;

  close(commit) {
    const { pop, trigger, picker } = this.#els;
    if (pop.hidden) return;
    if (commit) {
      picker.commit();
      this.#emit("change", { hex: picker.value });
    } else if (this.#committed && picker.value !== this.#committed) {
      picker.value = this.#committed;
      this.#emit("input", { hex: picker.value });
    }
    this.#sync();
    pop.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
    document.removeEventListener("pointerdown", this.#onDocPointer, true);
    document.removeEventListener("keydown", this.#onKey, true);
    window.removeEventListener("resize", this.#reposition);
    window.removeEventListener("scroll", this.#reposition, true);
  }

  #place() {
    const { pop, trigger } = this.#els;
    const t = trigger.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const margin = 8;
    let top = t.bottom + margin;
    if (top + p.height > innerHeight - margin && t.top - margin - p.height > margin) top = t.top - margin - p.height;
    const left = clamp(t.left, margin, Math.max(margin, innerWidth - p.width - margin));
    pop.style.top = `${clamp(top, margin, Math.max(margin, innerHeight - p.height - margin))}px`;
    pop.style.left = `${left}px`;
  }

  #sync() {
    const hex = this.#els.picker.value;
    this.#els.fill.style.background = hex;
    this.#els.text.textContent = hex;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

if (!customElements.get("topo-color-picker")) customElements.define("topo-color-picker", TopoColorPicker);
if (!customElements.get("topo-color-input")) customElements.define("topo-color-input", TopoColorInput);
