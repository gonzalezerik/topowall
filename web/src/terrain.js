// Elevation for any area, built in the browser: the same steps as
// crates/core/src/fetch.rs (tile choice, stitching, Catmull-Rom resampling,
// Gaussian smoothing), with resampling and smoothing done on the GPU.
//
// Tiles are downloaded by the visitor's browser straight from the selected
// elevation source and kept in memory only.

import { decodePng, rgbOf } from "./png.js";

const TILE = 256;

/** Elevation tile sources. `{z}/{x}/{y}` are filled in per tile. */
export const ELEVATION_SOURCES = [
  {
    id: "aws-terrain-tiles",
    name: "AWS Terrain Tiles",
    url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    encoding: "terrarium",
    maxZoom: 15,
    about: "https://registry.opendata.aws/terrain-tiles/",
    attribution: "Elevation: AWS Terrain Tiles",
    datasets: "USGS 3DEP, SRTM, GMTED2010, ETOPO1 and other public datasets",
  },
];

/** Metres from tile values, per encoding. */
export const ENCODINGS = {
  terrarium: { name: "Terrarium", decode: (r, g, b) => r * 256 + g + b / 256 - 32768 },
  "terrain-rgb": { name: "Terrain-RGB", decode: (r, g, b) => -10000 + (r * 65536 + g * 256 + b) * 0.1 },
};

// ── Planning (mirrors fetch.rs) ─────────────────────────────────────────────

/** Global Web Mercator pixel coordinates at a zoom level. */
export function mercatorPx(lon, lat, zoom) {
  const n = 2 ** zoom * TILE;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return [x, y];
}

