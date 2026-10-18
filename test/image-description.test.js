import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { initDb } from "../src/server/data/sqlite.js";
import { createElementRepository } from "../src/server/data/elementRepository.js";
import { createSemanticRepository } from "../src/server/data/semanticRepository.js";
import { createOrganizationRepository } from "../src/server/data/organizationRepository.js";
import { defaultEmbeddingConfig } from "../src/shared/domain/embedding.js";
import { defaultOrganizationConfig } from "../src/shared/domain/organization.js";
import { createServer } from "../src/server/server.js";

async function until(read) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 40)); }
  assert.fail("Description operation did not settle");
}

test("editing image descriptions invalidates stale vectors, model writes and organization evidence", (t) => {
  const db = initDb(":memory:"); t.after(() => db.close());
  const wiki = createElementRepository(db), repo = createSemanticRepository(db), org = createOrganizationRepository(db);
  const { element } = wiki.importImage({ tags: [] }, { storageKey: "sample.png", contentHash: "hash", mimeType: "image/png", byteSize: 10, originalName: "sample.png" });
  const key = repo.configure({ ...defaultEmbeddingConfig(), dimensions: 3 });
  const job = repo.claim(key);
  assert.equal(repo.saveDescription(job, "旧说明：红色雨伞", { model: "old" }), true);
  assert.equal(repo.complete(job, ["旧说明：红色雨伞"], [[1, 0, 0]], 3), true);
  org.enqueue(element.id); const organization = org.claim(); org.context(organization.id, organization.leaseToken);
  const old = repo.document(element.id);
  repo.replaceDescription(element.id, old.revision, "修改后的蓝色雨伞", { source: "manual" });
  assert.deepEqual(repo.vectors(element.id, key), []);
  assert.equal(repo.saveDescription(job, "迟到的旧识别", {}), false);
  assert.equal(repo.complete(job, ["旧识别"], [[1, 0, 0]], 3), false);
  assert.throws(() => repo.replaceDescription(element.id, old.revision, "另一页面的旧修改", {}), /已更新/);
  assert.throws(() => org.context(organization.id, organization.leaseToken), /已变化/);
  const next = repo.claim(key);
  assert.equal(next.description, "修改后的蓝色雨伞");
  assert.equal(repo.complete(next, [next.description], [[0, 1, 0]], 3), true);
  assert.equal(repo.vectors(element.id, key).length, 1);
  wiki.trash(element.id);
  assert.throws(() => repo.replaceDescription(element.id, repo.document(element.id)?.revision, "不可覆盖", {}), /不存在/);
});

test("description APIs preserve edits, deduplicate recognition, keep old text on failure and cancel stale generation", { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-description-"));
  let app;
  t.after(async () => {
    await app?.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("wiki-description-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const executable = path.join(dir, "codex.mjs"), mode = path.join(dir, "mode.txt"), calls = path.join(dir, "calls.txt");
  await writeFile(executable, await readFile(new URL("./fixtures/description-cli.txt", import.meta.url), "utf8"));
  await writeFile(mode, "slow"); await writeFile(calls, "");
  const config = defaultOrganizationConfig(); config.executor.codexCli = { ...config.executor.codexCli, executable, model: "gpt-5.6-terra", codexHome: path.join(dir, "isolated-test-auth") };
  await writeFile(path.join(dir, "organization.json"), JSON.stringify(config));
  app = await createServer({ port: 0, dataDir: dir });
  async function api(route, method = "GET", body, expected = 200) {
    const response = await fetch(new URL(`api/${route}`, app.url), { method, headers: { "content-type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } }).png().toBuffer();
  const image = await (await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-file-name": "blue.png" }, body: png })).json();
  const route = `elements/${image.id}/description`;
  let current = await api(route);
  assert.equal(current.description, "");
  await api(route, "PATCH", { revision: current.revision, description: " " }, 400);
  current = await api(route, "PATCH", { revision: current.revision, description: "手动说明：一把雨伞。" });
  assert.equal(current.manual, true);
  assert.equal((await api(`elements?semantic=1&q=${encodeURIComponent("一把雨伞")}`)).elements[0].id, image.id);
  await api(route, "PATCH", { revision: current.revision - 1, description: "旧页面的修改" }, 409);
  const started = await api(`${route}/regenerate`, "POST", { revision: current.revision }, 202);
  assert.equal(started.generating, true); assert.equal(started.description, current.description);
  assert.equal((await api(`${route}/regenerate`, "POST", { revision: current.revision }, 202)).generating, true);
  current = await until(async () => { const value = await api(route); return !value.generating && value; });
  assert.match(current.description, /重新识别：蓝色雨伞/); assert.equal(current.model, "gpt-5.6-terra"); assert.equal(current.manual, false);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  await writeFile(mode, "fail");
  await api(`${route}/regenerate`, "POST", { revision: current.revision }, 202);
  const failed = await until(async () => { const value = await api(route); return !value.generating && value.error && value; });
  assert.equal(failed.description, current.description); assert.equal(failed.revision, current.revision);
  await writeFile(mode, "hang");
  await api(`${route}/regenerate`, "POST", { revision: current.revision }, 202);
  await until(async () => (await readFile(calls, "utf8")).trim().split("\n").length === 3);
  current = await api(route, "PATCH", { revision: current.revision, description: "人工最终说明，禁止迟到结果覆盖。" });
  assert.equal(current.generating, false);
  await until(async () => (await api("token-usage?days=0")).recent.some((row) => row.purpose === "image-description" && row.state === "interrupted"));
  assert.equal((await api(route)).description, current.description);
  await app.close(); app = await createServer({ port: 0, dataDir: dir });
  assert.equal((await api(route)).description, current.description); assert.equal((await api(route)).manual, true);
  await api(`${route}/regenerate`, "POST", { revision: current.revision }, 202);
  await until(async () => (await readFile(calls, "utf8")).trim().split("\n").length === 4);
  await app.close(); app = await createServer({ port: 0, dataDir: dir });
  assert.equal((await api(route)).description, current.description); assert.equal((await api(route)).generating, false);
  const note = await api("elements", "POST", { body: "文字不是图片" }, 201);
  await api(`elements/${note.id}/description`, "GET", undefined, 404);
  await api(`elements/${note.id}/description/regenerate`, "POST", { revision: 1 }, 404);
  await api(`elements/${image.id}`, "DELETE"); await api(route, "GET", undefined, 404);
});
