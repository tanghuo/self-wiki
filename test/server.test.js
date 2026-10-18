import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server/server.js";
import { initDb } from "../src/server/data/sqlite.js";
import { startBackendProcess } from "../src/main/backendProcess.js";
import { createServer as createViteServer } from "vite";

async function temporaryData(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llb-api-test-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("llb-api-test-"));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("explicit browser-blocked and invalid ports fail before creating application data", async (t) => {
  const dataDir = path.join(await temporaryData(t), "not-created");
  for (const port of [1, 22, 6566, 6667, 10080]) {
    await assert.rejects(createServer({ port, dataDir }), new RegExp(`Port ${port} is blocked by browsers`));
  }
  for (const port of [-1, 1.5, 65536, NaN]) await assert.rejects(createServer({ port, dataDir }), /Invalid port/);
  await assert.rejects(stat(dataDir), { code: "ENOENT" });
});

test("automatic binding closes browser-blocked candidates before publishing the working URL", async (t) => {
  const dataDir = await temporaryData(t), address = Server.prototype.address;
  const listen = t.mock.method(Server.prototype, "listen"), close = t.mock.method(Server.prototype, "close");
  let blockedServer;
  t.mock.method(Server.prototype, "address", function () {
    const actual = address.call(this);
    if (actual && !blockedServer) { blockedServer = this; return { ...actual, port: 6566 }; }
    return actual;
  });
  const app = await createServer({ port: 0, dataDir });
  try {
    assert.ok(listen.mock.callCount() >= 2);
    assert.ok(close.mock.calls.some((call) => call.this === blockedServer));
    assert.notEqual(app.port, 6566);
    assert.equal(app.port, address.call(blockedServer).port);
    const runtimeDir = path.join(dataDir, ".runtime"), files = await readdir(runtimeDir);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(runtimeDir, files[0]), "utf8")).url, app.url);
    assert.equal((await fetch(new URL("api/instance", app.url))).status, 200);
  } finally { await app.close(); }
});

test("repeated browser-blocked assignments stop after a bounded retry and leave no listener or runtime record", { timeout: 5000 }, async (t) => {
  const dataDir = await temporaryData(t), address = Server.prototype.address;
  const listen = t.mock.method(Server.prototype, "listen"), close = t.mock.method(Server.prototype, "close");
  let blockedServer;
  t.mock.method(Server.prototype, "address", function () {
    const actual = address.call(this);
    if (actual) { blockedServer = this; return { ...actual, port: 6566 }; }
    return actual;
  });
  await assert.rejects(createServer({ port: 0, dataDir }), /after 10 attempts/);
  assert.equal(listen.mock.callCount(), 10);
  assert.equal(close.mock.callCount(), 10);
  assert.equal(blockedServer.listening, false);
  assert.equal(address.call(blockedServer), null);
  await assert.rejects(stat(path.join(dataDir, ".runtime")), { code: "ENOENT" });
});


test("API validates Wiki requests and reports actual listen failures", async (t) => {
  const dataDir = await temporaryData(t);
  const app = await createServer({ port: 0, dataDir });
  try {
    const request = (url, options) => fetch(new URL(url, app.url), options);
    const post = (url, body) => request(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal((await post("/api/elements", "null")).status, 400);
    assert.equal((await post("/api/elements", "{")).status, 400);
    assert.equal((await post("/api/elements", JSON.stringify({ body: "x".repeat(70000) }))).status, 413);
    assert.equal((await post("/api/elements", '{"body":"A note"}')).status, 201);
    assert.equal((await request("/%")).status, 400);
    assert.equal((await request("/..%5c..%5cpackage.json")).status, 403);
    assert.equal((await request("/api/instance", { headers: { origin: "https://example.test" } })).status, 403);
    assert.equal((await request("/api/instance", { headers: { origin: new URL(app.url).origin } })).status, 200);
    const otherDataDir = await temporaryData(t);
    const listen = t.mock.method(Server.prototype, "listen");
    await assert.rejects(createServer({ port: app.port, dataDir: otherDataDir }), { code: "EADDRINUSE" });
    assert.equal(listen.mock.callCount(), 1);
  } finally { await app.close(); await app.close(); }
});

test("desktop child reports its own readiness and shuts down through IPC", async (t) => {
  const dataDir = await temporaryData(t);
  const backend = await startBackendProcess({
    nodeBinary: process.execPath,
    appDir: path.resolve(import.meta.dirname, ".."), dataDir,
  });
  try { assert.equal((await fetch(new URL("api/instance", backend.url))).status, 200); }
  finally { await backend.close(); }
  await backend.close();
  await assert.rejects(fetch(new URL("api/instance", backend.url)));
});

test("desktop startup handles a missing Node executable without an unhandled error", async (t) => {
  const dataDir = await temporaryData(t);
  await assert.rejects(startBackendProcess({
    nodeBinary: path.join(dataDir, "missing-node.exe"),
    appDir: path.resolve(import.meta.dirname, ".."), dataDir,
  }), { code: "ENOENT" });
});

test("Vite proxy preserves the browser origin for POST while rejecting foreign origins", async (t) => {
  const dataDir = await temporaryData(t);
  const app = await createServer({ port: 0, dataDir });
  let dev;
  const previousTarget = process.env.EXTERNAL_API_URL;
  try {
    process.env.EXTERNAL_API_URL = app.url;
    const { default: config } = await import("../vite.config.js?proxy-test");
    dev = await createViteServer({ ...config, configFile: false, logLevel: "error", server: { ...config.server, port: 0 } });
    await dev.listen();
    const origin = `http://127.0.0.1:${dev.httpServer.address().port}`;
    const post = (requestOrigin) => fetch(`${origin}/api/elements`, {
      method: "POST", headers: { "content-type": "application/json", origin: requestOrigin }, body: '{"body":"Proxy note"}',
    });
    assert.equal((await post(origin)).status, 201);
    assert.equal((await post("https://example.test")).status, 403);
  } finally {
    if (previousTarget === undefined) delete process.env.EXTERNAL_API_URL;
    else process.env.EXTERNAL_API_URL = previousTarget;
    if (dev) await dev.close();
    await app.close();
  }
});


test("fresh databases contain only Wiki tables and reopening preserves unrelated existing tables", async (t) => {
  const dataDir = await temporaryData(t);
  const dbPath = path.join(dataDir, "library.sqlite3");
  const fresh = initDb(dbPath);
  assert.equal(fresh.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items'").get(), undefined);
  fresh.close();
  const old = new DatabaseSync(dbPath);
  old.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO items VALUES (1, 'keep existing data')");
  old.close();
  const reopened = initDb(dbPath);
  try { assert.equal(reopened.prepare("SELECT note FROM items WHERE id=1").get().note, "keep existing data"); }
  finally { reopened.close(); }
});

test("removed collection endpoints return 404 without creating runtime directories", async (t) => {
  const dataDir = await temporaryData(t);
  const app = await createServer({ port: 0, dataDir });
  try {
    for (const [method, route] of [["GET", "/api/items"], ["GET", "/api/export"], ["GET", "/api/progress"], ["GET", "/api/logs"], ["GET", "/image?url=https://example.test/image.png"], ...["/api/start", "/api/stop", "/api/enrich-images", "/api/repair-items", "/api/items/status"].map(route => ["POST", route])]) {
      const response = await fetch(new URL(route, app.url), { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      assert.equal(response.status, 404, method + " " + route);
    }
    const names = await readdir(dataDir);
    for (const name of ["image-cache", "browser-profile", "crawl.log"]) assert.equal(names.includes(name), false, name);
  } finally { await app.close(); }
});
