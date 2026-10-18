import { mkdir, writeFile, rename, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { elementError, maxImageBytes, imagePreviewWidths } from "../../shared/domain/elements.js";
import { createPreviewQueue } from "./previewQueue.js";

const formats = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export function createImageStore(directory) {
  const thumbnails = new Map();
  const pending = new Map();
  const enqueue = createPreviewQueue();
  const cacheDirectory = path.join(directory, "previews-v1");
  let thumbnailBytes = 0;
  function filePath(key) {
    if (!/^[a-f0-9-]+\.(png|jpeg|webp|gif)$/.test(key)) throw new Error("Invalid stored image key");
    return path.join(directory, key);
  }
  async function read(key) {
    try { return await readFile(filePath(key)); }
    catch (error) {
      if (error.code === "ENOENT") throw elementError("原图文件缺失，请从备份恢复", 404);
      throw error;
    }
  }
  async function readAccess(key) {
    try { await access(filePath(key)); }
    catch (error) { if (error.code === "ENOENT") throw elementError("原图文件缺失，请从备份恢复", 404); throw error; }
  }
  function dimensions(metadata) {
    const width = metadata.width, height = metadata.pageHeight || metadata.height;
    return metadata.orientation >= 5 ? { width: height, height: width } : { width, height };
  }
  return {
    thumbnail(key, width, { foreground = false, regenerate = false } = {}) {
      filePath(key);
      if (width !== undefined && !imagePreviewWidths.includes(width)) throw elementError("无效的预览宽度");
      const cacheKey = `${key}:${width || "small"}`;
      if (regenerate && thumbnails.has(cacheKey)) {
        thumbnailBytes -= thumbnails.get(cacheKey).length; thumbnails.delete(cacheKey);
      }
      if (thumbnails.has(cacheKey)) {
        const bytes = thumbnails.get(cacheKey);
        thumbnails.delete(cacheKey); thumbnails.set(cacheKey, bytes);
        return Promise.resolve(bytes);
      }
      if (pending.has(cacheKey)) {
        const job = pending.get(cacheKey);
        if (foreground) job.promote();
        return job.promise;
      }
      const job = enqueue(async () => {
        // Validate the original even for disk hits; deletion must not resurrect a preview.
        await readAccess(key);
        const target = path.join(cacheDirectory, `${key}.${width || "small"}.webp`);
        let bytes;
        try {
          if (regenerate) throw new Error("Refresh preview");
          bytes = await readFile(target);
          if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") throw new Error("Invalid preview cache");
        } catch {
          bytes = await sharp(await read(key), { limitInputPixels: 40_000_000 })
            .rotate().resize({ width: width || 400, height: width ? 3200 : 280, fit: "inside", withoutEnlargement: true }).webp({ quality: width ? 85 : 72 }).toBuffer();
          const temporary = `${target}.${randomUUID()}.tmp`;
          try {
            await mkdir(cacheDirectory, { recursive: true });
            await writeFile(temporary, bytes, { flag: "wx" });
            await rename(temporary, target);
          } catch { /* Disk cache is disposable; a full/read-only disk must not hide the image. */ }
          finally { await rm(temporary, { force: true }).catch(() => {}); }
        }
        thumbnails.set(cacheKey, bytes); thumbnailBytes += bytes.length;
        while (thumbnails.size > 128 || thumbnailBytes > 16 * 1024 * 1024) {
          const oldest = thumbnails.keys().next().value;
          thumbnailBytes -= thumbnails.get(oldest).length; thumbnails.delete(oldest);
        }
        return bytes;
      }, foreground);
      job.promise = job.promise.finally(() => pending.delete(cacheKey));
      pending.set(cacheKey, job);
      return job.promise;
    },
    async dimensions(key) {
      const metadata = await sharp(await read(key), { limitInputPixels: 40_000_000 }).metadata();
      return dimensions(metadata);
    },
    async save(bytes, originalName) {
      if (!bytes.length || bytes.length > maxImageBytes) throw elementError("图片必须在 25 MiB 以内", 413);
      let format, size;
      try {
        const decoder = sharp(bytes, { animated: true, limitInputPixels: 40_000_000, failOn: "warning" });
        const metadata = await decoder.metadata();
        format = metadata.format; size = dimensions(metadata);
        if (!formats[format] || (metadata.pages || 1) > 200 || metadata.width * metadata.height > 40_000_000) {
          throw new Error("Unsupported image dimensions or format");
        }
        await pipeline(decoder.raw(), new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
      } catch {
        throw elementError("图片无法读取：支持 PNG、JPEG、WebP、GIF，总像素不超过 4000 万，动画不超过 200 帧", 415);
      }
      await mkdir(directory, { recursive: true });
      const storageKey = `${randomUUID()}.${format}`;
      const target = filePath(storageKey);
      const temporary = `${target}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
      return { storageKey, mimeType: formats[format], byteSize: bytes.length, originalName, ...size };
    },
    async remove(key) {
      await rm(filePath(key), { force: true });
      await Promise.allSettled([...pending].filter(([cacheKey]) => cacheKey.startsWith(`${key}:`)).map(([, job]) => job.promise));
      await Promise.all(["small", ...imagePreviewWidths].map((width) => rm(path.join(cacheDirectory, `${key}.${width}.webp`), { force: true })));
      for (const [cacheKey, bytes] of thumbnails) {
        if (cacheKey.startsWith(`${key}:`)) { thumbnailBytes -= bytes.length; thumbnails.delete(cacheKey); }
      }
    },
    async exists(key) {
      try { await access(filePath(key)); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    },
    read,
  };
}
