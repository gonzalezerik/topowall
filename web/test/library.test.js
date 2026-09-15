import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEntry, exportThemes, importThemes, loadThemes, saveThemes, STORAGE_KEY } from "../src/library.js";

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), raw: m };
};

const sample = {
  id: "0f6b1d7e-1111-4222-8333-944455556666",
  name: "Night trail",
  theme: { background: "#101418", lines: [{ every: 20, width: 1.25, color: "#3e5d58" }, { every: 100, width: 1.8, color: "#92aca0" }] },
  swatches: ["#101418", "#3E5D58", "#3e5d58", "not-a-color"],
};

test("save and load round trip, cleaning swatches", () => {
  const s = memory();
  assert.ok(saveThemes([cleanEntry(sample)], s));
  const [t] = loadThemes(s);
  assert.equal(t.name, "Night trail");
  assert.equal(t.id, sample.id);
  assert.deepEqual(t.swatches, ["#101418", "#3e5d58"]);
  assert.equal(t.theme.lines[1].color, "#92aca0");
});

test("invalid or hostile entries are dropped", () => {
  const s = memory();
  s.setItem(STORAGE_KEY, JSON.stringify([
    sample,
    { name: "no lines", theme: { background: "#000", lines: [] } },
    { name: "bad color", theme: { background: "url(javascript:alert(1))", lines: [{ every: 20, color: "#fff" }] } },
    { name: "bad number", theme: { background: "#000", lines: [{ every: -5, color: "#fff" }] } },
    { name: "<img src=x onerror=alert(1)>", theme: { background: "#000", lines: [{ every: 20, color: "#fff" }] }, extra: "ignored" },
  ]));
  const list = loadThemes(s);
  assert.equal(list.length, 2);
  assert.equal(list[1].name, "<img src=x onerror=alert(1)>"); // kept as plain text; the app only ever sets textContent
  assert.equal(list[1].extra, undefined);
});

test("broken storage gives an empty list", () => {
  const s = memory();
  s.setItem(STORAGE_KEY, "{not json");
  assert.deepEqual(loadThemes(s), []);
});

test("backups import with fresh ids", () => {
  const { themes, skipped } = importThemes(exportThemes([cleanEntry(sample), { name: "x" }]));
  assert.equal(themes.length, 1);
  assert.equal(skipped, 1);
  assert.notEqual(themes[0].id, sample.id);
  assert.throws(() => importThemes("hello"), /not JSON/);
  assert.throws(() => importThemes('{"a":1}'), /isn't a topowall theme backup/);
});
