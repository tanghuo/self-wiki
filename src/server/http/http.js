import { readFile } from "node:fs/promises";
import path from "node:path";
import { maxImageBytes } from "../../shared/domain/elements.js";

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export function text(res, status, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(payload);
}

export async function readImage(req) {
  if (Number(req.headers["content-length"]) > maxImageBytes) { req.resume(); throw httpError(413, "图片必须在 25 MiB 以内"); }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxImageBytes) { req.resume(); throw httpError(413, "图片必须在 25 MiB 以内"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, { maxBytes = 64 * 1024 } = {}) {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw httpError(415, "Expected application/json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) throw httpError(413, "Request body is too large");
  let payload;
  try { payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { throw httpError(400, "Invalid JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "Expected a JSON object");
  }
  return payload;
}

export async function serveStatic(res, url, rendererDist, { access } = {}) {
  let requested;
  try { requested = decodeURIComponent(url.pathname); }
  catch { throw httpError(400, "Invalid URL encoding"); }
  if (requested.includes("\0")) throw httpError(400, "Invalid URL");
  // Treat backslashes as separators everywhere so traversal checks match Windows behavior.
  requested = requested.replaceAll("\\", "/");
  const resolved = path.resolve(rendererDist, requested === "/" ? "index.html" : requested.slice(1));
  const relative = path.relative(rendererDist, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw httpError(403, "Forbidden");
  }
  let bytes;
  try { bytes = await readFile(resolved); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR", "EPERM"].includes(error.code)) throw httpError(404, "Not found");
    throw error;
  }
  const types = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  };
  if (access && path.basename(resolved) === "index.html") {
    // Tell the renderer which LAN mode applies so it hides controls the server refuses.
    bytes = Buffer.from(bytes.toString("utf8").replace(/<head(\s[^>]*)?>/i, (head) => `${head}<meta name="wiki-access" content="${access}">`));
  }
  text(res, 200, bytes, types[path.extname(resolved).toLowerCase()] || "application/octet-stream");
}
