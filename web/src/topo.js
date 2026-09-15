// Read topowall `.topo` heightmaps in the browser.
//
// A .topo file is a 16-bit grayscale PNG with a `topowall` iTXt chunk of JSON
// metadata (see crates/core/src/topo.rs).

import { decodePng } from "./png.js";

/**
 * Parse a .topo file.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{width:number,height:number,data:Float32Array,min:number,max:number,mPerPx?:number,extent?:object,source?:string}>}
 */
export async function parseTopo(buffer) {
  const png = await decodePng(buffer);
  const metaText = png.text.get("topowall");
  if (!metaText) throw new Error("PNG has no topowall metadata (not a .topo file)");
  if (png.bitDepth !== 16 || png.colorType !== 0) throw new Error(".topo must be 16-bit grayscale");
  const meta = JSON.parse(metaText);

  const { width, height, pixels: px } = png;
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
