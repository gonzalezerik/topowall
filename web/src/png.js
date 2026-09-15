// A small PNG decoder for elevation data. Browsers decode images to 8 bits per
// channel and may color-manage them, which would change elevations, so tiles
// and .topo files are decoded here instead (inflate uses the built-in
// DecompressionStream).
//
// Supports non-interlaced PNGs: grayscale (8/16-bit), RGB and RGBA (8-bit),
// and 8-bit palette images.

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

const CHANNELS = { 0: 1, 2: 3, 3: 1, 6: 4 };

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<{width:number,height:number,bitDepth:number,colorType:number,
 *   channels:number,pixels:Uint8Array,palette?:Uint8Array,text:Map<string,string>}>}
 *   `pixels` holds the unfiltered samples (big-endian for 16-bit).
 */
export async function decodePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || !SIGNATURE.every((v, i) => bytes[i] === v)) throw new Error("not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0, palette;
  const text = new Map();
  const idat = [];
  for (let pos = 8; pos + 8 <= bytes.length; ) {
    const len = view.getUint32(pos);
    const type = decoder.decode(bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      [bitDepth, colorType] = [body[8], body[9]];
      interlace = body[12];
    } else if (type === "PLTE") {
      palette = body.slice();
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "iTXt") {
      // keyword \0 compression-flag compression-method language \0 translated \0 text
      const nul = body.indexOf(0);
      let p = nul + 3;
      p = body.indexOf(0, p) + 1;
      p = body.indexOf(0, p) + 1;
      text.set(decoder.decode(body.subarray(0, nul)), decoder.decode(body.subarray(p)));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || !channels) throw new Error(`unsupported PNG (color type ${colorType})`);
  if (interlace) throw new Error("interlaced PNGs are not supported");
  if (bitDepth !== 8 && !(bitDepth === 16 && colorType === 0)) {
    throw new Error(`unsupported PNG bit depth ${bitDepth} for color type ${colorType}`);
  }

  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of idat) {
    joined.set(c, off);
    off += c.length;
  }
  const raw = await inflate(joined);

  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG data");
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
  return { width, height, bitDepth, colorType, channels, pixels: px, palette, text };
}

/** RGB samples of an 8-bit PNG as [r, g, b] per pixel, whatever its color type. */
export function rgbOf(png) {
  const { width, height, colorType, channels, pixels, palette } = png;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    let r, g, b;
    if (colorType === 3) {
      const k = pixels[i] * 3;
      [r, g, b] = [palette[k], palette[k + 1], palette[k + 2]];
    } else if (colorType === 0) {
      r = g = b = pixels[i];
    } else {
      const k = i * channels;
      [r, g, b] = [pixels[k], pixels[k + 1], pixels[k + 2]];
    }
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}
