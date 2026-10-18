import { mkdir, open, rename, rm, access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { elementError, maxVideoBytes } from "../../shared/domain/elements.js";
import { validateVideo } from "./videoFormat.js";
import sharp from "sharp";
import { extractVideoFirstFrame } from "./videoAnalysisFrames.js";

function validCover(cover) {
  return cover && typeof cover.url === "string" && cover.url.length <= 512 * 1024 &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(cover.url) &&
    Number.isFinite(cover.duration) && cover.duration > 0 &&
    Number.isFinite(cover.time) && cover.time >= 0 && cover.time < cover.duration;
}

export function createVideoStore(directory) {
  function filePath(key) {
    if (!/^[a-f0-9-]+\.(mp4|webm|mov)$/.test(key)) throw new Error("Invalid stored video key");
    return path.join(directory, key);
  }
  const coverPath = (key) => `${filePath(key)}.cover-v1.json`;
  const firstFramePath = (key) => `${filePath(key)}.first-frame-v1.png`;
  let extracting = 0;
  return {
    async firstFrame(key, options) {
      options?.signal?.throwIfAborted();
      await access(filePath(key));
      try { return await readFile(firstFramePath(key)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (extracting >= 2) throw elementError("正在提取视频首帧，请稍后重试", 503);
      extracting++;
      const target = firstFramePath(key), temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const bytes = await extractVideoFirstFrame({ inputPath: filePath(key), ffmpeg: options?.ffmpeg }, options);
        options?.signal?.throwIfAborted();
        await access(filePath(key));
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, target);
        return bytes;
      } catch (error) {
        if (error.code === "DEPENDENCY_MISSING") throw elementError("无法启动 FFmpeg。请在设置的“视频与画面检索”中配置 FFmpeg 程序路径，再重新整理", 503);
        throw error;
      } finally { extracting--; await rm(temporary, { force: true }); }
    },
    removeFirstFrame: (key) => rm(firstFramePath(key), { force: true }),
    async cover(key) {
      try {
        const cover = JSON.parse(await readFile(coverPath(key), "utf8"));
        return validCover(cover) ? cover : null;
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    },
    async saveCover(key, payload) {
      if (!validCover(payload)) throw elementError("无效的视频封面");
      let bytes;
      try {
        bytes = await sharp(Buffer.from(payload.url.split(",")[1], "base64"), { limitInputPixels: 480 * 480, failOn: "warning" })
          .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      } catch { throw elementError("无效的视频封面图片"); }
      const cover = { url: `data:image/jpeg;base64,${bytes.toString("base64")}`, duration: payload.duration, time: payload.time };
      const target = coverPath(key), temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await access(filePath(key));
        await writeFile(temporary, JSON.stringify(cover), { flag: "wx" });
        await rename(temporary, target);
        return cover;
      } finally { await rm(temporary, { force: true }); }
    },
    removeCover: (key) => rm(coverPath(key), { force: true }),
    async save(stream, originalName) {
      const suffix = path.extname(originalName).slice(1).toLowerCase();
      const extension = suffix === "m4v" ? "mp4" : suffix;
      if (!["mp4", "webm", "mov"].includes(extension)) throw elementError("支持 MP4、WebM、MOV 视频文件", 415);
      if (Number(stream.headers?.["content-length"]) > maxVideoBytes) throw elementError("视频必须在 1 GiB 以内", 413);
      await mkdir(directory, { recursive: true });
      const storageKey = `${randomUUID()}.${extension}`, target = filePath(storageKey), temporary = `${target}.tmp`;
      let handle;
      try {
        handle = await open(temporary, "wx+");
        const hash = createHash("sha256");
        let byteSize = 0;
        for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
          byteSize += chunk.length;
          if (byteSize > maxVideoBytes) throw elementError("视频必须在 1 GiB 以内", 413);
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        if (!byteSize) throw elementError("视频文件不能为空");
        const mimeType = await validateVideo(handle, byteSize, extension);
        await handle.close(); handle = null;
        await rename(temporary, target);
        return { storageKey, mimeType, byteSize, originalName, contentHash: hash.digest("hex") };
      } finally {
        try { await handle?.close(); }
        finally { await rm(temporary, { force: true }); }
      }
    },
    async open(key) {
      try { return await open(filePath(key), "r"); }
      catch (error) {
        if (error.code === "ENOENT") throw elementError("原视频文件缺失，请从备份恢复", 404);
        throw error;
      }
    },
    async exists(key) {
      try { await access(filePath(key)); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    },
    async remove(key) {
      await rm(firstFramePath(key), { force: true });
      await rm(coverPath(key), { force: true });
      await rm(filePath(key), { force: true });
    },
  };
}
