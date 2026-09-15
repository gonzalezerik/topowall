// Themes people make in the web app, kept in their browser's local storage.
// Nothing here leaves the device: backups are files the visitor saves and
// opens themselves.
//
// A saved theme: { id, name, theme: { background, lines: [...] }, swatches: ["#rrggbb", ...] }

import { parseColor } from "./color.js";

export const STORAGE_KEY = "topowall.myThemes";
const MAX_THEMES = 200;
const MAX_TIERS = 8;
const MAX_STOPS = 32;
const MAX_SWATCHES = 32;

const isColor = (c) => typeof c === "string" && c.length <= 64 && parseColor(c) !== null;
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** Check and copy one theme's colors and lines. Returns null if anything is off. */
function cleanTheme(t) {
  if (!t || typeof t !== "object" || !isColor(t.background) || !Array.isArray(t.lines)) return null;
  if (t.lines.length < 1 || t.lines.length > MAX_TIERS) return null;
  const lines = [];
  for (const l of t.lines) {
    if (!l || typeof l !== "object") return null;
    const every = num(l.every, 0.01, 100000);
    const width = num(l.width ?? 1.25, 0.05, 50);
    const opacity = num(l.opacity ?? 1, 0, 1);
    if (every === null || width === null || opacity === null) return null;
    let color;
    if (Array.isArray(l.color)) {
      if (l.color.length < 1 || l.color.length > MAX_STOPS) return null;
      color = [];
      for (const s of l.color) {
        const atOk = (typeof s?.at === "number" && Number.isFinite(s.at)) || (typeof s?.at === "string" && /^-?\d+(\.\d+)?%$/.test(s.at));
        if (!atOk || !isColor(s.color)) return null;
        color.push({ at: s.at, color: s.color });
      }
    } else if (isColor(l.color)) {
      color = l.color;
    } else {
      return null;
    }
    const tier = { every, width, color };
    if (opacity !== 1) tier.opacity = opacity;
    if (typeof l.offset === "number" && Number.isFinite(l.offset) && l.offset !== 0) tier.offset = l.offset;
    lines.push(tier);
  }
  return { background: t.background, lines };
}

/** Check and copy a saved theme. Returns null if it isn't valid. */
export function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  const theme = cleanTheme(e.theme);
  if (!theme) return null;
  const name = typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 60) : "Untitled";
  const id = typeof e.id === "string" && /^[a-z0-9-]{8,64}$/i.test(e.id) ? e.id : newId();
  const swatches = Array.isArray(e.swatches) ? [...new Set(e.swatches.filter(isColor).map((c) => c.toLowerCase()))].slice(0, MAX_SWATCHES) : [];
  return { id, name, theme: { name, ...theme }, swatches };
}

export function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Saved themes from storage (invalid entries are dropped). */
export function loadThemes(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(list) ? list.map(cleanEntry).filter(Boolean).slice(0, MAX_THEMES) : [];
  } catch {
    return [];
  }
}

/** Save the list. Returns false if the browser won't store it. */
export function saveThemes(list, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_THEMES)));
    return true;
  } catch {
    return false;
  }
}

/** A backup file's contents. */
export function exportThemes(list) {
  return JSON.stringify({ topowall: "themes", version: 1, themes: list }, null, 2) + "\n";
}

/**
 * Read a backup file. Imported themes get fresh ids so they never replace existing ones.
 * @returns {{themes: Array, skipped: number}}
 */
export function importThemes(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("this file isn't a topowall theme backup (not JSON)");
  }
  const raw = Array.isArray(data) ? data : data?.topowall === "themes" && Array.isArray(data.themes) ? data.themes : null;
  if (!raw) throw new Error("this file isn't a topowall theme backup");
  const themes = [];
  let skipped = 0;
  for (const e of raw.slice(0, MAX_THEMES)) {
    const c = cleanEntry({ ...e, id: undefined });
    if (c) themes.push(c);
    else skipped++;
  }
  return { themes, skipped: skipped + Math.max(0, raw.length - MAX_THEMES) };
}
