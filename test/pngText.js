import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";

export function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export function pngText(keyword, text, { compress = false, international = false } = {}) {
  const key = Buffer.from(keyword, "latin1");
  const value = Buffer.from(text, "utf8");
  if (international) {
    return pngChunk("iTXt", Buffer.concat([
      key, Buffer.from([0, compress ? 1 : 0, 0, 0, 0]),
      compress ? deflateSync(value) : value,
    ]));
  }
  if (compress) return pngChunk("zTXt", Buffer.concat([key, Buffer.from([0, 0]), deflateSync(value)]));
  return pngChunk("tEXt", Buffer.concat([key, Buffer.from([0]), value]));
}

export async function pngWithChunks(chunks) {
  const base = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#408d81" } }).png().toBuffer();
  const parts = [base.subarray(0, 8)];
  let offset = 8;
  let inserted = false;
  while (offset + 12 <= base.length) {
    const length = base.readUInt32BE(offset);
    const type = base.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!inserted && type === "IDAT") { parts.push(...chunks); inserted = true; }
    parts.push(base.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(parts);
}
