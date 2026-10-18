import { pipeline } from "node:stream/promises";
import { httpError } from "./http.js";

export async function serveVideo(req, res, { handle, contentType, byteSize }, downloadName) {
  try {
    const info = await handle.stat(), size = info.size;
    if (!info.isFile() || !size || size !== byteSize) throw httpError(409, "原视频文件大小异常，请从备份恢复");
    const headers = {
      "content-type": contentType, "content-length": size, "accept-ranges": "bytes",
      "cache-control": "no-store", "x-content-type-options": "nosniff",
    };
    if (downloadName) headers["content-disposition"] = `attachment; filename="video"; filename*=UTF-8''${encodeURIComponent(downloadName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`;
    let start = 0, end = size - 1, status = 200;
    if (req.method !== "HEAD" && req.headers.range && !req.headers["if-range"]) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      } else start = NaN;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 }); res.end(); return;
      }
      status = 206; headers["content-range"] = `bytes ${start}-${end}/${size}`; headers["content-length"] = end - start + 1;
    }
    res.writeHead(status, headers);
    if (req.method === "HEAD") res.end();
    else await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}
