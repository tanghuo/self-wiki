import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { httpError, json, readJson } from "./http.js";

export async function handleTemporaryShareRoute(shares, req, res, url, access) {
  const route = url.pathname;
  if (route !== "/api/temporary-shares" && !route.startsWith("/api/temporary-shares/")) return false;
  if (access === "lan" && !["GET", "HEAD"].includes(req.method)) throw httpError(403, "临时分享仅限本机创建或取消");
  if (route === "/api/temporary-shares" && req.method === "GET") json(res, 200, { shares: shares.list() });
  else if (route === "/api/temporary-shares" && req.method === "POST") json(res, 201, await shares.create(await readJson(req)));
  else {
    const match = route.match(/^\/api\/temporary-shares\/([0-9a-f-]{36})(\/download)?$/);
    if (!match) throw httpError(404, "Not found");
    if (match[2] && ["GET", "HEAD"].includes(req.method)) {
      const item = shares.download(match[1]);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": item.size,
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
        "cache-control": "no-store", "x-content-type-options": "nosniff" });
      if (req.method === "HEAD") res.end();
      else await pipeline(createReadStream(item.path), res).catch(() => { res.destroy(); });
    } else if (!match[2] && req.method === "DELETE") { await shares.remove(match[1]); json(res, 200, { ok: true }); }
    else throw httpError(405, "Method not allowed");
  }
  return true;
}
