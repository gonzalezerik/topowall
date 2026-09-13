import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hexToRgba, rgbaToHex, rgbToHsv, hsvToRgb, rgbToOklch, oklchToRgb, parseColor,
} from "../src/color.js";

test("hex round trips", () => {
  for (const h of ["#000000", "#ffffff", "#3e5d58", "#92aca0", "#00aeef", "#11223380"]) {
    assert.equal(rgbaToHex(hexToRgba(h)), h);
  }
  assert.equal(rgbaToHex(hexToRgba("fff")), "#ffffff");
  assert.equal(rgbaToHex(hexToRgba("#f008")), "#ff000088");
  assert.equal(hexToRgba("#12345"), null);
  assert.equal(hexToRgba("zzzzzz"), null);
});

test("hsv round trips every 8-bit gray and a color sweep", () => {
  for (let i = 0; i < 4096; i++) {
    const rgb = { r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 173) % 256 };
    const hsv = rgbToHsv(rgb);
    const back = hsvToRgb({ h: Number.isNaN(hsv.h) ? 0 : hsv.h, s: Number.isNaN(hsv.s) ? 0 : hsv.s, v: hsv.v });
    assert.equal(rgbaToHex(back), rgbaToHex(rgb), JSON.stringify(rgb));
  }
});

test("grays and black report undefined hue/saturation", () => {
  assert.ok(Number.isNaN(rgbToHsv({ r: 128, g: 128, b: 128 }).h));
  assert.ok(Number.isNaN(rgbToHsv({ r: 0, g: 0, b: 0 }).s));
});

test("primary hues", () => {
  assert.equal(Math.round(rgbToHsv({ r: 255, g: 0, b: 0 }).h), 0);
  assert.equal(Math.round(rgbToHsv({ r: 0, g: 255, b: 0 }).h), 120);
  assert.equal(Math.round(rgbToHsv({ r: 0, g: 0, b: 255 }).h), 240);
});

test("oklch matches the Rust renderer's conversion", () => {
  // Same fixture as crates/render/src/color.rs: #92aca0 survives an OKLCH round trip.
  const rgb = hexToRgba("#92aca0");
  assert.equal(rgbaToHex(oklchToRgb(rgbToOklch(rgb))), "#92aca0");
  const lch = rgbToOklch(parseColor("oklch(0.72 0.05 234)"));
  assert.ok(Math.abs(lch.l - 0.72) < 0.01 && Math.abs(lch.h - 234) < 1);
});

test("parseColor accepts css-style functions", () => {
  assert.equal(rgbaToHex(parseColor("rgb(62, 93, 88)")), "#3e5d58");
  assert.equal(rgbaToHex(parseColor("rgba(255 0 0 / 50%)")), "#ff000080");
  assert.equal(parseColor("oklch(nope)"), null);
});
