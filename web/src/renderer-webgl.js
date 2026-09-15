// WebGL2 contour renderer for live previews. A direct port of
// crates/render/src/shaders/contour.wgsl — keep the two in sync so the browser
// preview matches `topowall render` pixel for pixel.

const MAX_TIERS = 8;
const MAX_STOPS = 32;

const VERT = `#version 300 es
void main() {
  vec2 xy = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(xy * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_dem;          // r32f elevations (m), row 0 = north
uniform vec2 u_size;              // output size (px)
uniform vec2 u_origin;            // this output's top-left within the full image (px), for tiled renders
uniform vec2 u_fullSize;          // full image size (px)
uniform bool u_blankOutside;      // draw the background where the heightmap has no data (live map)
uniform vec2 u_center;            // map centre (texels)
uniform float u_texPerPx;         // texels per output px
uniform vec4 u_background;
uniform int u_tierCount;
uniform vec4 u_tierA[${MAX_TIERS}];   // every, offset, width, opacity
uniform vec4 u_tierB[${MAX_TIERS}];   // first stop, stop count
uniform vec4 u_stopColor[${MAX_STOPS}];
uniform float u_stopElev[${MAX_STOPS}];
out vec4 outColor;

float texel(ivec2 p) {
  ivec2 size = textureSize(u_dem, 0);
  return texelFetch(u_dem, clamp(p, ivec2(0), size - 1), 0).r;
}

vec4 cubicWeights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0,
              -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}

float elevation(vec2 gIn) {
  vec2 g = gIn - 0.5;
  vec2 i = floor(g);
  vec4 wx = cubicWeights(g.x - i.x);
  vec4 wy = cubicWeights(g.y - i.y);
  ivec2 b = ivec2(i) - 1;
  float h = 0.0;
  for (int y = 0; y < 4; y++) {
    float row = 0.0;
    for (int x = 0; x < 4; x++) row += wx[x] * texel(b + ivec2(x, y));
    h += wy[y] * row;
  }
  return h;
}

float contourCoverage(float h, float slope, float interval, float widthPx) {
  float spacingPx = interval / max(slope, 1e-4);
  float distPx = abs(fract(h / interval + 0.5) - 0.5) * spacingPx;
  float line = clamp(0.5 * widthPx + 0.5 - distPx, 0.0, 1.0);
  float average = min(1.0, widthPx / spacingPx);
  return mix(line, average, smoothstep(3.0, 1.2, spacingPx));
}

vec4 tierColor(int i, float h) {
  int first = int(u_tierB[i].x);
  int count = int(u_tierB[i].y);
  if (count <= 1 || h <= u_stopElev[first]) return u_stopColor[first];
  for (int s = first + 1; s < first + count; s++) {
    if (h <= u_stopElev[s]) {
      float e0 = u_stopElev[s - 1];
      float t = (h - e0) / max(u_stopElev[s] - e0, 1e-3);
      return mix(u_stopColor[s - 1], u_stopColor[s], t);
    }
  }
  return u_stopColor[first + count - 1];
}

void main() {
  vec2 px = u_origin + vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);   // top-left origin, like WGSL
  vec2 g = u_center + (px - 0.5 * u_fullSize) * u_texPerPx;
  if (u_blankOutside && (any(lessThan(g, vec2(0.0))) || any(greaterThan(g, vec2(textureSize(u_dem, 0)))))) {
    outColor = u_background;
    return;
  }
  float h = elevation(g);
  float hx = elevation(g + vec2(u_texPerPx, 0.0));
  float hy = elevation(g + vec2(0.0, u_texPerPx));
  float slope = length(vec2(hx - h, hy - h));

  vec4 col = u_background;
  for (int i = 0; i < u_tierCount; i++) {
    vec4 a = u_tierA[i];
    float cov = contourCoverage(h - a.y, slope, a.x, a.z) * a.w;
    vec4 c = tierColor(i, h);
    col = vec4(mix(col.rgb, c.rgb, cov * c.a), col.a);
  }
  outColor = col;
}`;

