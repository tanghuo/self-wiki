import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createServer, fetch } from "../helpers/authenticatedServer.js";
import { initDb } from "../../src/server/data/sqlite.js";
import { migrateWiki } from "../../src/server/data/wikiMigrations.js";
import { createElementRepository } from "../../src/server/data/elementRepository.js";
import { createElementService } from "../../src/server/application/elementService.js";
import { createImageStore } from "../../src/server/assets/imageStore.js";
import { inspectWikiAssets } from "../../tools/wiki-assets.mjs";

async function temp(t, beforeCleanup = async () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-test-"));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-test-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

async function appFor(t) {
  let app;
  const dir = await temp(t, () => app?.close());
  app = await createServer({ port: 0, dataDir: dir });
  const request = (route, method = "GET", body, headers = {}) => fetch(new URL(route, app.url), {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const create = async (body) => (await request("api/elements", "POST", { body })).json();
  const upload = (bytes, name = "原图.png", tags = []) => fetch(new URL("api/images", app.url), {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name), "x-image-tags": Buffer.from(JSON.stringify(tags)).toString("base64") }, body: bytes,
  });
  return { dir, app, request, create, upload };
}

function sample(format = "png") {
  return sharp({ create: { width: 4, height: 6, channels: 3, background: "#408d81" } }).toFormat(format).toBuffer();
}

test("multiple tag filters union, normalize, and paginate together", async (t) => {
  const { request } = await appFor(t);
  for (const tags of [["Alpha", "雨夜"], ["Alpha"], ["雨夜"], ["Alpha", "雨夜"]]) {
    await request("api/elements", "POST", { body: "组合筛选", tags });
  }
  const result = await (await request("api/elements?tag=ALPHA&tag=雨夜&tag=alpha&pageSize=1&page=2&q=组合")).json();
  assert.equal(result.pagination.total, 4);
  assert.equal(result.pagination.pageCount, 4);
  assert.equal(result.elements.length, 1);
  assert.ok(result.elements[0].tags.some((tag) => ["Alpha", "雨夜"].includes(tag)));
  assert.equal((await (await request("api/elements?tag=Alpha&tag=不存在")).json()).pagination.total, 3);
  assert.equal((await (await request("api/elements?tag=Alpha")).json()).pagination.total, 3);
  assert.equal((await (await request("api/elements?tag=")).json()).pagination.total, 4);
  await request("api/elements", "POST", { body: "其他正文", tags: ["Alpha"] });
  await request("api/elements", "POST", { body: "组合筛选", tags: ["其他标签"] });
  assert.equal((await (await request("api/elements?tag=Alpha&tag=雨夜&q=组合")).json()).pagination.total, 4);
  assert.equal((await (await request("api/elements?tag=不存在&tag=其他不存在")).json()).pagination.total, 0);
  const all = await (await request("api/elements?tag=ALPHA&tag=雨夜&tag=alpha&tagMatch=all&q=组合&pageSize=1&page=2")).json();
  assert.equal(all.pagination.total, 2);
  assert.equal(all.pagination.pageCount, 2);
  assert.deepEqual(all.elements[0].tags, ["Alpha", "雨夜"]);
  assert.equal((await (await request("api/elements?tag=Alpha&tag=雨夜&tagMatch=any&q=组合")).json()).pagination.total, 4);
  assert.equal((await (await request("api/elements?tag=Alpha&tag=不存在&tagMatch=all")).json()).pagination.total, 0);
  assert.equal((await (await request("api/elements?tagMatch=all")).json()).pagination.total, 6);
  assert.equal((await request("api/elements?tagMatch=invalid")).status, 400);
});

test("custom relation names persist, deduplicate per name and appear on both sides and canvas", async (t) => {
  const { request, create } = await appFor(t);
  const a = await create("内容 A"), b = await create("内容 B");
  const connect = async (name, sourceId = a.id, targetId = b.id) => request("api/relations", "POST", { sourceId, targetId, name });
  const first = await (await connect("  参考来源  ")).json();
  assert.equal(first.name, "参考来源");
  assert.equal((await (await connect("参考来源", b.id, a.id)).json()).id, first.id);
  const second = await (await connect("作者")).json();
  assert.notEqual(second.id, first.id);
  const plain = await (await connect("")).json();
  assert.notEqual(plain.id, first.id);
  for (const id of [a.id, b.id]) {
    const result = await (await request(`api/elements/${id}/relations`)).json();
    assert.deepEqual(result.relations.map((r) => r.name).sort(), ["", "作者", "参考来源"]);
  }
  const canvas = await (await request(`api/canvas?ids=${a.id},${b.id}&limit=0`)).json();
  assert.deepEqual(canvas.relations.map((r) => r.name).sort(), ["", "作者", "参考来源"]);
  for (const invalid of [null, 42, "x".repeat(61), "a\nb"]) assert.equal((await connect(invalid)).status, 400);
  assert.equal((await connect("自身", a.id, a.id)).status, 400);
  assert.equal((await request(`api/relations/${first.id}`, "DELETE")).status, 200);
  assert.equal((await (await request(`api/elements/${a.id}/relations`)).json()).relations.length, 2);
});

test("renaming relations preserves identities and direction, validates names and rejects duplicates without data loss", async (t) => {
  const { request, create } = await appFor(t);
  const a = await create("内容 A"), b = await create("内容 B");
  const connect = async (type, name = "") => (await request("api/relations", "POST", { sourceId: b.id, targetId: a.id, type, name })).json();
  const related = async (id) => (await (await request(`api/elements/${id}/relations`)).json()).relations;
  for (const type of ["related", "title"]) {
    const edge = await connect(type);
    const existing = await connect(type, "已用名称");
    const route = `api/relations/${edge.id}`;
    const before = (await related(a.id)).find((r) => r.id === edge.id);
    for (const payload of [null, [], {}, { name: null }, { name: 42 }, { name: "x".repeat(61) }, { name: "a\nb" }, { name: "新名", sourceId: a.id }]) {
      assert.equal((await request(route, "PATCH", payload)).status, 400);
    }
    assert.equal((await request(route, "PATCH", { name: " 已用名称 " })).status, 409);
    assert.deepEqual((await related(a.id)).find((r) => r.id === edge.id), before);
    for (let retry = 0; retry < 2; retry++) assert.equal((await request(route, "PATCH", { name: "  新的关联名称  " })).status, 200);
    assert.deepEqual((await related(a.id)).find((r) => r.id === edge.id), { ...before, name: "新的关联名称" });
    assert.equal((await related(b.id)).find((r) => r.id === edge.id).name, "新的关联名称");
    const canvas = await (await request(`api/canvas?ids=${a.id},${b.id}&limit=0`)).json();
    assert.equal(canvas.relations.find((r) => r.id === edge.id).name, "新的关联名称");
    assert.equal((await related(a.id)).find((r) => r.id === existing.id).name, "已用名称");
    assert.equal((await request(route, "PATCH", { name: "   " })).status, 200);
    assert.deepEqual((await related(a.id)).find((r) => r.id === edge.id), before);
    await request(`api/elements/${a.id}`, "DELETE");
    assert.equal((await request(route, "PATCH", { name: "不可修改" })).status, 404);
    await request(`api/elements/${a.id}/restore`, "POST");
    await request(`api/elements/${b.id}`, "DELETE");
    assert.equal((await request(route, "PATCH", { name: "不可修改" })).status, 404);
    await request(`api/elements/${b.id}/restore`, "POST");
    assert.equal((await related(a.id)).find((r) => r.id === edge.id).name, "");
  }
  assert.equal((await related(a.id)).length, 4);
  assert.equal((await request("api/relations/99999", "PATCH", { name: "不存在" })).status, 404);
  assert.equal((await request("api/relations/tag:1:2", "PATCH", { name: "自动关系" })).status, 400);
});

test("tag relation renaming updates all members through the API and preserves conflicting rules", async (t) => {
  const { request, create } = await appFor(t);
  const source = await create("来源"), a = await create("成员甲"), b = await create("成员乙");
  for (const member of [a, b]) await request(`api/elements/${member.id}`, "PATCH", { tags: ["合集"] });
  for (const name of ["", "已用名称"]) await request("api/relations/batch", "POST", { sourceId: source.id, targetTags: ["合集"], name });
  const rules = async () => (await (await request(`api/elements/${source.id}/relations`)).json()).tagRelations;
  const rule = (await rules()).find((r) => r.name === "");
  const route = `api/tag-relations/${rule.id}`;
  for (const payload of [{}, { name: null }, { name: "a\nb" }, { name: "x".repeat(61) }, { name: "新名", targetTag: "其他" }]) {
    assert.equal((await request(route, "PATCH", payload)).status, 400);
  }
  assert.equal((await request(route, "PATCH", { name: "已用名称" })).status, 409);
  assert.deepEqual((await rules()).find((r) => r.id === rule.id), rule);
  for (let retry = 0; retry < 2; retry++) assert.equal((await request(route, "PATCH", { name: "  参考图  " })).status, 200);
  assert.deepEqual((await rules()).find((r) => r.id === rule.id), { ...rule, name: "参考图" });
  for (const member of [a, b]) {
    const result = await (await request(`api/elements/${member.id}/relations`)).json();
    assert.equal(result.relations.find((r) => r.tagRelationId === rule.id).name, "参考图");
  }
  const canvas = await (await request(`api/canvas?ids=${source.id},${a.id},${b.id}&limit=0`)).json();
  assert.deepEqual(canvas.relations.filter((r) => r.tagRelationId === rule.id).map((r) => r.name), ["参考图", "参考图"]);
  assert.equal((await rules()).length, 2);
  for (const member of [a, b]) await request(`api/elements/${member.id}`, "PATCH", { tags: [] });
  assert.equal((await request(route, "PATCH", { name: " " })).status, 200);
  assert.equal((await rules()).find((r) => r.id === rule.id).name, "");
  await request(`api/elements/${source.id}`, "DELETE");
  assert.equal((await request(route, "PATCH", { name: "不可修改" })).status, 404);
  await request(`api/elements/${source.id}/restore`, "POST");
  assert.equal((await rules()).find((r) => r.id === rule.id).name, "");
  await request(route, "DELETE");
  assert.equal((await request(route, "PATCH", { name: "不存在" })).status, 404);
});

test("batch relation rename is atomic across direct and tag relations, including missing and conflicting records", async (t) => {
  const { request, create } = await appFor(t);
  const source = await create("来源"), a = await create("成员甲"), b = await create("成员乙");
  await request(`api/elements/${a.id}`, "PATCH", { tags: ["合集"] });
  await request(`api/elements/${b.id}`, "PATCH", { tags: ["合集"] });
  const direct = await (await request("api/relations", "POST", { sourceId: source.id, targetId: a.id, name: "原名", type: "title" })).json();
  for (const name of ["原名", "已用名称"]) await request("api/relations/batch", "POST", { sourceId: source.id, targetTags: ["合集"], name });
  const rules = (await (await request(`api/elements/${source.id}/tag-relations`)).json()).tagRelations;
  const tag = rules.find((entry) => entry.name === "原名");
  const rename = (name, ids = [direct.id], tagRelationIds = [tag.id]) => request("api/relations/batch", "PATCH", { name, ids, tagRelationIds });
  const state = async () => (await (await request(`api/canvas?ids=${source.id},${a.id},${b.id}&limit=0`)).json()).relations;
  const before = await state();
  assert.equal((await rename("已用名称")).status, 409, "A tag conflict must roll back the preceding direct update");
  assert.deepEqual(await state(), before);
  assert.equal((await rename("新名", [direct.id], [999999])).status, 404);
  assert.deepEqual(await state(), before);
  assert.equal((await rename("新名", [direct.id, 999999])).status, 404);
  assert.deepEqual(await state(), before);
  for (let retry = 0; retry < 2; retry++) assert.equal((await rename("  新名  ", [direct.id, direct.id], [tag.id, tag.id])).status, 200);
  const renamed = await state();
  assert.deepEqual(renamed, before.map((entry) => entry.id === direct.id || entry.tagRelationId === tag.id ? { ...entry, name: "新名" } : entry));
  assert.equal((await rename(" ")).status, 200);
  assert.ok((await state()).filter((entry) => entry.id === direct.id || entry.tagRelationId === tag.id).every((entry) => entry.name === ""));
  await request(`api/elements/${a.id}`, "DELETE");
  assert.equal((await rename("不可修改")).status, 404);
  await request(`api/elements/${a.id}/restore`, "POST");
  assert.equal((await state()).find((entry) => entry.id === direct.id).name, "");
  await request(`api/elements/${source.id}`, "DELETE");
  assert.equal((await rename("不可修改", [])).status, 404);
});

test("batch relation rename validates its bounded selection and rolls back direct name collisions", async (t) => {
  const { request, create } = await appFor(t);
  const source = await create("来源"), a = await create("甲"), b = await create("乙");
  const connect = async (targetId, name) => (await request("api/relations", "POST", { sourceId: source.id, targetId, name })).json();
  const first = await connect(a.id, "原名"), second = await connect(b.id, "原名");
  const existing = await connect(b.id, "重复名");
  const before = (await (await request(`api/elements/${source.id}/relations`)).json()).relations;
  const rename = (payload) => request("api/relations/batch", "PATCH", payload);
  for (const payload of [null, [], {}, { name: "新名" }, { ids: [first.id] }, { ids: null, tagRelationIds: [1], name: "新名" },
    { ids: "1", name: "新名" }, { ids: [0], name: "新名" }, { ids: ["tag:1:2"], name: "新名" },
    { ids: [first.id], tagRelationIds: {}, name: "新名" }, { ids: [first.id], name: "a\nb" }, { ids: [first.id], name: "x".repeat(61) },
    { ids: Array(1201).fill(first.id), name: "新名" }, { ids: [first.id], name: "新名", sourceId: source.id }]) {
    assert.equal((await rename(payload)).status, 400, JSON.stringify(payload));
  }
  assert.equal((await rename({ ids: [first.id, second.id], name: "重复名" })).status, 409);
  assert.deepEqual((await (await request(`api/elements/${source.id}/relations`)).json()).relations, before);
  assert.equal((await rename({ ids: [second.id, existing.id], name: "合并名" })).status, 409);
  assert.deepEqual((await (await request(`api/elements/${source.id}/relations`)).json()).relations, before);
  assert.equal((await rename({ ids: [first.id, second.id], name: "生成结果" })).status, 200);
});

test("Trash purge validates requests, protects active content and clears every page", async (t) => {
  const { create, request, upload, dir } = await appFor(t);
  const active = await create("keep"), removed = await create("remove");
  const image = await (await upload(await sample())).json();
  await request("api/relations", "POST", { sourceId: removed.id, targetId: active.id });
  await request(`api/elements/${removed.id}`, "DELETE");
  await request(`api/elements/${image.id}`, "DELETE");
  for (const payload of [{}, { all: false }, { all: true, ids: [] }, { ids: [removed.id, "bad"] }, { ids: [] }]) {
    assert.equal((await request("api/trash/purge", "POST", payload)).status, 400);
  }
  const result = await (await request("api/trash/purge", "POST", { ids: [removed.id, active.id, removed.id] })).json();
  assert.deepEqual(result.deleted, [removed.id]);
  assert.equal(result.failed[0].id, active.id);
  assert.equal((await request(`api/elements/${removed.id}/restore`, "POST")).status, 404);
  assert.equal((await (await request(`api/elements/${active.id}/relations`)).json()).pagination.total, 0);
  assert.deepEqual((await (await request("api/trash/purge", "POST", { ids: [removed.id] })).json()).failed, []);
  for (let i = 0; i < 38; i++) {
    const item = await create(`trash ${i}`);
    await request(`api/elements/${item.id}`, "DELETE");
  }
  const cleared = await (await request("api/trash/purge", "POST", { all: true })).json();
  assert.equal(cleared.deleted.length, 39);
  assert.deepEqual(cleared.failed, []);
  assert.deepEqual(cleared.cleanupFailed, []);
  assert.equal((await (await request("api/elements?scope=trash")).json()).pagination.total, 0);
  assert.equal((await request(`api/elements/${active.id}`)).status, 200);
  const audit = await inspectWikiAssets(dir);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.unused, []);
  const reimported = await (await upload(await sample())).json();
  assert.notEqual(reimported.id, image.id);
});

