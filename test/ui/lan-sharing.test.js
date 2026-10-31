import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "../helpers/authenticatedServer.js";
import { resolveBrowserPath } from "../resolveBrowserPath.js";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { lanAddresses, lanRestriction, lanTokenMatches, validateLanRequest } from "../../src/server/http/lanRoutes.js";
import { openDetailMenu } from "../ui-select.js";

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-lan-test-"));
  const app = await createServer({ port: 0, dataDir });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-lan-test-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  const request = (route, method = "GET", payload) => fetch(new URL(route, app.url), {
    method, headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const blocker = createHttpServer();
  await new Promise((resolve) => blocker.listen(0, "0.0.0.0", resolve));
  const port = blocker.address().port;
  await new Promise((resolve) => blocker.close(resolve));
  return { dataDir, app, request, port, lan: `http://127.0.0.1:${port}` };
}

test("LAN sharing persists configuration, requires pairing, keeps local-only features local and stops immediately", async (t) => {
  const { dataDir, app, request, port, lan } = await setup(t);
  const initial = await (await request("/api/lan-sharing")).json();
  const { token, pairingCode, pairingExpiresAt, pairUrls, ...settings } = initial;
  assert.equal(pairingExpiresAt, 0);
  assert.match(pairingCode, /^\d{6}$/);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual({ ...settings, urls: [] }, { autoStart: false, port: 8766, allowWrite: false, requireToken: true, enabled: false, error: "", urls: [] });
  assert.deepEqual(pairUrls, initial.urls.map((url) => `${url}?pair=${token}`));
  for (const url of initial.urls) assert.equal(new URL(url).port, "8766");
  const note = await (await request("/api/elements", "POST", { body: "第一行\n  第二行", tags: ["共享"] })).json();
  const hidden = await (await request("/api/elements", "POST", { body: "私有回收站", tags: ["隐藏标签"] })).json();
  const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  const image = await (await fetch(new URL("/api/images", app.url), { method: "POST", headers: { "x-file-name": encodeURIComponent("原始图片.png") }, body: bytes })).json();
  await request("/api/relations", "POST", { leftId: note.id, rightId: image.id });
  await request("/api/relations", "POST", { leftId: note.id, rightId: hidden.id });
  await request(`/api/elements/${hidden.id}`, "DELETE");
  const configured = await request("/api/lan-sharing", "PUT", { autoStart: true, port, allowWrite: true });
  assert.equal(configured.status, 200);
  assert.deepEqual((await configured.json()).urls, initial.urls.map((url) => { const next = new URL(url); next.port = String(port); return next.href; }));
  assert.equal((await request("/api/lan-sharing", "POST", { enabled: true })).status, 200);
  const paired = { "x-self-wiki-lan-token": token };
  const get = (route, headers = {}) => fetch(`${lan}${route}`, { headers: { ...paired, ...headers } });
  // Unpaired visitors get a pairing page or 401, never data.
  const unpaired = await fetch(lan);
  assert.equal(unpaired.status, 401);
  assert.match(await unpaired.text(), /需要局域网配对码/);
  assert.equal((await fetch(`${lan}/api/elements`)).status, 401);
  assert.equal((await fetch(`${lan}/api/elements`, { headers: { "x-self-wiki-lan-token": "wrong-token-wrong-token" } })).status, 401);
  assert.equal((await fetch(`${lan}/?pair=wrong`, { redirect: "manual" })).status, 401);
  const pairing = await fetch(`${lan}/?pair=${token}&keep=1`, { redirect: "manual" });
  assert.equal(pairing.status, 303);
  assert.equal(pairing.headers.get("location"), "/?keep=1");
  const cookie = pairing.headers.get("set-cookie");
  assert.match(cookie, /^self_wiki_lan_token=[^;]+; Path=\/; HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(`${lan}/api/elements`, { headers: { cookie: cookie.split(";")[0] } })).status, 200);
  const home = await get("/");
  assert.match(await home.text(), /name="wiki-access" content="lan-edit"/);
  assert.equal(home.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal((await get("/brand/self-wiki-64.png")).status, 200);
  assert.equal((await (await get("/api/elements?q=第一行")).json()).elements[0].id, note.id);
  assert.deepEqual((await (await get("/api/tags")).json()).tags, ["共享", "隐藏标签"]);
  assert.equal((await (await get(`/api/elements/${note.id}/relations`)).json()).relations.length, 1);
  const download = await get(`/api/elements/${note.id}/download`);
  assert.match(download.headers.get("content-disposition"), /attachment;.*filename\*=UTF-8''/);
  assert.equal(await download.text(), note.body);
  assert.deepEqual(Buffer.from(await (await get(`/api/elements/${image.id}/download`)).arrayBuffer()), bytes);
  const preview = await get(`/api/elements/${image.id}/thumbnail?width=800`);
  assert.equal(preview.status, 200);
  assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).format, "webp");
  for (const route of ["/api/organization/status", "/api/organization/semantic/status", "/api/token-usage?days=0", "/api/instance"]) {
    const remote = await get(route), local = await request(route);
    assert.equal(remote.status, 200, route);
    assert.equal(await remote.text(), await local.text(), route);
  }
  const remoteStatus = await (await get("/api/lan-sharing")).json();
  assert.equal(remoteStatus.token, undefined);
  assert.equal(remoteStatus.pairingCode, undefined);
  assert.equal(remoteStatus.pairUrls, undefined);
  for (const route of ["/organization.json", "/lan-sharing.json", "/library.sqlite3", "/assets/..%5clibrary.sqlite3"]) {
    assert.equal((await get(route)).status, 404, route);
  }
  const remote = (route, method, body) => fetch(`${lan}${route}`, { method, headers: { ...paired, "content-type": "application/json", origin: lan }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.deepEqual((await (await remote("/api/elements?scope=trash", "GET")).json()).elements.map((e) => e.id), [hidden.id]);
  const created = await remote("/api/elements", "POST", { body: "局域网新增", tags: [] });
  assert.equal(created.status, 201);
  const added = await created.json();
  assert.equal((await remote(`/api/elements/${added.id}`, "PATCH", { body: "局域网编辑" })).status, 200);
  assert.equal((await (await request(`/api/elements/${added.id}`)).json()).body, "局域网编辑");
  assert.equal((await remote(`/api/elements/${added.id}`, "DELETE")).status, 200);
  assert.equal((await remote(`/api/elements/${added.id}/restore`, "POST", {})).status, 200);
  assert.equal((await remote("/api/trash/purge", "POST", { all: true })).status, 200);
  // Agent sessions, configuration and AI triggers stay local even when LAN editing is allowed.
  const config = (await (await request("/api/organization/status")).json()).config;
  for (const [route, method, body] of [
    ["/api/chat/status", "GET"], ["/api/chat/sessions", "GET"], ["/api/chat/sessions", "POST", {}],
    ["/api/organization/config", "PUT", config], ["/api/organization/enqueue", "POST", { elementId: note.id }],
    ["/api/organization/semantic/rebuild", "POST", {}], ["/api/organization/probe", "POST", {}],
    ["/api/video-analysis/config", "PUT", {}], ["/api/video-analysis/probe", "POST", {}], ["/api/visual-index/rebuild", "POST", {}],
    [`/api/elements/${image.id}/video-analysis`, "POST", {}], [`/api/elements/${image.id}/description/regenerate`, "POST", {}],
    ["/api/lan-sharing", "PUT", { autoStart: true, port }], ["/api/lan-sharing", "POST", { enabled: false }], ["/api/lan-sharing/token", "POST", {}],
  ]) assert.equal((await remote(route, method, body)).status, 403, `${method} ${route}`);
  assert.equal((await remote("/api/organization/semantic/search", "POST", { query: "第一行" })).status, 200);
  assert.equal((await fetch(`${lan}/api/images`, { method: "POST", headers: { ...paired, "x-file-name": "lan.png" }, body: bytes })).status, 200);
  for (const suffix of ["", "/relations", "/download", "/image"]) assert.equal((await get(`/api/elements/${hidden.id}${suffix}`)).status, 404);
  assert.equal((await remote("/api/relations/1", "PATCH", { name: "局域网修改" })).status, 200);
  assert.equal((await get("/api/elements", { origin: "https://evil.test" })).status, 403);
  assert.equal((await fetch(`${lan}/api/elements`, { method: "POST", headers: { ...paired, origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ body: "禁止跨站写入" }) })).status, 403);
  assert.equal((await get("/api/elements", { "x-self-wiki-instance": "stale-instance" })).status, 409);
  const invalidHost = await new Promise((resolve, reject) => {
    const req = httpRequest(`${lan}/api/elements`, { headers: { ...paired, host: `evil.test:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(invalidHost, 403);
  // Read-only is the default and blocks every LAN write.
  assert.equal((await request("/api/lan-sharing", "PUT", { autoStart: true, port, allowWrite: false })).status, 200);
  assert.match(await (await get("/")).text(), /name="wiki-access" content="read-only"/);
  assert.equal((await remote("/api/elements", "POST", { body: "只读模式写入", tags: [] })).status, 403);
  assert.equal((await remote(`/api/elements/${note.id}`, "PATCH", { body: "只读模式编辑" })).status, 403);
  assert.equal((await get(`/api/elements/${note.id}`)).status, 200);
  assert.equal((await remote("/api/organization/semantic/search", "POST", { query: "第一行" })).status, 200);
  // A new pairing code invalidates the old one.
  const rotated = await (await request("/api/lan-sharing/token", "POST", {})).json();
  assert.notEqual(rotated.token, token);
  assert.equal((await get("/api/elements")).status, 401);
  assert.equal((await fetch(`${lan}/api/elements`, { headers: { "x-self-wiki-lan-token": rotated.token } })).status, 200);
  paired["x-self-wiki-lan-token"] = rotated.token;
  assert.equal((await request("/api/lan-sharing", "PUT", { autoStart: true, port: port + (port === 65535 ? -1 : 1) })).status, 409);
  const before = JSON.parse(await readFile(path.join(dataDir, "lan-sharing.json"), "utf8"));
  assert.deepEqual(before, { autoStart: true, port, allowWrite: false, requireToken: true, token: rotated.token, pairingCode: rotated.pairingCode });
  const disabled = await request("/api/lan-sharing", "POST", { enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).enabled, false);
  await assert.rejects(fetch(`${lan}/api/elements`));
  assert.equal((await request("/api/lan-sharing", "POST", { enabled: true })).status, 200);
  assert.equal((await request("/api/lan-sharing", "POST", { enabled: false })).status, 200);
  // The runtime switch does not silently change the startup preference.
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "lan-sharing.json"), "utf8")), before);
  await app.close();
  const restarted = await createServer({ port: 0, dataDir });
  try {
    const status = await (await fetch(new URL("/api/lan-sharing", restarted.url))).json();
    assert.equal(status.enabled, true);
    assert.equal(status.token, rotated.token);
    assert.equal(status.pairingCode, rotated.pairingCode);
    assert.equal((await get("/api/elements")).status, 200);
  } finally { await restarted.close(); }
  await assert.rejects(fetch(`${lan}/api/elements`));
});

test("LAN pairing can be disabled locally and older configuration files gain a stable pairing code", async (t) => {
  const { dataDir, app, request, port, lan } = await setup(t);
  await app.close();
  await writeFile(path.join(dataDir, "lan-sharing.json"), JSON.stringify({ autoStart: true, port }));
  const upgraded = await createServer({ port: 0, dataDir });
  try {
    const saved = JSON.parse(await readFile(path.join(dataDir, "lan-sharing.json"), "utf8"));
    assert.match(saved.token, /^[A-Za-z0-9_-]{32}$/);
    assert.match(saved.pairingCode, /^\d{6}$/);
    const { pairingCode, ...legacySettings } = saved;
    assert.deepEqual({ ...legacySettings, token: "" }, { autoStart: true, port, allowWrite: false, requireToken: true, token: "" });
    const local = (route, method = "GET", body) => fetch(new URL(route, upgraded.url), { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await (await local("/api/lan-sharing")).json()).token, saved.token);
    assert.equal((await fetch(`${lan}/api/elements`)).status, 401);
    assert.equal((await local("/api/lan-sharing", "PUT", { autoStart: true, port, requireToken: false })).status, 200);
    assert.equal((await fetch(`${lan}/api/elements`)).status, 200);
    assert.equal((await fetch(`${lan}/api/elements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "x" }) })).status, 403);
    assert.equal((await fetch(`${lan}/api/chat/status`)).status, 403);
    assert.equal((await local("/api/lan-sharing", "PUT", { autoStart: true, port, bogus: true })).status, 400);
    assert.equal((await local("/api/lan-sharing", "PUT", { autoStart: true, port, allowWrite: "yes" })).status, 400);
    await local("/api/lan-sharing", "POST", { enabled: false });
  } finally { await upgraded.close(); }
});

