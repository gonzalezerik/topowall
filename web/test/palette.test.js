import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromBase16, toTheme } from "../src/palette.js";

const catalog = JSON.parse(readFileSync(new URL("../../crates/kit/palettes/palettes.json", import.meta.url))).palettes;
// Written by scripts/web-presets.sh from `topowall theme --palette … --style … --background …`.
const expected = JSON.parse(readFileSync(new URL("./fixtures/palette-themes.json", import.meta.url)));

// Channel difference between two #rrggbb colors.
const diff = (a, b) => Math.max(...[1, 3, 5].map((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16))));

test("every built-in scheme gives the same theme colors as the CLI", () => {
  // JavaScript has no 32-bit cbrt/pow, so a result can land one step away in
  // the last bit and round to a neighbouring 8-bit value. Allow that, nothing more.
  const off = [];
  for (const [key, want] of Object.entries(expected)) {
    const [name, style, background] = key.split("|");
    const t = toTheme(fromBase16(catalog.find((p) => p.name === name)), { style, background });
    const got = [t.background, t.lines[0].color, t.lines[1].color];
    const worst = Math.max(...got.map((g, i) => diff(g, want[i])));
    assert.ok(worst <= 1, `${key}: ${got} != ${want}`);
    if (worst) off.push(key);
  }
  assert.ok(off.length <= 5, `${off.length} themes are one step off: ${off.join(", ")}`);
  assert.ok(Object.keys(expected).length >= 339 * 4);
});

test("theme names and spacing", () => {
  const t = toTheme(fromBase16(catalog.find((p) => p.name === "rose-pine")), { style: "vivid", interval: 50, indexEvery: 4 });
  assert.equal(t.name, "Rosé Pine (vivid)");
  assert.deepEqual(t.lines.map((l) => l.every), [50, 200]);
});
