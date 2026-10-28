import { mkdir, readdir, lstat, realpath, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { shareZip } from "../assets/shareZip.js";

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export async function createTemporaryShares(dataDir) {
  const root = path.join(dataDir, "temporary-shares");
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const shares = new Map(), jobs = new Set(), pending = new Set();
  const controller = new AbortController();
  let creating = false;
  const cleanup = async () => {
    for (const [id, item] of shares) if (item.expiresAt <= Date.now()) shares.delete(id);
    for (const name of await readdir(root)) {
      const id = name.slice(0, -4);
      if (/^[0-9a-f-]{36}\.bin$/.test(name) && !pending.has(id) && !shares.has(id)) await rm(path.join(root, name), { force: true }).catch(() => {});
    }
  };
  // Shares are session-scoped; leftovers from a previous run are discarded.
  await cleanup();
  const timer = setInterval(() => { void cleanup().catch(() => {}); }, 30_000);
  timer.unref();
  const publicItem = ({ id, name, size, createdAt, expiresAt, shareToken }, { includeToken = false } = {}) => ({ id, name, size, createdAt, expiresAt, downloadUrl: `/api/temporary-shares/${id}/download`, ...(includeToken ? { shareToken } : {}) });
  function activeItem(id) {
    const item = shares.get(id);
    if (!item || item.expiresAt <= Date.now()) throw fail(404, "分享已到期或已取消");
    return item;
  }
  async function create({ sourcePath, hours = 24 } = {}) {
    if (controller.signal.aborted) throw fail(503, "服务正在关闭");
    if (creating) throw fail(409, "正在准备其他分享，请稍候");
    if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) throw fail(400, "请选择文件或目录，或输入本机绝对路径");
    if (![1, 24, 168].includes(hours)) throw fail(400, "有效期请选择 1 小时、24 小时或 7 天");
    if (shares.size >= 50) throw fail(400, "最多保留 50 个临时分享，请先取消部分分享");
    creating = true;
    const id = randomUUID(), target = path.join(root, `${id}.bin`);
    pending.add(id);
    try {
      if ((await lstat(sourcePath)).isSymbolicLink()) throw fail(400, "不支持分享符号链接或目录联接");
      const source = await realpath(sourcePath), info = await lstat(source);
      const insideCache = (value) => { const rel = path.relative(canonicalRoot, value); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); };
      if (insideCache(source)) throw fail(400, "不能分享临时分享缓存");
      if (!info.isFile() && !info.isDirectory()) throw fail(400, "仅支持普通文件或目录");
      if (info.isFile() && info.size >= 4_000_000_000) throw fail(400, "单个文件分享须小于 4 GB");
      let name = path.basename(source) || "files";
      if (info.isDirectory()) {
        const entries = [];
        let total = 0;
        async function walk(dir, prefix) {
          controller.signal.throwIfAborted();
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name), relative = `${prefix}${entry.name}`;
            if (insideCache(await realpath(file))) continue;
            const details = await lstat(file);
            if (details.isSymbolicLink()) throw fail(400, "目录包含符号链接或目录联接，请移除后再分享");
            if (entries.length >= 65000) throw fail(400, "目录最多支持 65000 个文件和子目录");
            if (details.isDirectory()) { entries.push({ name: `${relative}/`, directory: true }); await walk(file, `${relative}/`); }
            else if (details.isFile()) { total += details.size; entries.push({ name: relative, path: file }); }
            else throw fail(400, "目录中包含不支持的特殊文件");
            if (total >= 4_000_000_000) throw fail(400, "目录打包暂时仅支持小于 4 GB 的内容");
          }
        }
        await walk(source, `${name}/`);
        if (!entries.length) entries.push({ name: `${name}/`, directory: true });
        name += ".zip";
        await pipeline(Readable.from(shareZip(entries, controller.signal)), createWriteStream(target, { flags: "wx" }), { signal: controller.signal });
      } else {
        let copied = 0;
        async function* boundedFile() {
          for await (const chunk of createReadStream(source, { signal: controller.signal })) {
            copied += chunk.length;
            if (copied >= 4_000_000_000) throw fail(400, "单个文件分享须小于 4 GB");
            yield chunk;
          }
        }
        await pipeline(Readable.from(boundedFile()), createWriteStream(target, { flags: "wx" }), { signal: controller.signal });
      }
      const item = { id, shareToken: randomBytes(24).toString("base64url"), name, size: (await stat(target)).size, createdAt: Date.now(), expiresAt: Date.now() + hours * 3600_000 };
      shares.set(id, item);
      return publicItem(item, { includeToken: true });
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      if (error.statusCode) throw error;
      throw fail(400, `准备分享失败：${error.message}`);
    } finally { pending.delete(id); creating = false; }
  }
  return {
    list: (options) => [...shares.values()].filter((item) => item.expiresAt > Date.now()).map((item) => publicItem(item, options)).reverse(),
    create(body) {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "请输入文件或目录路径");
      const job = create(body); jobs.add(job); job.finally(() => jobs.delete(job)).catch(() => {}); return job;
    },
    async remove(id) { shares.delete(id); await cleanup(); },
    download(id) {
      const item = activeItem(id);
      return { ...publicItem(item), path: path.join(root, `${id}.bin`) };
    },
    sharedDownload(id, token) {
      const item = activeItem(id);
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(item.shareToken))) throw fail(404, "分享链接无效、已到期或已取消");
      return { ...publicItem(item), path: path.join(root, `${id}.bin`) };
    },
    async close() { clearInterval(timer); controller.abort(); await Promise.allSettled([...jobs]); shares.clear(); await cleanup(); },
  };
}
