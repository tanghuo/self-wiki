import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { createServer as httpServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { createTemporaryShares } from "../../src/server/application/temporaryShares.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-share-"));
  let app;
  t.after(async () => {
    await app?.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-share-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  app = await createServer({ port: 0, dataDir: path.join(dir, "data") });
  const request = (route, method = "GET", body) => fetch(new URL(route, app.url), {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { dir, app, request };
}

// Read central directory records and verify each local record's bytes and CRC.
function unzip(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const result = new Map();
  let pos = buffer.readUInt32LE(end + 16);
  for (let n = 0; n < buffer.readUInt16LE(end + 10); n++) {
    assert.equal(buffer.readUInt32LE(pos), 0x02014b50);
    const size = buffer.readUInt32LE(pos + 24), start = buffer.readUInt32LE(pos + 42);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString();
    assert.equal(buffer.readUInt32LE(start), 0x04034b50);
    const dataStart = start + 30 + buffer.readUInt16LE(start + 26);
    const bytes = buffer.subarray(dataStart, dataStart + size);
    assert.equal(crc32(bytes), buffer.readUInt32LE(pos + 16));
    result.set(name, bytes.toString());
    pos += 46 + nameLength;
  }
  return result;
}

test("temporary file shares snapshot bytes, cancel, preserve originals, and clear on restart", async (t) => {
  const { dir, app, request } = await fixture(t);
  const sourcePath = path.join(dir, "资料.zip");
  await writeFile(sourcePath, "original bytes");
  const response = await request("/api/temporary-shares", "POST", { sourcePath, hours: 1 });
  assert.equal(response.status, 201);
  const item = await response.json();
  await writeFile(sourcePath, "changed");
  const download = await request(item.downloadUrl);
  assert.equal(await download.text(), "original bytes");
  assert.match(download.headers.get("content-disposition"), /filename\*=UTF-8''/);
  const head = await request(item.downloadUrl, "HEAD");
  assert.equal(head.headers.get("content-length"), "14");
  assert.equal((await (await request("/api/temporary-shares")).json()).shares.length, 1);
  assert.equal((await request(`/api/temporary-shares/${item.id}`, "DELETE")).status, 200);
  assert.equal((await request(item.downloadUrl)).status, 404);
  assert.equal(await readFile(sourcePath, "utf8"), "changed");
  assert.deepEqual(await readdir(path.join(app.dataDir, "temporary-shares")), []);
  await request("/api/temporary-shares", "POST", { sourcePath });
  await app.close();
  const restarted = await createServer({ port: 0, dataDir: app.dataDir });
  try {
    assert.deepEqual(await (await fetch(new URL("/api/temporary-shares", restarted.url))).json(), { shares: [] });
    assert.deepEqual(await readdir(path.join(app.dataDir, "temporary-shares")), []);
  } finally { await restarted.close(); }
});

test("directory ZIP preserves nested UTF-8 names, empty folders, and content", async (t) => {
  const { dir, request } = await fixture(t);
  const sourcePath = path.join(dir, "分享目录");
  await mkdir(path.join(sourcePath, "空目录"), { recursive: true });
  await writeFile(path.join(sourcePath, "你好.txt"), "内容\n测试");
  const response = await request("/api/temporary-shares", "POST", { sourcePath });
  assert.equal(response.status, 201);
  const item = await response.json();
  assert.equal(item.name, "分享目录.zip");
  const files = unzip(Buffer.from(await (await request(item.downloadUrl)).arrayBuffer()));
  assert.equal(files.get("分享目录/你好.txt"), "内容\n测试");
  assert.equal(files.get("分享目录/空目录/"), "");
  assert.equal((await request("/api/temporary-shares", "POST", { sourcePath: "relative" })).status, 400);
  assert.equal((await request("/api/temporary-shares", "POST", { sourcePath, hours: 2 })).status, 400);
  assert.equal((await request("/api/temporary-shares", "POST", { sourcePath: path.join(dir, "missing") })).status, 400);
});

test("paired LAN guests still need the dedicated share link even with editing enabled", async (t) => {
  const { dir, request } = await fixture(t);
  const sourcePath = path.join(dir, "file.bin");
  await writeFile(sourcePath, "LAN bytes");
  const item = await (await request("/api/temporary-shares", "POST", { sourcePath })).json();
  const blocker = httpServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  await new Promise((resolve) => blocker.close(resolve));
  await request("/api/lan-sharing", "PUT", { autoStart: false, port, allowWrite: true });
  const status = await (await request("/api/lan-sharing", "POST", { enabled: true })).json();
  const lan = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(lan + item.downloadUrl)).status, 401);
  const headers = { "x-self-wiki-lan-token": status.token, "content-type": "application/json" };
  assert.equal((await fetch(lan + item.downloadUrl, { headers })).status, 403);
  assert.equal(await (await fetch(lan + `/share/${item.id}/download?token=${item.shareToken}`, { headers })).text(), "LAN bytes");
  assert.equal((await fetch(lan + "/api/temporary-shares", { method: "POST", headers, body: JSON.stringify({ sourcePath }) })).status, 403);
  assert.equal((await fetch(lan + `/api/temporary-shares/${item.id}`, { method: "DELETE", headers })).status, 403);
  await request("/api/lan-sharing", "PUT", { autoStart: false, port, allowWrite: false });
  assert.equal((await fetch(lan + item.downloadUrl, { headers })).status, 403);
});

test("expiry revokes downloads and crash leftovers are removed without touching other files", async (t) => {
  const { dir } = await fixture(t);
  const root = path.join(dir, "independent");
  await mkdir(path.join(root, "temporary-shares"), { recursive: true });
  await writeFile(path.join(root, "temporary-shares", "11111111-1111-1111-1111-111111111111.bin"), "leftover");
  await writeFile(path.join(root, "temporary-shares", "keep.txt"), "keep");
  const shares = await createTemporaryShares(root);
  try {
    assert.deepEqual(await readdir(path.join(root, "temporary-shares")), ["keep.txt"]);
    const sourcePath = path.join(dir, "expire.txt");
    await writeFile(sourcePath, "source");
    const item = await shares.create({ sourcePath, hours: 1 });
    assert.equal(shares.sharedDownload(item.id, item.shareToken).id, item.id);
    const now = Date.now;
    try {
      Date.now = () => item.expiresAt + 1;
      assert.deepEqual(shares.list(), []);
      assert.throws(() => shares.download(item.id), /到期/);
      assert.throws(() => shares.sharedDownload(item.id, item.shareToken), /到期/);
    } finally { Date.now = now; }
  } finally { await shares.close(); }
});

test("share links grant only one live download without pairing or exposing other share tokens", async (t) => {
  const { dir, request } = await fixture(t);
  const sourcePath = path.join(dir, "文件 & private.txt");
  await writeFile(sourcePath, "private share bytes");
  const create = async () => (await request("/api/temporary-shares", "POST", { sourcePath, hours: 1 })).json();
  const item = await create(), other = await create();
  assert.match(item.shareToken, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(item.shareToken, other.shareToken);
  const localList = (await (await request("/api/temporary-shares")).json()).shares;
  assert.equal(localList.find((share) => share.id === item.id).shareToken, item.shareToken);
  const blocker = httpServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  await new Promise((resolve) => blocker.close(resolve));
  await request("/api/lan-sharing", "PUT", { autoStart: false, port, allowWrite: true });
  const status = await (await request("/api/lan-sharing", "POST", { enabled: true })).json();
  assert.notEqual(item.shareToken, status.token);
  const lan = `http://127.0.0.1:${port}`;
  const route = `/share/${item.id}`, query = `?token=${item.shareToken}`;
  const page = await fetch(lan + route + query);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("set-cookie"), null);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const html = await page.text();
  assert.ok(html.includes("文件 &amp; private.txt"));
  assert.ok(!html.includes(status.token));
  assert.ok(!html.includes(other.shareToken));
  const downloadUrl = lan + route + "/download" + query;
  assert.equal((await fetch(downloadUrl, { headers: { origin: "http://untrusted.example" } })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(downloadUrl, { headers: { host: `untrusted.example:${port}` } }, (res) => {
      res.resume(); resolve(res.statusCode);
    });
    req.on("error", reject); req.end();
  });
  assert.equal(invalidHostStatus, 403);
  const downloaded = await fetch(downloadUrl);
  assert.equal(await downloaded.text(), "private share bytes");
  assert.equal(downloaded.headers.get("set-cookie"), null);
  assert.equal((await fetch(downloadUrl, { method: "HEAD" })).status, 200);
  for (const invalidQuery of ["", "?token=wrong", `?token=${other.shareToken}`, `?token=${status.token}`]) {
    assert.equal((await fetch(lan + route + invalidQuery)).status, 404);
    assert.equal((await fetch(lan + route + "/download" + invalidQuery)).status, 404);
  }
  assert.equal((await fetch(lan + `/share/${other.id}/download` + query)).status, 404);
  assert.equal((await fetch(downloadUrl, { method: "POST" })).status, 405);
  const shareHeaders = { "x-self-wiki-lan-token": item.shareToken, "content-type": "application/json" };
  for (const endpoint of ["/api/elements", "/api/temporary-shares", item.downloadUrl]) {
    assert.equal((await fetch(lan + endpoint + query, { headers: shareHeaders })).status, 401);
  }
  assert.equal((await fetch(lan + "/api/elements", { method: "POST", headers: shareHeaders, body: "{}" })).status, 401);
  assert.equal((await fetch(lan + `/?pair=${item.shareToken}`, { redirect: "manual" })).status, 401);
  assert.equal((await fetch(lan + "/api/temporary-shares", { headers: { "x-self-wiki-lan-token": status.token } })).status, 403);
  await request(`/api/temporary-shares/${item.id}`, "DELETE");
  assert.equal((await fetch(lan + route + query)).status, 404);
  assert.equal((await fetch(downloadUrl)).status, 404);
  assert.equal((await fetch(lan + `/share/${other.id}/download?token=${other.shareToken}`)).status, 200);
  // Dedicated share credentials remain required even with general LAN pairing disabled.
  await request("/api/lan-sharing", "PUT", { autoStart: false, port, allowWrite: true, requireToken: false });
  assert.equal((await fetch(lan + '/api/temporary-shares')).status, 403);
  assert.equal((await fetch(lan + other.downloadUrl)).status, 403);
  assert.equal((await fetch(lan + `/share/${other.id}/download`)).status, 404);
  assert.equal((await fetch(lan + `/share/${other.id}/download?token=${other.shareToken}`)).status, 200);
  const now = Date.now;
  try {
    Date.now = () => other.expiresAt + 1;
    assert.equal((await fetch(lan + `/share/${other.id}?token=${other.shareToken}`)).status, 404);
    assert.equal((await fetch(lan + `/share/${other.id}/download?token=${other.shareToken}`)).status, 404);
  } finally { Date.now = now; }
});

test("directory junctions are rejected and failed jobs leave no share or temporary file", async (t) => {
  const { dir, app, request } = await fixture(t);
  const sourcePath = path.join(dir, "directory"), outside = path.join(dir, "outside");
  await mkdir(sourcePath); await mkdir(outside);
  await writeFile(path.join(outside, "private.txt"), "outside");
  await symlink(outside, path.join(sourcePath, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await request("/api/temporary-shares", "POST", { sourcePath })).status, 400);
  assert.deepEqual((await (await request("/api/temporary-shares")).json()).shares, []);
  assert.deepEqual(await readdir(path.join(app.dataDir, "temporary-shares")), []);
  assert.equal((await request("/api/temporary-shares", "POST", null)).status, 400);
});
