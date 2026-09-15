// Place search. Coordinates are read locally; place names go to the search
// service the visitor has selected, straight from their browser.

/** Search services. All use OpenStreetMap data (© OpenStreetMap contributors, ODbL). */
export const SEARCH_SOURCES = [
  {
    id: "nominatim",
    name: "Nominatim (OpenStreetMap)",
    kind: "nominatim",
    url: "https://nominatim.openstreetmap.org",
    about: "https://operations.osmfoundation.org/policies/nominatim/",
    privacy: "https://osmfoundation.org/wiki/Privacy_Policy",
  },
  {
    id: "photon",
    name: "Photon (komoot)",
    kind: "photon",
    url: "https://photon.komoot.io",
    about: "https://photon.komoot.io/",
    privacy: "https://www.komoot.com/privacy",
  },
  { id: "off", name: "Off (coordinates only)", kind: "off" },
];

// ── Coordinates ─────────────────────────────────────────────────────────────

const NUM = String.raw`[-+]?\d+(?:[.,]\d+)?`;

/** One latitude or longitude written as decimal degrees or degrees/minutes/seconds, with an optional N/S/E/W. */
function parseAngle(text) {
  const t = text.trim().toUpperCase().replace(/[′’']/g, "'").replace(/[″”"]/g, '"');
  const hemi = t.match(/[NSEW]/)?.[0];
  const nums = [...t.matchAll(new RegExp(NUM, "g"))].map((m) => parseFloat(m[0].replace(",", ".")));
  if (!nums.length || nums.length > 3) return null;
  const [d, m = 0, s = 0] = nums;
  if (m < 0 || m >= 60 || s < 0 || s >= 60) return null;
  let v = Math.abs(d) + m / 60 + s / 3600;
  if (d < 0 || t.trim().startsWith("-")) v = -v;
  if (hemi === "S" || hemi === "W") v = -Math.abs(v);
  return { value: v, hemi };
}

/**
 * Read "lat, lon" in decimal or DMS form ("37.738, -119.575", "37°44'17"N 119°34'30"W").
 * Returns null if the text isn't a coordinate pair.
 */
export function parseCoordinates(text) {
  const t = text.trim();
  if (!/\d/.test(t) || /[A-DF-MO-RT-VX-Z]/i.test(t.replace(/[NSEW]/gi, ""))) return null;
  let parts = t.split(/\s*[,;]\s*|\s*\/\s*/).filter(Boolean);
  if (parts.length !== 2) {
    // "37.7 -119.5" or "37°44'N 119°34'W": split where a new angle starts.
    const m = t.match(new RegExp(String.raw`^(.+?[NS]?)\s+([-+]?\d.*)$`, "i"));
    parts = m ? [m[1], m[2]] : [];
  }
  if (parts.length !== 2) return null;
  let [a, b] = parts.map(parseAngle);
  if (!a || !b) return null;
  // Honour hemisphere letters if they say the order is lon, lat.
  if ((a.hemi === "E" || a.hemi === "W") && (b.hemi === "N" || b.hemi === "S")) [a, b] = [b, a];
  const [lat, lon] = [a.value, b.value];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// ── Services ────────────────────────────────────────────────────────────────

let lastRequest = 0;

/**
 * Search for places. One request per call, at most one per second (both public
 * services ask for that), never while typing.
 * @returns {Promise<Array<{name:string, detail:string, lat:number, lon:number, bbox?:[number,number,number,number]}>>}
 *   bbox is [west, south, east, north].
 */
export async function searchPlaces(query, source, { signal, language } = {}) {
  if (source.kind === "off") return [];
  const wait = lastRequest + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const base = source.url.replace(/\/+$/, "");
  // Send only this site's origin as the referrer: the services ask apps to identify
  // themselves, and the page path or view never leaves the browser.
  const opts = { credentials: "omit", referrerPolicy: "strict-origin", signal };

  if (source.kind === "nominatim") {
    const u = new URL(`${base}/search`);
    u.search = new URLSearchParams({ q: query, format: "jsonv2", limit: "8", ...(language ? { "accept-language": language } : {}) });
    const res = await fetch(u, opts);
    if (!res.ok) throw new Error(`${u.host} answered ${res.status}`);
    return (await res.json()).map((r) => {
      const [s, n, w, e] = r.boundingbox.map(Number);
      const [name, ...rest] = r.display_name.split(", ");
      return { name, detail: rest.join(", "), lat: +r.lat, lon: +r.lon, bbox: [w, s, e, n], kind: r.type };
    });
  }
  if (source.kind === "photon") {
    const u = new URL(`${base}/api/`);
    // Photon only accepts a few languages, as two-letter codes.
    const lang = language?.slice(0, 2).toLowerCase();
    u.search = new URLSearchParams({ q: query, limit: "8", ...(["en", "de", "fr"].includes(lang) ? { lang } : {}) });
    const res = await fetch(u, opts);
    if (!res.ok) throw new Error(`${u.host} answered ${res.status}`);
    return (await res.json()).features.map(({ geometry, properties: p }) => {
      const detail = [p.city, p.county, p.state, p.country].filter((x) => x && x !== p.name).join(", ");
      // Photon extents are [west, north, east, south].
      const bbox = p.extent ? [p.extent[0], p.extent[3], p.extent[2], p.extent[1]] : undefined;
      return { name: p.name ?? detail, detail, lat: geometry.coordinates[1], lon: geometry.coordinates[0], bbox, kind: p.osm_value };
    });
  }
  throw new Error(`unknown search service '${source.kind}'`);
}
