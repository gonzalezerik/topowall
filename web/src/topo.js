// Read topowall `.topo` heightmaps in the browser.
//
// A .topo file is a 16-bit grayscale PNG with a `topowall` iTXt chunk of JSON
// metadata (see crates/core/src/topo.rs). Browsers decode PNGs to 8 bits per
// channel, which would terrace the terrain, so this decodes the PNG itself
// using the built-in DecompressionStream.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Parse a .topo file.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{width:number,height:number,data:Float32Array,min:number,max:number,mPerPx?:number,extent?:object,source?:string}>}
 */
export async function parseTopo(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!SIGNATURE.every((v, i) => bytes[i] === v)) throw new Error("not a PNG / .topo file");
  const view = new DataView(buffer);
  const text = new TextDecoder();

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let meta = null;
  const idat = [];
  for (let pos = 8; pos < bytes.length; ) {
    const len = view.getUint32(pos);
    const type = text.decode(bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      [bitDepth, colorType] = [body[8], body[9]];
      interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "iTXt") {
      const nul = body.indexOf(0);
      if (text.decode(body.subarray(0, nul)) === "topowall") {
        // keyword \0 compression-flag compression-method language \0 translated \0 text
        let p = nul + 3;
        p = body.indexOf(0, p) + 1;
        p = body.indexOf(0, p) + 1;
        meta = JSON.parse(text.decode(body.subarray(p)));
      }
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (!meta) throw new Error("PNG has no topowall metadata (not a .topo file)");
  if (bitDepth !== 16 || colorType !== 0) throw new Error(".topo must be 16-bit grayscale");
  if (interlace) throw new Error("interlaced .topo files are not supported");

  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of idat) {
    joined.set(c, off);
    off += c.length;
  }
  const raw = await inflate(joined);

  // Undo PNG row filters (2 bytes per pixel).
  const bpp = 2, stride = width * 2;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[up + x] : 0;
      const c = x >= bpp && y > 0 ? px[up + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      px[dst + x] = v & 255;
    }
  }

  const data = new Float32Array(width * height);
  const scale = meta.range_m / 65535;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = meta.min_m + ((px[2 * i] << 8) | px[2 * i + 1]) * scale;
    data[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { width, height, data, min, max, mPerPx: meta.m_per_px, extent: meta.extent, source: meta.source };
}
