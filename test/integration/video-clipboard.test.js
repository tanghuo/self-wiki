import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { videoDownloadUrl, prepareVideoFile } from "../../src/main/videoClipboard.js";

test("video clipboard accepts app and dev proxy sources, but rejects unrelated URLs", () => {
  const backend = "http://127.0.0.1:8765";
  assert.equal(videoDownloadUrl(`${backend}/api/elements/abc/video`, backend), `${backend}/api/elements/abc/download`);
  assert.equal(videoDownloadUrl("http://127.0.0.1:5173/api/elements/abc/video?t=1", backend, "http://127.0.0.1:5173"), `${backend}/api/elements/abc/download`);
  for (const source of ["https://example.com/api/elements/abc/video", `${backend}/api/config`, "file:///C:/video.mp4"]) {
    assert.throws(() => videoDownloadUrl(source, backend));
  }
});

test("video clipboard caches complete file bytes with original Unicode name and reuses the file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-video-clipboard-"));
  const bytes = Buffer.from([0, 1, 2, 255, 128]);
  const server = createServer((req, res) => {
    if (req.url === "/missing") { res.writeHead(404); res.end(); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "/video" }); res.end(); return; }
    res.writeHead(200, { "content-length": bytes.length, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("测试 视频.mp4")}` });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = await prepareVideoFile(`${base}/video`, root);
  assert.equal(path.basename(file), "测试 视频.mp4");
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(await prepareVideoFile(`${base}/video`, root), file);
  assert.deepEqual(await readdir(path.dirname(file)), ["测试 视频.mp4"]);
  await assert.rejects(prepareVideoFile(`${base}/missing`, root), /404/);
  await assert.rejects(prepareVideoFile(`${base}/redirect`, root));
});