test("Permanent deletion removes dependent rows atomically and reports file cleanup failure", async (t) => {
  const dir = await temp(t);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  migrateWiki(db);
  const repo = createElementRepository(db);
  const store = createImageStore(dir);
  const service = createElementService(repo, store);
  const image = await service.importImage(await sample(), "test.png", ["tag"]);
  const key = repo.image(image.id).storageKey;
  repo.canvas.save([{ id: image.id, x: 1, y: 2 }]);
  service.trash(image.id);
  db.exec("CREATE TRIGGER reject_purge BEFORE DELETE ON elements BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  assert.equal((await service.purgeTrash({ ids: [image.id] })).failed.length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM element_images").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM element_tags").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM canvas_positions").get().n, 1);
  assert.equal(await store.exists(key), true);
  db.exec("DROP TRIGGER reject_purge");
  const failing = createElementService(repo, { ...store, remove: async () => { throw new Error("locked"); } });
  const result = await failing.purgeTrash({ all: true });
  assert.deepEqual(result.deleted, [image.id]);
  assert.deepEqual(result.cleanupFailed, [image.id]);
  for (const table of ["elements", "element_images", "element_tags", "canvas_positions"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Preview variants rotate images, avoid enlarging small originals, bound tall images and clear on removal", async (t) => {
  const store = createImageStore(await temp(t));
  for (const [width, height, orientation, expected] of [[1800, 1200, 6, [800, 1200]], [160, 240, 1, [160, 240]], [400, 6000, 1, [213, 3200]]]) {
    const bytes = await sharp({ create: { width, height, channels: 3, background: "#568861" } }).jpeg().withMetadata({ orientation }).toBuffer();
    const { storageKey } = await store.save(bytes, "preview.jpg");
    const previews = await Promise.all([undefined, 400, 800, 1600].map((size) => store.thumbnail(storageKey, size)));
    const metadata = await sharp(previews[2]).metadata();
    assert.deepEqual([metadata.width, metadata.height], expected);
    assert.deepEqual(await store.read(storageKey), bytes);
    await store.remove(storageKey);
    for (const size of [undefined, 400, 800, 1600]) await assert.rejects(store.thumbnail(storageKey, size), { statusCode: 404 });
  }
});

