import { test } from "node:test";
import assert from "node:assert/strict";
import { planView } from "../src/terrain.js";

// mercPerDevPx from app.js: how the app turns metres-per-pixel into planView's input.
const mercPerDevPx = (mpp, lat, z = 0) =>
  ((mpp / 1000 / (111.32 * Math.cos((lat * Math.PI) / 180))) / 360) * 2 ** z * 256;

const MIN_MPP = 0.5, MAX_MPP = 40_000;

test("planView stays within a sane number of tiles across the app's whole zoom and latitude range", () => {
  for (const [w, h] of [[1440, 900], [2880, 1800], [3200, 1875], [1170, 2532], [5120, 2160]]) {
    for (const lat of [0, 37.7, 60, 80, 84, -84]) {
      // The app never lets a view get wider than two worlds (see setView/zoomAt).
      const widest = (2 * 40075016.686 * Math.cos((lat * Math.PI) / 180)) / w;
      for (let mpp = MIN_MPP; mpp <= Math.min(MAX_MPP, widest); mpp *= 1.2) {
        const p = planView({ lat, lon: -119.5, mercPerPx: mercPerDevPx(mpp, lat), widthPx: w, heightPx: h, maxZoom: 15 });
        assert.ok(p.cols > 0 && p.rows > 0, `${w}x${h} lat${lat} mpp${mpp}: cols/rows`);
        // Roughly one screen's worth of tiles: the zoom level is rounded to the
        // nearest power of two, so the tile grid can be up to sqrt(2) coarser
        // or finer than the screen, plus a one-tile margin on every side.
        const maxTiles = (Math.ceil((w * 1.5) / 256) + 3) * (Math.ceil((h * 1.5) / 256) + 3);
        assert.ok(p.cols * p.rows <= maxTiles, `${w}x${h} lat${lat} mpp${mpp}: ${p.cols}x${p.rows} tiles, expected at most ${maxTiles}`);
        for (const v of [p.x0, p.x1, p.y0, p.y1]) assert.ok(Number.isFinite(v));
      }
    }
  }
});

test("planView rejects an unreasonably large request instead of building a huge mosaic", () => {
  assert.throws(() => planView({ lat: 0, lon: 0, mercPerPx: 5000, widthPx: 4000, heightPx: 4000, maxZoom: 15 }), /too many tiles/);
});

test("planView handles latitudes near the poles without failing", () => {
  const p = planView({ lat: 84.9, lon: 0, mercPerPx: 1, widthPx: 1440, heightPx: 900, maxZoom: 15 });
  assert.ok(p.rows >= 1 && p.rows <= 2 ** p.z + 2);
});

test("a view genuinely wider than the world is rejected, not silently unbounded", () => {
  // At zoom 0 the whole world is one 256px tile; asking for a much wider view
  // than that must fail loudly rather than allocate an ever-growing mosaic.
  // (Rows alone would look small here since they're clamped to the world's
  // single row at zoom 0 — it's the column count that must still be caught.)
  assert.throws(() => planView({ lat: 0, lon: 0, mercPerPx: 2000, widthPx: 4000, heightPx: 4000, maxZoom: 15 }), /too many tiles/);
});