export class ContourRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.canvas = canvas;
    this.gl = gl;
    this.program = this.#link(VERT, FRAG);
    this.u = Object.fromEntries(
      ["u_dem", "u_size", "u_origin", "u_fullSize", "u_blankOutside", "u_center", "u_texPerPx", "u_background",
        "u_tierCount", "u_tierA", "u_tierB", "u_stopColor", "u_stopElev"]
        .map((n) => [n, gl.getUniformLocation(this.program, n)]),
    );
    this.texture = gl.createTexture();
    this.vao = gl.createVertexArray();
    this.hm = null;
    this.theme = null;
  }

  #link(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  get maxTextureSize() {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
  }

  /**
   * Use a heightmap that already lives on the GPU (an R32F texture, e.g. from TerrainBuilder).
   * @param {{texture:WebGLTexture,width:number,height:number,min:number,max:number}} hm
   */
  setHeightTexture(hm) {
    this.texture = hm.texture;
    this.hm = hm;
  }

  /** @param {{width:number,height:number,data:Float32Array}} hm */
  setHeightmap(hm) {
    const gl = this.gl;
    if (hm.width > this.maxTextureSize || hm.height > this.maxTextureSize) {
      throw new Error(`heightmap ${hm.width}x${hm.height} exceeds this GPU's texture limit (${this.maxTextureSize})`);
    }
    if (this.hm?.texture === this.texture) this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, hm.width, hm.height, 0, gl.RED, gl.FLOAT, hm.data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    }
    this.hm = hm;
  }

  /** @param {ReturnType<import("./theme.js").resolveTheme>} resolved */
  setTheme(resolved) {
    if (resolved.tiers.length > MAX_TIERS) throw new Error(`at most ${MAX_TIERS} line tiers in the preview`);
    const stops = resolved.tiers.reduce((n, t) => n + t.stops.length, 0);
    if (stops > MAX_STOPS) throw new Error(`at most ${MAX_STOPS} color stops in the preview`);
    this.theme = resolved;
  }

  /** Heightmap texels per output pixel for "cover" framing (same as the CLI default). */
  texPerPx(width = this.canvas.width, height = this.canvas.height) {
    return Math.min(this.hm.width / width, this.hm.height / height);
  }

  /**
   * Draw into the canvas, or into `target` (a framebuffer) when given.
   * Defaults reproduce `topowall render`: the heightmap centred with cover framing.
   * @param {{target?:WebGLFramebuffer|null, width?:number, height?:number, fullWidth?:number, fullHeight?:number,
   *   originX?:number, originY?:number, center?:[number,number], texPerPx?:number, blankOutside?:boolean}} [o]
   */
  render(o = {}) {
    const { gl, u, hm, theme, canvas } = this;
    if (!hm || !theme) return;
    const width = o.width ?? canvas.width;
    const height = o.height ?? canvas.height;
    const fullWidth = o.fullWidth ?? width;
    const fullHeight = o.fullHeight ?? height;
    const tierA = new Float32Array(MAX_TIERS * 4);
    const tierB = new Float32Array(MAX_TIERS * 4);
    const stopColor = new Float32Array(MAX_STOPS * 4);
    const stopElev = new Float32Array(MAX_STOPS);
    let s = 0;
    theme.tiers.forEach((t, i) => {
      tierA.set([t.every, t.offset, t.width, t.opacity], i * 4);
      tierB.set([s, t.stops.length, 0, 0], i * 4);
      for (const [elev, color] of t.stops) {
        stopColor.set(color, s * 4);
        stopElev[s++] = elev;
      }
    });

    gl.bindFramebuffer(gl.FRAMEBUFFER, o.target ?? null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(u.u_dem, 0);
    gl.uniform2f(u.u_size, width, height);
    gl.uniform2f(u.u_origin, o.originX ?? 0, o.originY ?? 0);
    gl.uniform2f(u.u_fullSize, fullWidth, fullHeight);
    gl.uniform1i(u.u_blankOutside, o.blankOutside ? 1 : 0);
    const [cx, cy] = o.center ?? [hm.width / 2, hm.height / 2];
    gl.uniform2f(u.u_center, cx, cy);
    gl.uniform1f(u.u_texPerPx, o.texPerPx ?? this.texPerPx(fullWidth, fullHeight));
    gl.uniform4fv(u.u_background, theme.background);
    gl.uniform1i(u.u_tierCount, theme.tiers.length);
    gl.uniform4fv(u.u_tierA, tierA);
    gl.uniform4fv(u.u_tierB, tierB);
    gl.uniform4fv(u.u_stopColor, stopColor);
    gl.uniform1fv(u.u_stopElev, stopElev);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