test("Wiki text remains independent, preserves whitespace, searches literally and validates fields", async (t) => {
  const { create, request } = await appFor(t);
  const content = "  portrait\n\n  light: 50%_soft\\\n";
  const a = await create(content);
  assert.equal(a.body, content);
  assert.equal(a.kind, "text");
  assert.equal(a.image, undefined);
  const b = await create(content);
  assert.notEqual(a.id, b.id);
  const results = await (await request(`api/elements?q=${encodeURIComponent("%_soft\\")}&pageSize=1`)).json();
  assert.equal(results.pagination.total, 2);
  assert.equal(results.elements.length, 1);
  assert.equal((await (await request("api/elements?q=unmatched")).json()).pagination.total, 0);
  assert.equal((await request("api/elements", "POST", { body: "\n  " })).status, 400);
  assert.equal((await request(`api/elements/${a.id}`, "PATCH", { kind: "image" })).status, 400);
  assert.equal((await request(`api/elements/${a.id}`, "PATCH", { body: null })).status, 400);
  assert.equal((await request("api/elements/abc12")).status, 400);
  assert.equal((await request("api/elements?pageSize=1000")).status, 400);
  assert.equal(Object.hasOwn(a, "title"), false);
  assert.equal((await request(`api/elements/${a.id}`, "PATCH", { title: "新标题" })).status, 400);
  const updated = await (await request(`api/elements/${a.id}`, "PATCH", { tags: ["人物 A"] })).json();
  assert.equal(updated.body, content);
  assert.equal((await request("api/elements", "POST", { body: "x".repeat(70000) })).status, 413);
});