test("six-digit pairing requires a local window, is single-use, and preserves strong cookies", async (t) => {
  const { request, port, lan } = await setup(t);
  await request("/api/lan-sharing", "PUT", { autoStart: false, port });
  const initial = await (await request("/api/lan-sharing")).json(), token = initial.token;
  await request("/api/lan-sharing", "POST", { enabled: true });
  const pair = (code) => fetch(`${lan}/?pair=${code}`, { redirect: "manual" });
  assert.equal((await pair(initial.pairingCode)).status, 401);
  const { pairingCode, pairingExpiresAt } = await (await request('/api/lan-sharing/pairing', 'POST', {})).json();
  assert.ok(pairingExpiresAt > Date.now());
  const paired = await pair(pairingCode);
  assert.equal(paired.status, 303);
  const cookie = paired.headers.get("set-cookie").split(";")[0];
  assert.equal(cookie, `self_wiki_lan_token=${token}`);
  assert.equal((await fetch(`${lan}/api/elements`, { headers: { cookie } })).status, 200);
  assert.equal((await pair(pairingCode)).status, 401, 'short code is single-use');
  assert.equal((await fetch(`${lan}/api/elements`, { headers: { "x-self-wiki-lan-token": pairingCode } })).status, 401);
  const activeCode = await (await request('/api/lan-sharing/pairing', 'POST', {})).json();
  const wrong = activeCode.pairingCode === "000000" ? "000001" : "000000";
  for (let i = 0; i < 10; i++) assert.equal((await pair(wrong)).status, 401);
  const limited = await pair(pairingCode);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.match(await limited.text(), /尝试次数过多/);
  assert.equal((await pair(token)).status, 303, "QR links retain strong credentials and work during cooldown");
  assert.equal((await fetch(`${lan}/api/elements`, { headers: { cookie } })).status, 200);
  const rotated = await (await request("/api/lan-sharing/token", "POST", {})).json();
  assert.match(rotated.pairingCode, /^\d{6}$/);
  assert.notEqual(rotated.pairingCode, pairingCode);
  assert.equal((await pair(pairingCode)).status, 401);
  assert.equal((await pair(rotated.pairingCode)).status, 401);
  const nextCode = await (await request('/api/lan-sharing/pairing', 'POST', {})).json();
  assert.equal((await pair(nextCode.pairingCode)).status, 303);
  assert.equal((await fetch(`${lan}/api/elements`, { headers: { cookie } })).status, 401);
});

