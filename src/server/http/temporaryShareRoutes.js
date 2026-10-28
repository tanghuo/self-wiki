import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { httpError, json, readJson, text } from "./http.js";

async function sendDownload(req, res, item) {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": item.size,
    "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
    "cache-control": "no-store", "x-content-type-options": "nosniff" });
  if (req.method === "HEAD") res.end();
  else await pipeline(createReadStream(item.path), res).catch(() => { res.destroy(); });
}

// This capability only serves one live share. It never creates a LAN session.
export async function handleSharedDownloadRoute(shares, req, res, url) {
  const match = url.pathname.match(/^\/share\/([0-9a-f-]{36})(\/download)?$/);
  if (!match) return false;
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (!["GET", "HEAD"].includes(req.method)) throw httpError(405, "Method not allowed");
  const token = url.searchParams.get("token");
  const item = shares.sharedDownload(match[1], token);
  if (match[2]) await sendDownload(req, res, item);
  else {
    const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const href = `/share/${item.id}/download?token=${encodeURIComponent(token)}`;
    if (req.method === "HEAD") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(); }
    else text(res, 200, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>临时分享</title><style>body{margin:0;padding:24px;background:#eee8dc;color:#39362f;font:16px/1.7 system-ui,sans-serif}main{max-width:480px;margin:10vh auto;padding:24px;background:#f6f1e7;border-radius:16px;overflow-wrap:anywhere}h1{font-size:22px}a{display:inline-block;padding:10px 24px;background:#725b3e;color:white;border-radius:8px;text-decoration:none}p{color:#635c50}</style></head><body><main><p>临时分享</p><h1>${escape(item.name)}</h1><p>${item.size} B · 到期：${escape(new Date(item.expiresAt).toISOString())}</p><a href="${escape(href)}" download>下载</a><p>此链接仅允许下载当前文件，到期或取消后失效。</p></main></body></html>`, "text/html; charset=utf-8");
  }
  return true;
}

export async function handleTemporaryShareRoute(shares, req, res, url, access) {
  const route = url.pathname;
  if (route !== "/api/temporary-shares" && !route.startsWith("/api/temporary-shares/")) return false;
  if (access === "lan") throw httpError(403, "临时分享仅限通过独立分享链接下载");
  if (route === "/api/temporary-shares" && req.method === "GET") json(res, 200, { shares: shares.list({ includeToken: access === "local" }) });
  else if (route === "/api/temporary-shares" && req.method === "POST") json(res, 201, await shares.create(await readJson(req)));
  else {
    const match = route.match(/^\/api\/temporary-shares\/([0-9a-f-]{36})(\/download)?$/);
    if (!match) throw httpError(404, "Not found");
    if (match[2] && ["GET", "HEAD"].includes(req.method)) {
      await sendDownload(req, res, shares.download(match[1]));
    } else if (!match[2] && req.method === "DELETE") { await shares.remove(match[1]); json(res, 200, { ok: true }); }
    else throw httpError(405, "Method not allowed");
  }
  return true;
}