test("Relations are undirected, unique, direct only, detachable and retained through trash", async (t) => {
  const { create, request } = await appFor(t);
  const a = await create("A"), b = await create("B"), c = await create("C");
  const relate = async (leftId, rightId) => (await request("api/relations", "POST", { leftId, rightId })).json();
  const edge = await relate(a.id, b.id);
  assert.equal((await relate(b.id, a.id)).id, edge.id);
  await relate(b.id, c.id);
  const related = async (id) => (await request(`api/elements/${id}/relations`)).json();
  assert.deepEqual((await related(a.id)).relations.map((r) => r.element.id), [b.id]);
  assert.equal((await related(b.id)).relations.length, 2);
  assert.equal((await request("api/relations", "POST", { leftId: a.id, rightId: a.id })).status, 400);
  assert.equal((await request(`api/elements/${b.id}`, "DELETE")).status, 200);
  assert.equal((await related(a.id)).relations.length, 0);
  assert.equal((await request(`api/elements/${b.id}/relations`)).status, 404);
  assert.equal((await request("api/relations", "POST", { leftId: a.id, rightId: b.id })).status, 404);
  const trash = await (await request("api/elements?scope=trash")).json();
  assert.equal(trash.elements[0].id, b.id);
  await request(`api/elements/${b.id}/restore`, "POST");
  assert.equal((await related(a.id)).relations[0].id, edge.id);
  await request(`api/relations/${edge.id}`, "DELETE");
  assert.equal((await related(a.id)).relations.length, 0);
  assert.equal((await request(`api/elements/${b.id}`)).status, 200);
});

