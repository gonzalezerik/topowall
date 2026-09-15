import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCoordinates } from "../src/geocode.js";

const near = (got, lat, lon) => {
  assert.ok(got, "expected coordinates");
  assert.ok(Math.abs(got.lat - lat) < 1e-4 && Math.abs(got.lon - lon) < 1e-4, JSON.stringify(got));
};

test("decimal pairs", () => {
  near(parseCoordinates("37.738, -119.575"), 37.738, -119.575);
  near(parseCoordinates("37.738 -119.575"), 37.738, -119.575);
  near(parseCoordinates("  -33.8568,151.2153 "), -33.8568, 151.2153);
});

test("degrees, minutes, seconds and hemispheres", () => {
  near(parseCoordinates(`37°44'17"N 119°34'30"W`), 37 + 44 / 60 + 17 / 3600, -(119 + 34 / 60 + 30 / 3600));
  near(parseCoordinates("37.738 N, 119.575 W"), 37.738, -119.575);
  near(parseCoordinates("119.575W 37.738N"), 37.738, -119.575);
});

test("place names and out-of-range values are not coordinates", () => {
  for (const s of ["Yosemite", "Mount Rainier", "Route 66", "95, 200", "12", "Paris, France"]) {
    assert.equal(parseCoordinates(s), null, s);
  }
});
