import { elementError } from "../../shared/domain/elements.js";

const invalid = () => elementError("视频无法读取：请选择包含视频轨道的 MP4、WebM 或 MOV 文件", 415);

// Inspect container structure without decoding frames or loading media payloads.
export async function validateVideo(handle, size, extension) {
  let inspected = 0;
  async function read(offset, length) {
    if (++inspected > 20000 || offset + length > size || length > 4096) throw invalid();
    const bytes = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await handle.read(bytes, done, length - done, offset + done);
      if (!bytesRead) throw invalid();
      done += bytesRead;
    }
    return bytes;
  }
  if (extension !== "webm") {
    let video = false, media = false, movie = false;
    async function boxes(start, end, parent = "root") {
      for (let offset = start; offset < end;) {
        if (end - offset < 8) throw invalid();
        const header = await read(offset, 8), type = header.toString("ascii", 4);
        let length = header.readUInt32BE(), headerSize = 8;
        if (length === 1) {
          length = Number((await read(offset + 8, 8)).readBigUInt64BE()); headerSize = 16;
        } else if (length === 0) length = end - offset;
        if (!Number.isSafeInteger(length) || length < headerSize || offset + length > end) throw invalid();
        const body = offset + headerSize, next = offset + length;
        if (parent === "root" && type === "mdat" && next > body) media = true;
        if (parent === "root" && type === "moov") { movie = true; await boxes(body, next, "moov"); }
        if (parent === "moov" && type === "trak") await boxes(body, next, "trak");
        if (parent === "trak" && type === "mdia") await boxes(body, next, "mdia");
        if (parent === "mdia" && type === "hdlr" && next - body >= 12) {
          if ((await read(body, 12)).toString("ascii", 8, 12) === "vide") video = true;
        }
        offset = next;
      }
    }
    await boxes(0, size);
    if (!movie || !media || !video) throw invalid();
    return extension === "mov" ? "video/quicktime" : "video/mp4";
  }
  async function vint(offset, id = false) {
    const first = (await read(offset, 1))[0];
    let width = 1;
    while (width <= 8 && !(first & (0x80 >> (width - 1)))) width++;
    if (width > (id ? 4 : 8)) throw invalid();
    const bytes = await read(offset, width);
    let value = BigInt(id ? first : first & (0xff >> width));
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[i]);
    return { width, value: Number(value), unknown: !id && value === (1n << BigInt(width * 7)) - 1n };
  }
  let webm = false, video = false, media = false;
  async function elements(start, end, parent) {
    for (let offset = start; offset < end;) {
      const id = await vint(offset, true), length = await vint(offset + id.width);
      const body = offset + id.width + length.width;
      if (length.unknown && id.value !== 0x18538067 && id.value !== 0x1f43b675) throw invalid();
      const next = length.unknown ? end : body + length.value;
      if (!Number.isSafeInteger(next) || next > end || next < body) throw invalid();
      if (parent === "root" && id.value === 0x1a45dfa3) await elements(body, next, "header");
      if (parent === "header" && id.value === 0x4282 && next - body === 4) webm = (await read(body, 4)).toString() === "webm";
      if (parent === "root" && id.value === 0x18538067) await elements(body, next, "segment");
      if (parent === "segment" && id.value === 0x1654ae6b) await elements(body, next, "tracks");
      if (parent === "tracks" && id.value === 0xae) await elements(body, next, "track");
      if (parent === "track" && id.value === 0x83 && next - body > 0 && next - body <= 4) {
        const value = await read(body, next - body);
        if (value.readUIntBE(0, value.length) === 1) video = true;
      }
      if (parent === "segment" && id.value === 0x1f43b675 && next > body) media = true;
      offset = next;
      if (webm && video && media) return;
    }
  }
  if (size < 4 || (await read(0, 4)).readUInt32BE() !== 0x1a45dfa3) throw invalid();
  await elements(0, size, "root");
  if (!webm || !video || !media) throw invalid();
  return "video/webm";
}