test("Titles are independent text with reusable directed relations; edits and deletion never cascade to content", async (t) => {
  const { create, request, upload } = await appFor(t);
  const target = await create("  一段文字\n  保留空格");
  const title = await create("海边的人物");
  const image = await (await upload(await sample(), "example.png")).json();
  const connect = async (sourceId, targetId, type = "title") => request("api/relations", "POST", { sourceId, targetId, type });
  const edge = await (await connect(title.id, target.id)).json();
  assert.equal(edge.type, "title");
  assert.equal(edge.sourceId, title.id);
  assert.equal(edge.targetId, target.id);
  assert.equal((await (await connect(title.id, target.id)).json()).id, edge.id);
  const reverse = await (await connect(target.id, title.id)).json();
  assert.notEqual(reverse.id, edge.id);
  const ordinary = await (await connect(title.id, target.id, "related")).json();
  assert.notEqual(ordinary.id, edge.id);
  await connect(title.id, image.id);
  assert.equal((await connect(image.id, target.id)).status, 400);
  assert.equal((await connect(title.id, title.id)).status, 400);
  assert.equal((await connect(title.id, target.id, "unknown")).status, 400);
  const getRelations = async (id) => (await (await request(`api/elements/${id}/relations`)).json()).relations;
  const incoming = (await getRelations(target.id)).find((relation) => relation.id === edge.id);
  assert.equal(incoming.element.id, title.id);
  assert.equal(incoming.sourceId, title.id);
  await request(`api/elements/${title.id}`, "PATCH", { body: "新的标题文字", tags: ["独立标签"] });
  assert.deepEqual(await (await request(`api/elements/${target.id}`)).json(), target);
  assert.equal((await getRelations(image.id))[0].element.body, "新的标题文字");
  const graph = await (await request("api/canvas")).json();
  assert.equal(graph.relations.find((relation) => relation.id === edge.id).sourceId, title.id);
  assert.equal(graph.relations.find((relation) => relation.id === edge.id).type, "title");
  await request(`api/elements/${title.id}`, "DELETE");
  assert.deepEqual(await (await request(`api/elements/${target.id}`)).json(), target);
  assert.equal((await getRelations(target.id)).length, 0);
  await request(`api/elements/${title.id}/restore`, "POST");
  assert.equal((await getRelations(target.id)).length, 3);
  await request(`api/relations/${edge.id}`, "DELETE");
  assert.equal((await getRelations(target.id)).length, 2);
  assert.equal((await request(`api/elements/${title.id}`)).status, 200);
  assert.equal((await request(`api/elements/${target.id}`)).status, 200);
});

test("Imported originals retain bytes, MIME is decoded, all four formats survive restart and trash", async (t) => {
  const { app, dir, upload, create, request } = await appFor(t);
  const person = await create("人物");
  const saved = [];
  for (const format of ["png", "jpeg", "webp", "gif"]) {
    const bytes = await sample(format);
    const response = await upload(bytes, "../sample.wrong-extension");
    assert.equal(response.status, 201, await response.clone().text());
    const element = await response.json();
    assert.equal(element.image.mimeType, `image/${format}`);
    assert.equal(element.image.originalName, "sample.wrong-extension");
    assert.deepEqual(Buffer.from(await (await request(element.image.url)).arrayBuffer()), bytes);
    await request("api/relations", "POST", { leftId: person.id, rightId: element.id });
    saved.push({ element, bytes });
  }
  assert.equal((await (await request(`api/elements/${person.id}/relations`)).json()).pagination.total, 4);
  const first = saved[0];
  await request(`api/elements/${first.element.id}`, "DELETE");
  assert.equal((await request(first.element.image.url)).status, 404);
  assert.equal((await readdir(path.join(dir, "assets"))).filter((name) => name !== "previews-v1").length, 4);
  await app.close();
  const reopened = await createServer({ port: 0, dataDir: dir });
  try {
    const restored = await fetch(new URL(`api/elements/${first.element.id}/restore`, reopened.url), { method: "POST" });
    assert.equal(restored.status, 200);
    for (const { element, bytes } of saved) {
      assert.deepEqual(Buffer.from(await (await fetch(new URL(element.image.url, reopened.url))).arrayBuffer()), bytes);
    }
  } finally { await reopened.close(); }
});

