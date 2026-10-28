import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createServer } from "../../src/server/server.js";
import { migrateWiki } from "../../src/server/data/wikiMigrations.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createElementService } from "../../src/server/application/elementService.js";

test("unaliasing over the tag limit still permits body edits and retaining or reducing historical tags", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON"); migrateWiki(db);
  try {
    const wiki = createElementService(createElementRepository(db));
    const item = wiki.create({ body: "原文", tags: ["A", "B"] });
    const alias = wiki.setAlias({ kind: "tag", alias: { name: "A" }, canonical: { name: "B" } });
    wiki.update(item.id, { tags: ["B", ...Array.from({ length: 29 }, (_,i) => `T${i}`)] });
    wiki.removeAlias("tag", alias.id);
    const historical = wiki.get(item.id).tags;
    assert.equal(historical.length, 31);
    assert.equal(wiki.update(item.id, { body: "只改正文" }).body, "只改正文");
    assert.deepEqual(wiki.update(item.id, { body: "编辑器同时提交旧标签", tags: historical }).tags, historical);
    assert.throws(() => wiki.create({ body: "不能新建超限内容", tags: historical }), /30/);
    assert.throws(() => wiki.update(item.id, { tags: [...historical, "新增"] }), /30/);
    assert.throws(() => wiki.update(item.id, { tags: [...historical.slice(1), "新增"] }), /30/);
    assert.deepEqual(wiki.get(item.id).tags, historical);
    assert.equal(wiki.update(item.id, { tags: historical.slice(0, 30) }).tags.length, 30);
    assert.equal(wiki.update(item.id, { tags: [...historical.slice(0, 29), "新增"] }).tags.length, 30);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("trash thumbnails are local-only, preserve original read restrictions and expire on restore or purge", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wiki-content-regression-"));
  const app = await createServer({ port: 0, dataDir });
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("wiki-content-regression-"));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });
  const request = (route, method = "GET", body) => fetch(new URL(route, app.url), {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bytes = await sharp({ create: { width: 32, height: 20, channels: 3, background: "red" } }).png().toBuffer();
  const image = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": "same.png" }, body: bytes })).json();
  const route = `api/elements/${image.id}`;
  assert.equal((await request(`${route}/thumbnail?scope=trash`)).status, 404);
  await request(route, "DELETE");
  const local = (await (await request("api/elements?scope=trash")).json()).elements[0];
  assert.equal(local.image.originalName, "same.png");
  assert.ok(local.deletedAt);
  const preview = await request(`${local.image.thumbnailUrl}&width=400`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/webp");
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).format, "webp");
  assert.equal((await request(`${local.image.thumbnailUrl}&width=999`)).status, 400);
  for (const suffix of ["", "/image", "/download", "/thumbnail", "/image?scope=trash", "/download?scope=trash"]) {
    assert.equal((await request(`${route}${suffix}`)).status, 404, suffix);
  }
  const blocker = createHttpServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  await new Promise((resolve) => blocker.close(resolve));
  assert.equal((await request("api/lan-sharing", "PUT", { autoStart: false, port })).status, 200);
  const lanToken = (await (await request("api/lan-sharing")).json()).token;
  const lanFetch = (target, options = {}) => fetch(target, { ...options, headers: { "x-self-wiki-lan-token": lanToken, ...options.headers } });
  assert.equal((await request("api/lan-sharing", "POST", { enabled: true })).status, 200);
  const lan = `http://127.0.0.1:${port}/`;
  const remote = (await (await lanFetch(new URL("api/elements?scope=trash", lan))).json()).elements[0];
  assert.equal(remote.image.thumbnailUrl, undefined);
  for (const suffix of ["", "/image", "/download", "/thumbnail", "/thumbnail?scope=trash", "/thumbnail?scope=trash&width=400"]) {
    assert.equal((await lanFetch(new URL(`${route}${suffix}`, lan))).status, 404, suffix);
  }
  assert.equal((await request(`${route}/restore`, "POST", {})).status, 200);
  assert.equal((await request(local.image.thumbnailUrl)).status, 404);
  assert.equal((await request(`${route}/image`)).status, 200);
  await request(route, "DELETE");
  assert.deepEqual((await (await request("api/trash/purge", "POST", { ids: [image.id] })).json()).failed, []);
  assert.equal((await request(local.image.thumbnailUrl)).status, 404);
});
