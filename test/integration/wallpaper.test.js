import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { prepareWallpaperFile, setDesktopWallpaper } from "../../src/main/wallpaper.js";

test("wallpaper reads only image IDs, converts supported formats and keeps independent full-size files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-wallpaper-"));
  const images = await Promise.all(["png", "jpeg", "webp", "gif"].map((format) =>
    sharp({ create: { width: 17, height: 23, channels: 4, background: "#408d8180" } }).toFormat(format).toBuffer()));
  const requested = [];
  const server = createServer((req, res) => {
    requested.push(req.url);
    const index = Number(/^\/api\/elements\/(\d+)\/image$/.exec(req.url)?.[1]) - 1;
    if (index === 4) { res.writeHead(302, { location: "/api/elements/1/image" }); res.end(); return; }
    if (index === 5) { res.writeHead(200, { "content-type": "text/plain" }); res.end("text"); return; }
    if (index === 6) { res.writeHead(200, { "content-type": "image/png" }); res.end("broken"); return; }
    if (!images[index]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "image/png" }); res.end(images[index]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const backend = `http://127.0.0.1:${server.address().port}`;
  for (const id of [1, 2, 3, 4]) {
    const file = await prepareWallpaperFile(id, backend, root);
    assert.equal(path.dirname(file), root);
    assert.match(path.basename(file), /^[a-f0-9]{64}\.png$/);
    const metadata = await sharp(await readFile(file)).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 17); assert.equal(metadata.height, 23);
    assert.equal(metadata.hasAlpha, false);
    assert.equal(await prepareWallpaperFile(id, backend, root), file);
  }
  const count = requested.length;
  for (const id of [0, -1, 1.5, "1", "../config", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(prepareWallpaperFile(id, backend, root), /无效/);
  }
  assert.equal(requested.length, count);
  await assert.rejects(prepareWallpaperFile(5, backend, root));
  await assert.rejects(prepareWallpaperFile(6, backend, root), /不是图片/);
  await assert.rejects(prepareWallpaperFile(7, backend, root));
  await assert.rejects(prepareWallpaperFile(8, backend, root), /404/);
  assert.ok((await readdir(root)).every((file) => file.endsWith(".png")));
  await assert.rejects(setDesktopWallpaper(path.join(root, "missing.png")));
  if (process.platform === "win32") {
    // The Electron binary is only needed (and only installed in CI) for the Windows desktop bridge check.
    const { default: electron } = await import("electron");
    const env = { ...process.env, WIKI_WALLPAPER_TEST_URL: backend, WIKI_WALLPAPER_TEST_CACHE: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(electron, [path.join(import.meta.dirname, "../fixtures/wallpaper-desktop.cjs")],
      { windowsHide: true, timeout: 30000, env });
    assert.match(result.stdout, /wallpaper desktop bridge ok/);
  }
});