test("short codes expire, rotate locally and cannot be opened from LAN", async (t) => {
  const { request, port, lan } = await setup(t);
  await request('/api/lan-sharing', 'PUT', { autoStart: false, port });
  const status = await (await request('/api/lan-sharing', 'POST', { enabled: true })).json();
  const first = await (await request('/api/lan-sharing/pairing', 'POST', {})).json();
  const second = await (await request('/api/lan-sharing/pairing', 'POST', {})).json();
  assert.notEqual(first.pairingCode, second.pairingCode);
  assert.equal((await fetch(`${lan}/?pair=${first.pairingCode}`, { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(`${lan}/api/lan-sharing/pairing`, { method: 'POST', headers: { 'x-self-wiki-lan-token': status.token } })).status, 403);
  const now = Date.now;
  try {
    Date.now = () => second.pairingExpiresAt + 1;
    assert.equal((await fetch(`${lan}/?pair=${second.pairingCode}`, { redirect: 'manual' })).status, 401);
    assert.equal((await fetch(`${lan}/?pair=${status.token}`, { redirect: 'manual' })).status, 303);
  } finally { Date.now = now; }
});

test("existing long-token configuration gains a short code without revoking paired devices", async (t) => {
  const { dataDir, app, port, lan } = await setup(t);
  const token = "existing-device-token-1234567890";
  await app.close();
  await writeFile(path.join(dataDir, "lan-sharing.json"), JSON.stringify({ autoStart: true, port, token }));
  const upgraded = await createServer({ port: 0, dataDir });
  try {
    const saved = JSON.parse(await readFile(path.join(dataDir, "lan-sharing.json"), "utf8"));
    assert.equal(saved.token, token);
    assert.match(saved.pairingCode, /^\d{6}$/);
    assert.equal((await fetch(`${lan}/api/elements`, { headers: { cookie: `self_wiki_lan_token=${token}` } })).status, 200);
    assert.equal((await fetch(`${lan}/?pair=${saved.pairingCode}`, { redirect: "manual" })).status, 401, 'persisted short codes do not open a pairing window');
  } finally { await upgraded.close(); }
});

test("LAN restriction rules keep agent, configuration and AI triggers local", () => {
  for (const [method, route] of [["GET", "/api/chat/status"], ["POST", "/api/chat/sessions/1/turns"], ["PUT", "/api/organization/config"],
    ["POST", "/api/organization/claim"], ["PUT", "/api/video-analysis/config"], ["POST", "/api/elements/3/video-analysis"],
    ["POST", "/api/elements/3/video-analysis/cancel"], ["POST", "/api/elements/3/description/regenerate"], ["PUT", "/api/lan-sharing"], ["POST", "/api/lan-sharing/token"]]) {
    assert.ok(lanRestriction(method, route, { allowWrite: true }), `${method} ${route}`);
  }
  assert.equal(lanRestriction("GET", "/api/elements", { allowWrite: false }), "");
  assert.equal(lanRestriction("GET", "/api/organization/status", { allowWrite: false }), "");
  assert.equal(lanRestriction("POST", "/api/organization/semantic/search", { allowWrite: false }), "");
  assert.ok(lanRestriction("POST", "/api/elements", { allowWrite: false }));
  assert.equal(lanRestriction("POST", "/api/elements", { allowWrite: true }), "");
  assert.equal(lanTokenMatches("abc", "abc"), true);
  assert.equal(lanTokenMatches("abd", "abc"), false);
  assert.equal(lanTokenMatches("", ""), false);
});
test("LAN tag collections support editing and preserve normal trash visibility", async (t) => {
  const { request, port, lan } = await setup(t);
  const create = async (body) => (await (await request("/api/elements", "POST", { body, tags: ["合集"] })).json());
  const source = await create("来源"), member = await create("成员"), hidden = await create("已删除成员");
  await request("/api/relations/batch", "POST", { sourceId: source.id, targetTags: ["合集"], name: "参考图" });
  await request(`/api/elements/${hidden.id}`, "DELETE");
  const grouped = await (await request(`/api/elements/${source.id}/relations`)).json();
  assert.equal(grouped.pagination.total, 1);
  const rule = grouped.tagRelations[0];
  assert.equal(rule.memberCount, 1);
  const route = `/api/tag-relations/${rule.id}/members`;
  assert.equal((await request(`${route}?page=0`)).status, 400);
  assert.equal((await request(`${route}?pageSize=101`)).status, 400);
  await request("/api/lan-sharing", "PUT", { autoStart: false, port, allowWrite: true });
  const token = (await (await request("/api/lan-sharing")).json()).token;
  const lanFetch = (url, options = {}) => fetch(url, { ...options, headers: { "x-self-wiki-lan-token": token, ...options.headers } });
  await request("/api/lan-sharing", "POST", { enabled: true });
  const members = await (await lanFetch(`${lan}${route}`)).json();
  assert.deepEqual(members.elements.map((e) => e.id), [member.id]);
  assert.equal((await (await lanFetch(`${lan}/api/elements/${source.id}/tag-relations`)).json()).tagRelations.length, 1);
  assert.equal((await lanFetch(`${lan}${route}?scope=trash`)).status, (await request(`${route}?scope=trash`)).status);
  assert.equal((await lanFetch(`${lan}/api/tag-relations/${rule.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "局域网修改" }) })).status, 200);
  await request(`/api/elements/${source.id}`, "DELETE");
  assert.equal((await lanFetch(`${lan}${route}`)).status, 404);
  assert.equal((await lanFetch(`${lan}/api/elements/${source.id}/tag-relations`)).status, 404);
  await request(`/api/elements/${source.id}/restore`, "POST");
  assert.equal((await lanFetch(`${lan}${route}`)).status, 200);
  assert.equal((await lanFetch(`${lan}/api/tag-relations/${rule.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await lanFetch(`${lan}${route}`)).status, 404);
});

test("LAN access still rejects public peers and mismatched ports", () => {
  const host = new URL("http://127.0.0.1:8766");
  assert.throws(() => validateLanRequest({ socket: { remoteAddress: "203.0.113.1", localPort: 8766 } }, host), { statusCode: 403 });
  assert.throws(() => validateLanRequest({ socket: { remoteAddress: "192.168.1.2", localPort: 8767 } }, host), { statusCode: 403 });
  assert.doesNotThrow(() => validateLanRequest({ socket: { remoteAddress: "::ffff:192.168.1.2", localPort: 8766 } }, host));
});

test("LAN startup failures leave the local app available and invalid settings never replace saved configuration", async (t) => {
  const { dataDir, app, request } = await setup(t);
  const blocker = createHttpServer();
  await new Promise((resolve) => blocker.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  await request("/api/lan-sharing", "PUT", { autoStart: true, port: blocker.address().port });
  assert.equal((await request("/api/lan-sharing", "POST", { enabled: true })).status, 409);
  const status = await (await request("/api/lan-sharing")).json();
  assert.equal(status.enabled, false);
  assert.match(status.error, /占用/);
  for (const payload of [{ port: 0, autoStart: false }, { port: 65536, autoStart: false }, { port: 9999, autoStart: "yes" }]) {
    assert.equal((await request("/api/lan-sharing", "PUT", payload)).status, 400);
  }
  const other = await createServer({ port: 0, dataDir });
  try {
    const saved = await (await fetch(new URL("/api/lan-sharing", other.url))).json();
    assert.equal(saved.enabled, false);
    assert.match(saved.error, /占用/);
    assert.equal((await fetch(new URL("/api/elements", other.url))).status, 200);
  } finally { await other.close(); }
  await app.close();
  await writeFile(path.join(dataDir, "lan-sharing.json"), "{");
  const invalid = await createServer({ port: 0, dataDir });
  try {
    const saved = await (await fetch(new URL("/api/lan-sharing", invalid.url))).json();
    assert.equal(saved.enabled, false);
    assert.match(saved.error, /配置/);
  } finally { await invalid.close(); }
});

const browserPath = resolveBrowserPath();
test("App sharing controls pair a mobile page that can edit content but not use local-only tools", { timeout: 60000, skip: !browserPath && "Browser required" }, async (t) => {
  const { dataDir, app, request, port, lan } = await setup(t);
  const config = (await (await request("/api/organization/status")).json()).config;
  config.executor.codexCli.executable = path.join(dataDir, "app-server.mjs");
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("../fixtures/chat-app-server.txt", import.meta.url)));
  assert.equal((await request("/api/organization/config", "PUT", config)).status, 200);
  await request("/api/elements", "POST", { body: "共享笔记\n保留\n  空格", tags: ["手机"] });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.copiedAddress = text; } } });
  });
  await page.route("**/api/lan-sharing**", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, urls: [`http://192.168.1.25:${status.port}/`], pairUrls: [`http://192.168.1.25:${status.port}/?pair=${status.token}`] } });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.url);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "局域网共享", exact: false }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("heading", { name: "局域网共享", level: 3 }).waitFor();
  const addresses = dialog.getByRole("region", { name: "局域网访问地址", exact: true });
  await addresses.getByRole("button", { name: "复制地址", exact: true }).click();
  await dialog.getByRole('button', { name: '生成 10 分钟配对码', exact: true }).click();
  const { token, pairingCode } = await (await request("/api/lan-sharing")).json();
  assert.equal(await page.evaluate(() => window.copiedAddress), "http://192.168.1.25:8766/");
  assert.equal(await addresses.getByRole("textbox").inputValue(), "http://192.168.1.25:8766/");
  await dialog.getByText(pairingCode, { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("switch").getAttribute("aria-checked"), "false");
  assert.equal(await dialog.getByLabel("访问端口", { exact: true }).isVisible(), false);
  await page.locator("#settings-sharing summary").click();
  await dialog.getByLabel("访问端口", { exact: true }).fill(String(port));
  await dialog.getByLabel("启动 App 时自动开启共享").check();
  await dialog.getByLabel("允许局域网设备编辑内容（添加、修改、删除、回收站）").check();
  // The configuration is saved through the settings save bar; the switch never submits the form.
  await dialog.getByRole("region", { name: "保存设置" }).getByRole("button", { name: "保存", exact: true }).click();
  await dialog.getByText("所有改动已保存", { exact: true }).waitFor();
  assert.equal((await (await request("/api/lan-sharing")).json()).autoStart, true);
  await dialog.getByLabel("启动 App 时自动开启共享").uncheck();
  const sharingWrites = [];
  page.on("request", (sent) => { if (new URL(sent.url()).pathname === "/api/lan-sharing" && sent.method() !== "GET") sharingWrites.push(`${sent.method()} ${sent.postData()}`); });
  await dialog.getByRole("switch").click();
  await dialog.getByText("共享已开启", { exact: true }).waitFor();
  assert.deepEqual(sharingWrites, ['POST {"enabled":true}'], "the switch only posts enabled");
  assert.equal((await (await request("/api/lan-sharing")).json()).autoStart, true, "unsaved form edits are not submitted by the switch");
  assert.equal(await dialog.getByLabel("启动 App 时自动开启共享").isChecked(), false, "unsaved edits stay in the form");
  await dialog.getByLabel("启动 App 时自动开启共享").check();
  assert.equal(await dialog.getByRole("switch").getAttribute("aria-checked"), "true");
  assert.equal(await dialog.getByLabel("访问端口", { exact: true }).isDisabled(), true);
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const guestOrigin = lanAddresses().length ? `http://${lanAddresses()[0]}:${port}` : lan;
  await guest.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.copiedText = text; } } });
    // Exercise HTTP compatibility even on a host without a LAN adapter.
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
  });
  guest.on("pageerror", (error) => errors.push(error.message));
  await guest.goto(`${guestOrigin}/#agent`);
  await guest.getByRole("heading", { name: "需要局域网配对码" }).waitFor();
  await guest.getByLabel("配对码", { exact: true }).fill(pairingCode);
  await guest.getByRole("button", { name: "连接", exact: true }).click();
  // LAN visitors land in the library; the agent stays on this machine.
  await guest.getByRole("button", { name: /^打开内容：共享笔记/ }).waitFor();
  assert.equal(new URL(guest.url()).search, "");
  assert.equal(await guest.getByLabel("会话消息").count(), 0);
  await guest.getByRole("button", { name: "更多工具", exact: true }).click();
  for (const label of ["添加内容", "回收站"]) assert.equal(await guest.getByRole("button", { name: label, exact: true }).count(), 1);
  for (const label of ["设置", "问 Agent"]) assert.equal(await guest.getByRole("button", { name: label, exact: true }).count(), 0);
  await guest.getByRole("button", { name: "添加内容", exact: true }).click();
  const creation = guest.getByRole("dialog", { name: "添加内容", exact: true });
  await creation.getByLabel("文字", { exact: true }).fill("手机添加内容");
  await creation.getByRole("button", { name: "保存全部", exact: true }).click();
  await creation.waitFor({ state: "hidden" });
  assert.equal((await (await request("/api/elements?q=手机添加内容")).json()).elements.length, 1);
  await guest.getByRole("region", { name: "内容详情", exact: true }).getByRole("button", { name: "返回", exact: true }).click();
  await guest.getByRole("button", { name: "按标签筛选", exact: true }).click();
  await guest.getByRole("checkbox", { name: "手机", exact: true }).check();
  await guest.keyboard.press("Escape");
  await guest.getByRole("button", { name: /^打开内容：共享笔记/ }).click();
  await guest.locator(".wiki-text-document").getByRole("button", { name: "复制文字", exact: true }).waitFor();
  await openDetailMenu(guest);
  for (const label of ["编辑", "移入回收站", "添加关联"]) assert.equal(await guest.getByRole("button", { name: label, exact: true }).count(), 1);
  assert.equal(await guest.getByRole("link", { name: "下载文字" }).count(), 0);
  await guest.locator(".wiki-text-document").getByRole("button", { name: "复制文字", exact: true }).click();
  assert.equal(await guest.evaluate(() => window.copiedText), "共享笔记\n保留\n  空格");
  await guest.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = guest.getByRole("dialog", { name: "编辑内容", exact: true });
  await editor.getByLabel("文字", { exact: true }).fill("手机编辑后的共享笔记");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await guest.locator(".wiki-text-document pre").filter({ hasText: "手机编辑后的共享笔记" }).waitFor();
  assert.equal((await (await request("/api/elements?q=手机编辑后的共享笔记")).json()).elements.length, 1);
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await guest.screenshot({ path: "data/wiki-text-copy-mobile.png", fullPage: true });
  await dialog.getByRole("switch").click();
  await dialog.getByText("共享已关闭", { exact: true }).waitFor();
  await assert.rejects(fetch(`${lan}/api/elements`));
  assert.deepEqual(errors, []);
});
