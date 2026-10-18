import { open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileTools } from "../../shared/domain/fileTools.js";
import { elementError } from "../../shared/domain/elements.js";

const maxFileBytes = 1024 * 1024;

function argumentsFor(name, value) {
  const schema = fileTools.find((tool) => tool.name === name)?.inputSchema;
  if (!schema || !value || typeof value !== "object" || Array.isArray(value)) throw elementError("无效的文件工具或参数");
  for (const key of schema.required || []) if (value[key] === undefined) throw elementError(`缺少参数 ${key}`);
  for (const [key, item] of Object.entries(value)) {
    const rule = schema.properties[key];
    if (!rule) throw elementError(`不支持参数 ${key}`);
    if (rule.type === "integer") {
      if (!Number.isSafeInteger(item) || item < rule.minimum || item > (rule.maximum ?? Number.MAX_SAFE_INTEGER)) throw elementError(`参数 ${key} 超出允许范围`);
    } else if (typeof item !== rule.type || rule.type === "string" && (item.includes("\0") || item.length < (rule.minLength ?? 0) || item.length > (rule.maxLength ?? 2048))) {
      throw elementError(`无效的参数 ${key}`);
    }
  }
  if (value.glob !== undefined && (!value.glob || value.glob.length > 256 || value.glob.includes("\\"))) throw elementError("glob 须为 1–256 字，使用 / 分隔目录");
  return value;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw elementError("文件工具只能访问当前会话工作目录", 403);
  return file;
}

async function resolved(root, file, signal) {
  signal?.throwIfAborted();
  const target = inside(root, path.resolve(root, file));
  // Validate the real destination too: junctions and symlinks must not cross sessions.
  return inside(root, await realpath(target));
}

async function textFile(file, signal, budget) {
  signal?.throwIfAborted();
  if (!(await stat(file)).isFile()) throw elementError("请选择普通文本文件");
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw elementError("请选择普通文本文件");
    if (info.size > maxFileBytes) throw elementError("文本文件超过 1 MiB 读取上限");
    if (budget && info.size > budget.remaining) { budget.exhausted = true; return null; }
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxFileBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw elementError("读取期间文件长度发生变化，请重试");
    if (budget) budget.remaining -= length;
    const data = bytes.subarray(0, length);
    const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
    let content;
    try { content = new TextDecoder(encoding, { fatal: true }).decode(data); }
    catch { throw elementError("文件不是有效的 UTF-8 或带 BOM 的 UTF-16 文本"); }
    if (content.includes("\0")) throw elementError("这是二进制文件，请使用对应的图片或媒体工具");
    signal?.throwIfAborted();
    return content;
  } finally { await handle.close(); }
}

export async function executeFileTool(name, value, { workspace, signal }) {
  const args = argumentsFor(name, value);
  signal?.throwIfAborted();
  const root = await realpath(workspace);
  // Accept both Windows short/long spellings of the workspace, without broadening the root.
  const requested = path.resolve(workspace, args.path || ".");
  const relative = path.relative(path.resolve(workspace), requested);
  const fromWorkspace = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const target = await resolved(root, fromWorkspace ? relative : requested, signal);
  if (name === "read_file") {
    const content = await textFile(target, signal), offset = args.offset ?? 0, limit = args.limit ?? 16000;
    const end = Math.min(offset + limit, content.length);
    return { path: target, content: content.slice(offset, end), offset, nextOffset: end < content.length ? end : null, truncated: end < content.length };
  }
  if (!(await stat(target)).isDirectory()) throw elementError("path 必须指向目录；读取单个文件请使用 read_file");
  const result = { path: target, ...(name === "list_files" ? { entries: [] } : { matches: [] }), skipped: [], truncated: false };
  const limit = args.limit ?? 100, budget = { remaining: 8 * maxFileBytes, exhausted: false };
  const query = args.caseSensitive ? args.query : args.query?.toLowerCase();
  let scanned = 0, outputChars = 0;
  function skip(file, reason) {
    if (result.skipped.length < 50) { result.skipped.push({ path: file, reason: reason.slice(0, 1000) }); outputChars += file.length + Math.min(reason.length, 1000); }
    else result.truncated = true;
  }
  async function visit(directory, depth = 0) {
    signal?.throwIfAborted();
    const actual = await resolved(root, directory, signal);
    for await (const entry of await opendir(actual)) {
      signal?.throwIfAborted();
      if (++scanned > 10000 || budget.exhausted || outputChars >= 32000) { result.truncated = true; return false; }
      const file = path.join(actual, entry.name), relative = path.relative(target, file).split(path.sep).join("/");
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) { skip(file, "跳过链接或特殊文件"); continue; }
      if (!args.glob || path.posix.matchesGlob(relative, args.glob)) {
        if (name === "list_files") {
          if (result.entries.length >= limit) { result.truncated = true; return false; }
          result.entries.push({ path: file, type: entry.isDirectory() ? "directory" : "file" });
          outputChars += file.length;
        } else if (entry.isFile()) {
          let content;
          try { content = await textFile(await resolved(root, file, signal), signal, budget); }
          catch (error) { signal?.throwIfAborted(); skip(file, error.message); continue; }
          if (budget.exhausted) { result.truncated = true; return false; }
          const lines = content.split(/\r\n|\r|\n/);
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index], column = (args.caseSensitive ? line : line.toLowerCase()).indexOf(query);
            if (column === -1) continue;
            if (result.matches.length >= limit || outputChars >= 32000) { result.truncated = true; return false; }
            const start = Math.max(0, column - 120), excerpt = line.slice(start, start + 1000);
            result.matches.push({ path: file, line: index + 1, text: excerpt, truncated: start > 0 || start + excerpt.length < line.length });
            outputChars += file.length + excerpt.length;
          }
        }
      }
      if (entry.isDirectory() && args.recursive !== false) {
        if (depth >= 32) { skip(file, "超过目录深度上限，请将 path 指向此目录后继续"); result.truncated = true; continue; }
        try { if (!await visit(file, depth + 1)) return false; }
        catch (error) { signal?.throwIfAborted(); skip(file, error.message); }
      }
    }
    return true;
  }
  await visit(target);
  signal?.throwIfAborted();
  return result;
}