test("Bad and oversized uploads leave neither elements nor files; same-origin checks cover uploads", async (t) => {
  const { upload, request, dir, app } = await appFor(t);
  for (const bytes of [Buffer.from("not an image"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), (await sample()).subarray(0, 40)]) {
    assert.equal((await upload(bytes)).status, 415);
  }
  assert.equal((await upload(Buffer.alloc(0))).status, 413);
  assert.equal((await upload(Buffer.alloc(25 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await fetch(new URL("api/images", app.url), { method: "POST", headers: { origin: "https://foreign.test" }, body: await sample() })).status, 403);
  assert.equal((await (await request("api/elements")).json()).pagination.total, 0);
  assert.deepEqual(await readdir(path.join(dir, "assets")).catch((e) => { if (e.code === "ENOENT") return []; throw e; }), []);
});

test("Database write failure removes the imported file and rolls back both image tables", async (t) => {
  const dir = await temp(t);
  const db = initDb(path.join(dir, "library.sqlite3"));
  try {
    const service = createElementService(createElementRepository(db), createImageStore(path.join(dir, "assets")));
    db.exec("CREATE TRIGGER reject_image BEFORE INSERT ON element_images BEGIN SELECT RAISE(ABORT, 'test disk metadata failure'); END");
    await assert.rejects(service.importImage(await sample(), "image.png"), /metadata failure/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM elements").get().n, 0);
    assert.deepEqual(await readdir(path.join(dir, "assets")), []);
  } finally { db.close(); }
});

test("Wiki migration is additive, repeatable, enforces foreign keys and rejects future versions", async (t) => {
  const dir = await temp(t);
  const file = path.join(dir, "library.sqlite3");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("CREATE TABLE existing_records(id INTEGER PRIMARY KEY, note TEXT); INSERT INTO existing_records VALUES(1, 'Existing')");
    const before = db.prepare("SELECT * FROM existing_records").all();
    migrateWiki(db); migrateWiki(db);
    assert.deepEqual(db.prepare("SELECT * FROM existing_records").all(), before);
    assert.throws(() => db.exec("INSERT INTO element_relations (source_id, target_id, kind, created_at) VALUES (1, 2, 1, 'now')"), /FOREIGN KEY/);
    db.exec("INSERT INTO wiki_schema VALUES(99)");
    assert.throws(() => migrateWiki(db), /Unsupported/);
  } finally { db.close(); }
  assert.ok((await readFile(file)).length);
});

test("Image and text tags normalize, filter exactly, edit independently and survive trash", async (t) => {
  const { request, upload } = await appFor(t);
  const text = await (await request("api/elements", "POST", { body: "  prompt\n", tags: [" 人物 A ", "GPT", "gpt", "Cafe\u0301"] })).json();
  assert.deepEqual(text.tags, ["人物 A", "GPT", "Café"]);
  const image = await (await upload(await sample(), "人物.png", ["人物 A", "gpt"])).json();
  assert.deepEqual(image.tags, ["人物 A", "GPT"]);
  const filtered = async (params) => (await (await request(`api/elements?${new URLSearchParams(params)}`)).json());
  assert.equal((await filtered({ tag: "gPt" })).pagination.total, 2);
  assert.equal((await filtered({ tag: "人物" })).pagination.total, 0);
  assert.equal((await filtered({ tag: " 人物 A ", kind: "image" })).elements[0].id, image.id);
  assert.equal((await filtered({ tag: "gpt", q: "prompt" })).elements[0].id, text.id);
  const updated = await (await request(`api/elements/${image.id}`, "PATCH", {})).json();
  assert.deepEqual(updated.tags, image.tags);
  const tagged = await (await request(`api/elements/${text.id}`, "PATCH", { tags: ["新标签"] })).json();
  assert.equal(tagged.body, text.body);
  assert.deepEqual(tagged.tags, ["新标签"]);
  assert.deepEqual((await (await request(`api/elements/${text.id}`, "PATCH", { tags: [] })).json()).tags, []);
  for (const tags of [null, "标签", [""], [123], ["a\nb"], ["a".repeat(61)], Array.from({ length: 31 }, (_, i) => `tag${i}`)]) {
    assert.equal((await request(`api/elements/${image.id}`, "PATCH", { tags })).status, 400);
  }
  await request(`api/elements/${image.id}`, "DELETE");
  assert.equal((await filtered({ tag: "gpt" })).pagination.total, 0);
  assert.deepEqual((await filtered({ tag: "gpt", scope: "trash" })).elements[0].tags, image.tags);
  assert.deepEqual((await (await request(`api/elements/${image.id}/restore`, "POST")).json()).tags, image.tags);
  assert.deepEqual((await (await request("api/tags")).json()).tags, ["GPT", "人物 A"]);
});

test("Repeated content reuses identity, retains relations, merges tags; same names never overwrite", async (t) => {
  const { request, upload, create, dir } = await appFor(t);
  const bytes = await sample();
  const original = await (await upload(bytes, "same.png", ["人物 A"])).json();
  const note = await create("提示词");
  await request("api/relations", "POST", { leftId: original.id, rightId: note.id });
  const response = await upload(bytes, "renamed.png", ["人物 A", "新标签"]);
  assert.equal(response.status, 200);
  const duplicate = await response.json();
  assert.equal(duplicate.importStatus, "reused");
  assert.equal(duplicate.id, original.id);
  assert.equal(Object.hasOwn(duplicate, "title"), false);
  assert.equal(duplicate.image.originalName, "same.png");
  assert.deepEqual(duplicate.tags, ["人物 A", "新标签"]);
  assert.equal((await (await request(`api/elements/${original.id}/relations`)).json()).relations[0].element.id, note.id);
  assert.equal((await readdir(path.join(dir, "assets"))).filter((name) => name !== "previews-v1").length, 1);
  const different = await (await upload(await sample("webp"), "same.png")).json();
  assert.equal(different.importStatus, "same-name");
  assert.notEqual(different.id, original.id);
  assert.deepEqual(Buffer.from(await (await request(original.image.url)).arrayBuffer()), bytes);
  await request(`api/elements/${original.id}`, "DELETE");
  assert.equal((await upload(bytes, "same.png", ["不应添加"])).status, 409);
  const restored = await (await request(`api/elements/${original.id}/restore`, "POST")).json();
  assert.deepEqual(restored.tags, duplicate.tags);
  assert.equal((await readdir(path.join(dir, "assets"))).filter((name) => name !== "previews-v1").length, 2);
});

test("Concurrent duplicate imports create one element and combine tags without leftover files", async (t) => {
  const { upload, request, dir } = await appFor(t);
  const bytes = await sample();
  const responses = await Promise.all([upload(bytes, "a.png", ["A"]), upload(bytes, "b.png", ["B"])]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  const elements = await Promise.all(responses.map((r) => r.json()));
  assert.equal(elements[0].id, elements[1].id);
  const saved = await (await request(`api/elements/${elements[0].id}`)).json();
  assert.deepEqual(saved.tags.sort(), ["A", "B"]);
  assert.equal((await readdir(path.join(dir, "assets"))).filter((name) => name !== "previews-v1").length, 1);
});

test("Tag validation and failed duplicate merges leave no partial updates or orphan files", async (t) => {
  const { upload, request, dir, app } = await appFor(t);
  const bytes = await sample();
  assert.equal((await upload(bytes, "bad.png", ["bad\ntag"])).status, 400);
  assert.equal((await fetch(new URL("api/images", app.url), { method: "POST", headers: { "x-image-tags": "not-json" }, body: bytes })).status, 400);
  assert.equal((await (await request("api/elements")).json()).pagination.total, 0);
  const tags = Array.from({ length: 30 }, (_, i) => `标签${i}`.padEnd(60, "长"));
  const firstResponse = await upload(bytes, "full.png", tags);
  assert.equal(firstResponse.status, 201, await firstResponse.clone().text());
  const original = await firstResponse.json();
  assert.equal((await upload(bytes, "full.png", ["超出上限"])).status, 400);
  assert.deepEqual(await (await request(`api/elements/${original.id}`)).json(), (({ importStatus, ...element }) => element)(original));
  assert.equal((await (await request("api/tags")).json()).tags.length, 30);
  assert.equal((await readdir(path.join(dir, "assets"))).filter((name) => name !== "previews-v1").length, 1);
});

test("Identical reimport repairs a missing stored original while retaining the existing element", async (t) => {
  const { upload, request, dir } = await appFor(t);
  const bytes = await sample();
  const first = await (await upload(bytes)).json();
  const stored = (await readdir(path.join(dir, "assets"))).filter((name) => name !== "previews-v1")[0];
  await rm(path.join(dir, "assets", stored));
  assert.equal((await request(first.image.url)).status, 404);
  const repaired = await (await upload(bytes, "repair.png", ["已修复"])).json();
  assert.equal(repaired.id, first.id);
  assert.equal(repaired.importStatus, "reused");
  assert.deepEqual(Buffer.from(await (await request(first.image.url)).arrayBuffer()), bytes);
  assert.equal((await readdir(path.join(dir, "assets"))).filter((name) => name !== "previews-v1").length, 1);
});

test("v1 upgrade hashes old originals, preserves old duplicates and relations, and is repeatable", async (t) => {
  let app;
  const dir = await temp(t, () => app?.close());
  const db = new DatabaseSync(path.join(dir, "library.sqlite3"));
  const bytes = await sample();
  let before;
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE wiki_schema(version INTEGER PRIMARY KEY); INSERT INTO wiki_schema VALUES(1);
      CREATE TABLE elements(id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER, title TEXT, body TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
      CREATE TABLE element_images(element_id INTEGER PRIMARY KEY REFERENCES elements(id), storage_key TEXT, mime_type TEXT, byte_size INTEGER, original_name TEXT);
      CREATE TABLE element_relations(id INTEGER PRIMARY KEY AUTOINCREMENT, left_id INTEGER REFERENCES elements(id), right_id INTEGER REFERENCES elements(id), created_at TEXT);`);
    const store = createImageStore(path.join(dir, "assets"));
    for (const id of [1, 2]) {
      const file = await store.save(bytes, `old${id}.png`);
      db.prepare("INSERT INTO elements VALUES (?, 2, ?, '', 'old', 'old', NULL)").run(id, `old${id}.png`);
      db.prepare("INSERT INTO element_images VALUES (?, ?, ?, ?, ?)").run(id, file.storageKey, file.mimeType, file.byteSize, file.originalName);
    }
    db.exec("INSERT INTO element_relations (left_id, right_id, created_at) VALUES (1, 2, 'old')");
    before = db.prepare("SELECT id, kind, body, created_at, deleted_at FROM elements ORDER BY id").all();
  } finally { db.close(); }
  app = await createServer({ port: 0, dataDir: dir });
  const api = (route, options) => fetch(new URL(route, app.url), options);
  assert.equal((await (await api("api/elements")).json()).pagination.total, 2);
  const repeated = await (await api("api/images", { method: "POST", body: bytes })).json();
  assert.equal(repeated.id, 1);
  assert.equal(repeated.image.originalName, "old1.png");
  assert.deepEqual(repeated.tags, []);
  assert.equal((await (await api("api/elements/1/relations")).json()).relations[0].element.id, 2);
  await app.close();
  app = await createServer({ port: 0, dataDir: dir });
  const check = new DatabaseSync(path.join(dir, "library.sqlite3"), { readOnly: true });
  try {
    assert.deepEqual(check.prepare("SELECT version FROM wiki_schema ORDER BY version").all().map((r) => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44]);
    const after = check.prepare("SELECT id, kind, body, created_at, deleted_at FROM elements ORDER BY id").all();
    assert.deepEqual(after, before);
    assert.equal(check.prepare("SELECT count(*) AS n FROM element_images WHERE content_hash IS NOT NULL").get().n, 2);
  } finally { check.close(); }
  assert.equal((await readdir(path.join(dir, "assets"))).filter((name) => name !== "previews-v1").length, 2);
});

test("Offline asset audit preserves trash references, reports missing originals and only removes orphans explicitly", async (t) => {
  const dir = await temp(t);
  const db = initDb(path.join(dir, "library.sqlite3"));
  const service = createElementService(createElementRepository(db), createImageStore(path.join(dir, "assets")));
  const element = await service.importImage(await sample(), "kept.png");
  service.trash(element.id);
  const stored = db.prepare("SELECT storage_key FROM element_images").get().storage_key;
  db.close();
  const orphan = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png.tmp";
  await writeFile(path.join(dir, "assets", orphan), "orphan");
  await writeFile(path.join(dir, "assets", "notes.txt"), "keep this");
  const scan = await inspectWikiAssets(dir);
  assert.deepEqual(scan.unused, [orphan]);
  assert.deepEqual(scan.unknown, ["notes.txt"]);
  assert.deepEqual(scan.missing, []);
  await assert.rejects(inspectWikiAssets(dir, { apply: true }), /Close the application/);
  const cleaned = await inspectWikiAssets(dir, { apply: true, offline: true });
  assert.deepEqual(cleaned.removed, [orphan]);
  assert.ok((await readFile(path.join(dir, "assets", stored))).length);
  await rm(path.join(dir, "assets", stored));
  assert.deepEqual((await inspectWikiAssets(dir)).missing, [stored]);
});


test("legacy image dimensions and common disk previews are backfilled without changing original bytes", async (t) => {
  const dir = await temp(t), db = initDb(":memory:");
  t.after(() => db.close());
  const repo = createElementRepository(db), store = createImageStore(path.join(dir, "assets"));
  const bytes = await sample();
  const file = await store.save(bytes, "legacy.png");
  const { element } = repo.importImage({ tags: [] }, { ...file, contentHash: "legacy", width: undefined, height: undefined });
  assert.equal(repo.get(element.id).image.width, null);
  const service = createElementService(repo, store);
  await service.startPreviews(); await service.closePreviews();
  assert.equal(repo.get(element.id).image.width, file.width);
  assert.equal(repo.get(element.id).image.height, file.height);
  assert.deepEqual(await store.read(file.storageKey), bytes);
  assert.equal((await readdir(path.join(dir, "assets", "previews-v1"))).length, 2);
});


test("preview revalidation reuses browser bytes but still enforces trash visibility", async (t) => {
  const { request, upload } = await appFor(t);
  const image = await (await upload(await sample())).json();
  const route = `api/elements/${image.id}/thumbnail?width=400`;
  const initial = await request(route);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "private, no-cache");
  const etag = initial.headers.get("etag"); assert.ok(etag);
  await initial.arrayBuffer();
  const unchanged = await request(route, "GET", undefined, { "if-none-match": etag });
  assert.equal(unchanged.status, 304); assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
  await request(`api/elements/${image.id}`, "DELETE");
  assert.equal((await request(route, "GET", undefined, { "if-none-match": etag })).status, 404);
});