/** Inverse of mercatorPx. */
export function lonLatOf(x, y, zoom) {
  const n = 2 ** zoom * TILE;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/**
 * Work out tiles and sampling for an area, exactly like `topowall fetch`.
 * @param {{lat:number, lon:number, widthKm:number, widthPx:number, heightPx:number, zoom?:number, maxZoom?:number, maxTiles?:number}} r
 */
export function plan(r) {
  const { lat, lon, widthKm, widthPx: w, heightPx: h } = r;
  if (!(w > 0 && h > 0 && widthKm > 0)) throw new Error("width, height and width-km must be positive");
  if (Math.abs(lat) > 85) throw new Error("latitude must be within ±85°");
  const maxZoom = r.maxZoom ?? 15;
  const mPerPx = (widthKm * 1000) / w;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const autoZoom = Math.min(maxZoom, Math.max(0, Math.round(Math.log2((156543.034 * cosLat) / mPerPx))));
  const z = Math.min(r.zoom ?? autoZoom, maxZoom);

  const dlon = widthKm / (111.32 * cosLat);
  const dlat = (widthKm * h) / w / 110.57;
  const extent = { west: lon - dlon / 2, east: lon + dlon / 2, south: lat - dlat / 2, north: lat + dlat / 2 };
  if (extent.north > 85.05 || extent.south < -85.05 || dlon > 360) {
    throw new Error("this area reaches past the edge of the map (about 85° north or south); zoom in or make it smaller");
  }
  const [x0, y0] = mercatorPx(extent.west, extent.north, z);
  const [x1, y1] = mercatorPx(extent.east, extent.south, z);
  const n = 2 ** z;
  // One tile of margin for the bicubic kernel.
  const tx0 = Math.floor(x0 / TILE) - 1;
  const tx1 = Math.floor(x1 / TILE) + 1;
  const ty0 = Math.max(0, Math.floor(y0 / TILE) - 1);
  const ty1 = Math.min(n - 1, Math.floor(y1 / TILE) + 1);
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const maxTiles = r.maxTiles ?? 1500;
  if (cols * rows > maxTiles) {
    throw new Error(`this area needs ${cols * rows} tiles at zoom ${z} (limit ${maxTiles}); try a smaller area`);
  }
  return { z, w, h, mPerPx, extent, x0, y0, x1, y1, tx0, ty0, cols, rows };
}

/**
 * Tiles and sampling for what's on screen, in Web Mercator like any web map.
 * Unlike `plan` (which matches `topowall fetch`), this works at every zoom,
 * including views wider or taller than the world.
 * @param {{lat:number, lon:number, mercPerPx:number, widthPx:number, heightPx:number, maxZoom?:number}} r
 *   mercPerPx: Web Mercator pixels at zoom 0 per output pixel.
 */
export function planView(r) {
  const { lat, lon, mercPerPx, widthPx: w, heightPx: h } = r;
  if (!(w > 0 && h > 0 && mercPerPx > 0)) throw new Error("the map view needs a size");
  const maxZoom = r.maxZoom ?? 15;
  // Tile zoom whose pixels are closest to screen pixels.
  const z = Math.min(maxZoom, Math.max(0, Math.round(-Math.log2(mercPerPx))));
  const n = 2 ** z;
  const m = mercPerPx * n;
  const [cx, cy] = mercatorPx(lon, Math.max(-85.05, Math.min(85.05, lat)), z);
  const x0 = cx - (w / 2) * m, x1 = cx + (w / 2) * m;
  const y0 = cy - (h / 2) * m, y1 = cy + (h / 2) * m;
  const tx0 = Math.floor(x0 / TILE) - 1;
  const tx1 = Math.floor(x1 / TILE) + 1;
  // Rows outside the world repeat its top or bottom tiles (sampling clamps to the edge).
  const ty0 = Math.min(n - 1, Math.max(0, Math.floor(y0 / TILE) - 1));
  const ty1 = Math.max(ty0, Math.min(n - 1, Math.floor(y1 / TILE) + 1));
  const earth = 40075016.686;
  const mPerPx = (mercPerPx / TILE) * earth * Math.cos((lat * Math.PI) / 180);
  const [west, north] = lonLatOf(x0, Math.max(0, y0), z);
  const [east, south] = lonLatOf(x1, Math.min(n * TILE, y1), z);
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  // Guards against a caller asking for an unreasonably wide or tall mosaic (this
  // shouldn't happen from the app's own UI, which keeps mercPerPx in a sane
  // range, but a page must not trust its own state that much). Checked in
  // pixels, not tile count: at low zoom `rows` is naturally capped to the
  // world's own tile count near the poles, which would let a very wide,
  // short request slip past a tile-count-only check.
  if (cols * TILE > 20_000 || rows * TILE > 20_000) {
    throw new Error(`this view needs too many tiles (${cols}x${rows} at zoom ${z}); zoom in a little`);
  }
  return { z, w, h, mPerPx, extent: { west, east, south, north }, x0, y0, x1, y1, tx0, ty0, cols, rows };
}

// ── Tiles ───────────────────────────────────────────────────────────────────

export class TileCache {
  constructor(limit = 400) {
    this.limit = limit;
    this.map = new Map();
    this.inflight = new Map();
  }

  #key(source, z, x, y) {
    return `${source.url}|${source.encoding}|${z}/${x}/${y}`;
  }

  /**
   * Elevations (metres) of one 256×256 tile. Downloads are shared between callers
   * and always finish (the result is cached), so one caller giving up can't fail another.
   */
  async get(source, z, x, y) {
    const key = this.#key(source, z, x, y);
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    if (!this.inflight.has(key)) {
      const url = source.url.replace("{z}", z).replace("{x}", x).replace("{y}", y);
      const job = (async () => {
        // Retry brief network hiccups and busy servers; give up on anything else.
        let res;
        for (let attempt = 0; ; attempt++) {
          try {
            res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
            if (res.ok || !(res.status === 429 || res.status >= 500) || attempt >= 3) break;
          } catch (err) {
            if (attempt >= 3) throw new Error(`couldn't reach ${new URL(url).host} (${err.message})`);
          }
          await new Promise((done) => setTimeout(done, 250 * 2 ** attempt));
        }
        if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} for tile ${z}/${x}/${y}`);
        const png = await decodePng(await res.arrayBuffer());
        if (png.width !== TILE || png.height !== TILE) throw new Error(`tile ${z}/${x}/${y} is ${png.width}×${png.height}, expected 256×256`);
        const rgb = rgbOf(png);
        const decode = ENCODINGS[source.encoding].decode;
        const data = new Float32Array(TILE * TILE);
        for (let i = 0; i < data.length; i++) data[i] = decode(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
        return data;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    const data = await this.inflight.get(key);
    this.map.set(key, data);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return data;
  }

  clear() {
    this.map.clear();
  }
}

/**
 * Download the plan's tiles and stitch them into one mosaic (cols×256 by rows×256).
 * @returns {Promise<Float32Array>}
 */
export async function loadMosaic(p, source, cache, { signal, onProgress, concurrency = 8 } = {}) {
  const n = 2 ** p.z;
  const mw = p.cols * TILE;
  const mosaic = new Float32Array(mw * p.rows * TILE);
  const jobs = [];
  for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) jobs.push([c, r]);
  let done = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      if (signal?.aborted) throw new DOMException("The map moved before the elevation finished loading", "AbortError");
      const [c, r] = jobs[next++];
      const x = (((p.tx0 + c) % n) + n) % n;
      const tile = await cache.get(source, p.z, x, p.ty0 + r);
      for (let ty = 0; ty < TILE; ty++) {
        mosaic.set(tile.subarray(ty * TILE, (ty + 1) * TILE), (r * TILE + ty) * mw + c * TILE);
      }
      onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return mosaic;
}

// ── GPU resampling and smoothing ────────────────────────────────────────────

const QUAD = `#version 300 es
void main() {
  vec2 xy = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(xy * 2.0 - 1.0, 0.0, 1.0);
}`;

// Catmull-Rom sampling of the mosaic at each output cell (resample.rs `sample_bicubic`).
const RESAMPLE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_src;
uniform vec2 u_offset;   // mosaic coordinate of output cell (0, 0), minus 0.5
uniform vec2 u_step;     // mosaic cells per output cell
out vec4 outColor;

vec4 weights(float t) {
  float t2 = t * t, t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}

void main() {
  // Framebuffer row y is texture row y, so texel row 0 is the north edge.
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 s = u_offset + u_step * (cell + 0.5);
  vec2 i = floor(s);
  vec4 wx = weights(s.x - i.x), wy = weights(s.y - i.y);
  ivec2 size = textureSize(u_src, 0);
  float acc = 0.0;
  for (int y = 0; y < 4; y++) {
    float row = 0.0;
    for (int x = 0; x < 4; x++) {
      ivec2 p = clamp(ivec2(i) + ivec2(x - 1, y - 1), ivec2(0), size - 1);
      row += wx[x] * texelFetch(u_src, p, 0).r;
    }
    acc += wy[y] * row;
  }
  outColor = vec4(acc, 0.0, 0.0, 1.0);
}`;

// One direction of a separable Gaussian with mirrored edges (resample.rs `gaussian_blur`).
const BLUR = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_src;
uniform sampler2D u_kernel;   // weights, R32F, 2 * radius + 1 wide
uniform int u_radius;
uniform bool u_vertical;
out vec4 outColor;

int reflectIndex(int i, int n) {
  if (n == 1) return 0;
  int period = 2 * n;
  i = ((i % period) + period) % period;
  return i >= n ? period - 1 - i : i;
}

void main() {
  ivec2 size = textureSize(u_src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float acc = 0.0;
  for (int j = 0; j <= 2 * u_radius; j++) {
    float k = texelFetch(u_kernel, ivec2(j, 0), 0).r;
    ivec2 q = u_vertical ? ivec2(p.x, reflectIndex(p.y + j - u_radius, size.y))
                         : ivec2(reflectIndex(p.x + j - u_radius, size.x), p.y);
    acc += k * texelFetch(u_src, q, 0).r;
  }
  outColor = vec4(acc, 0.0, 0.0, 1.0);
}`;

// Elevation and gradient on a coarse grid, for automatic spacing (spacing.rs
// `auto_interval` samples the same points) and the elevation range.
const SUMMARY = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_src;
uniform int u_step;
out vec4 outColor;

float h(int x, int y) { return texelFetch(u_src, ivec2(x, y), 0).r; }

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int x = 1 + c.x * u_step, y = 1 + c.y * u_step;
  outColor = vec4(h(x, y), h(x + 1, y) - h(x - 1, y), h(x, y + 1) - h(x, y - 1), 1.0);
}`;

const NICE = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

function gaussianKernel(sigma) {
  const radius = Math.ceil(4 * sigma);
  const k = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    k[i + radius] = Math.fround(Math.exp(-(i * i) / (2 * sigma * sigma)));
    sum = Math.fround(sum + k[i + radius]);
  }
  for (let i = 0; i < k.length; i++) k[i] = Math.fround(k[i] / sum);
  return k;
}

export class TerrainBuilder {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("this browser's WebGL can't render to float textures (EXT_color_buffer_float)");
    }
    this.gl = gl;
    this.resample = this.#program(RESAMPLE, ["u_src", "u_offset", "u_step"]);
    this.blur = this.#program(BLUR, ["u_src", "u_kernel", "u_radius", "u_vertical"]);
    this.summaryProgram = this.#program(SUMMARY, ["u_src", "u_step"]);
    this.vao = gl.createVertexArray();
    this.fbo = gl.createFramebuffer();
  }

  get maxSize() {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
  }

  #program(fs, names) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, QUAD));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return { p, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)])) };
  }

  #floatTexture(w, h, data = null) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    }
    return t;
  }

  #pass({ p, u }, target, w, h, bind) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    bind(u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Resample and smooth a mosaic into the planned heightmap, on the GPU.
   * Row 0 of the result (texel y = 0) is the north edge, like a .topo file.
   * @returns {{texture:WebGLTexture, width:number, height:number}}
   */
  build(p, mosaic, smoothM = 18.75) {
    const gl = this.gl;
    const max = this.maxSize;
    const mw = p.cols * TILE, mh = p.rows * TILE;
    if (mw > max || mh > max || p.w > max || p.h > max) {
      throw new Error(`this area is larger than this GPU allows (${max} px); try a smaller size`);
    }
    const src = this.#floatTexture(mw, mh, mosaic);
    const out = this.#floatTexture(p.w, p.h);
    this.#pass(this.resample, out, p.w, p.h, (u) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(u.u_src, 0);
      const stepX = (p.x1 - p.x0) / p.w, stepY = (p.y1 - p.y0) / p.h;
      gl.uniform2f(u.u_offset, p.x0 - p.tx0 * TILE - 0.5, p.y0 - p.ty0 * TILE - 0.5);
      gl.uniform2f(u.u_step, stepX, stepY);
    });
    gl.deleteTexture(src);

    const sigma = smoothM / p.mPerPx;
    if (sigma > 0) {
      const kernel = gaussianKernel(sigma);
      const radius = (kernel.length - 1) / 2;
      if (radius > 1023) throw new Error("smoothing is too strong for this resolution");
      const kTex = this.#floatTexture(kernel.length, 1, kernel);
      const tmp = this.#floatTexture(p.w, p.h);
      for (const [from, to, vertical] of [[out, tmp, false], [tmp, out, true]]) {
        this.#pass(this.blur, to, p.w, p.h, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, from);
          gl.uniform1i(u.u_src, 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, kTex);
          gl.uniform1i(u.u_kernel, 1);
          gl.uniform1i(u.u_radius, radius);
          gl.uniform1i(u.u_vertical, vertical ? 1 : 0);
        });
      }
      gl.deleteTexture(tmp);
      gl.deleteTexture(kTex);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture: out, width: p.w, height: p.h };
  }

  /**
   * Elevation range and gradients on the grid `auto_interval` uses, read back in one small pass.
   * @returns {{min:number, max:number, autoInterval:(texPerPx:number, targetPx?:number)=>number}}
   */
  summary(hm) {
    const gl = this.gl;
    const { width: w, height: h } = hm;
    if (w < 3 || h < 3) return { min: 0, max: 0, autoInterval: () => 20 };
    const step = Math.max(1, Math.floor(Math.max(w, h) / 256));
    const gw = Math.ceil((w - 2) / step), gh = Math.ceil((h - 2) / step);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, gw, gh, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.#pass(this.summaryProgram, tex, gw, gh, (u) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hm.texture);
      gl.uniform1i(u.u_src, 0);
      gl.uniform1i(u.u_step, step);
    });
    const px = new Float32Array(gw * gh * 4);
    gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(tex);

    let min = Infinity, max = -Infinity;
    const grad = new Float64Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) {
      const v = px[i * 4];
      if (v < min) min = v;
      if (v > max) max = v;
      grad[i] = Math.hypot(Math.fround(px[i * 4 + 1] * 0.5), Math.fround(px[i * 4 + 2] * 0.5));
    }
    const sorted = grad.sort();
    const p70 = sorted[Math.floor(sorted.length * 0.7)];
    return {
      min,
      max,
      /** Same as `--interval auto`: lines about targetPx output pixels apart on typical terrain. */
      autoInterval(texPerPx, targetPx = 6) {
        const ideal = Math.max(p70 * texPerPx, 1e-3) * targetPx;
        return NICE.reduce((best, n) => (Math.abs(Math.log(n / ideal)) < Math.abs(Math.log(best / ideal)) ? n : best));
      },
    };
  }

  /** Elevation of one heightmap texel (metres), or null outside it. */
  elevationAt(hm, x, y) {
    const gl = this.gl;
    const [ix, iy] = [Math.floor(x), Math.floor(y)];
    if (ix < 0 || iy < 0 || ix >= hm.width || iy >= hm.height) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hm.texture, 0);
    const px = new Float32Array(4);
    gl.readPixels(ix, iy, 1, 1, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px[0];
  }

  /**
   * Read a heightmap texture back (row 0 = north).
   * @returns {Float32Array}
   */
  read(hm) {
    const gl = this.gl;
    const { width: w, height: h } = hm;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hm.texture, 0);
    const data = new Float32Array(w * h);
    const strip = Math.max(1, Math.floor((1 << 22) / w));
    const buf = new Float32Array(w * strip * 4);
    for (let y0 = 0; y0 < h; y0 += strip) {
      const rows = Math.min(strip, h - y0);
      const view = buf.subarray(0, w * rows * 4);
      gl.readPixels(0, y0, w, rows, gl.RGBA, gl.FLOAT, view);
      for (let r = 0; r < rows; r++) {
        for (let x = 0; x < w; x++) data[(y0 + r) * w + x] = view[(r * w + x) * 4];
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return data;
  }
}
